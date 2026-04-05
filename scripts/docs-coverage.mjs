#!/usr/bin/env bun
/*
 * Copyright 2026 StayBlue
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import ts from "typescript";

const workspaceRoot = process.cwd();
const jsrConfigPath = ts.sys.resolvePath(ts.combinePaths(workspaceRoot, "jsr.json"));
const configPath = ts.findConfigFile(workspaceRoot, ts.sys.fileExists, "tsconfig.json");

if (!configPath) {
  throw new Error("Could not find tsconfig.json");
}

const jsrConfigText = ts.sys.readFile(jsrConfigPath);
if (!jsrConfigText) {
  throw new Error("Could not read jsr.json");
}

const jsrConfig = JSON.parse(jsrConfigText);
const exportsField = jsrConfig.exports;
if (!exportsField || typeof exportsField !== "object") {
  throw new Error("jsr.json does not define an exports map");
}

const rootNames = [
  ...new Set(Object.values(exportsField).map((value) => ts.sys.resolvePath(value))),
];

const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error) {
  throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
}

const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, workspaceRoot);
const program = ts.createProgram({
  rootNames: [...new Set([...parsedConfig.fileNames, ...rootNames])],
  options: parsedConfig.options,
});
const checker = program.getTypeChecker();

const undocumented = [];
const documented = [];
const seen = new Set();

function getSymbolKey(exportName, symbol) {
  const declarations = symbol.declarations ?? [];
  const firstDecl = declarations[0];
  const declPath = firstDecl?.getSourceFile().fileName ?? "unknown";
  return `${exportName}:${declPath}`;
}

function hasMeaningfulDocs(symbol) {
  const target = ts.SymbolFlags.Alias & symbol.flags ? checker.getAliasedSymbol(symbol) : symbol;
  const docs = ts.displayPartsToString(target.getDocumentationComment(checker)).trim();
  if (docs.length > 0) {
    return true;
  }

  const jsDocTags = target.getJsDocTags();
  return jsDocTags.some((tag) => tag.name !== "deprecated");
}

for (const rootName of rootNames) {
  const sourceFile = program.getSourceFile(rootName);
  if (!sourceFile) {
    throw new Error(`Could not load entrypoint: ${rootName}`);
  }

  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) {
    throw new Error(`Could not resolve module symbol for: ${rootName}`);
  }

  for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
    const exportName = symbol.getName();
    if (exportName === "default") {
      continue;
    }

    const key = getSymbolKey(
      exportName,
      ts.SymbolFlags.Alias & symbol.flags ? checker.getAliasedSymbol(symbol) : symbol,
    );
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const record = {
      exportName,
      source: sourceFile.fileName.replace(`${workspaceRoot}/`, ""),
    };

    if (hasMeaningfulDocs(symbol)) {
      documented.push(record);
    } else {
      undocumented.push(record);
    }
  }
}

const total = documented.length + undocumented.length;
const coverage = total === 0 ? 100 : (documented.length / total) * 100;
const failBelowIndex = process.argv.indexOf("--fail-below");

console.log(`Documentation coverage: ${documented.length}/${total} (${coverage.toFixed(2)}%)`);

if (undocumented.length > 0) {
  console.log("");
  console.log("Undocumented exports:");
  for (const entry of undocumented.sort((a, b) => a.exportName.localeCompare(b.exportName))) {
    console.log(`- ${entry.exportName} (${entry.source})`);
  }
}

if (failBelowIndex !== -1) {
  const thresholdRaw = process.argv[failBelowIndex + 1];
  const threshold = Number(thresholdRaw);
  if (!Number.isFinite(threshold)) {
    throw new Error(`Invalid --fail-below threshold: ${thresholdRaw ?? "<missing>"}`);
  }
  if (coverage < threshold) {
    process.exitCode = 1;
  }
}
