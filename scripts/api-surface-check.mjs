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

const WORKSPACE_ROOT = process.cwd();

function joinPath(...parts) {
  return parts
    .filter((part) => part.length > 0)
    .join("/")
    .replace(/\\+/g, "/")
    .replace(/\/+/g, "/");
}

const LOCAL_DECL_FILES = (process.env.API_SURFACE_LOCAL_DECLS ?? "dist/src/index.d.ts")
  .split(",")
  .map((file) => file.trim())
  .filter(Boolean);
const REFERENCE_PACKAGE = process.env.API_SURFACE_PACKAGE ?? "@anthropic-ai/claude-agent-sdk";
const REFERENCE_VERSION = process.env.API_SURFACE_VERSION ?? "0.2.92";
const REFERENCE_DECL_FILES = (
  process.env.API_SURFACE_REFERENCE_DECLS ?? "sdk.d.ts,dist/sdk.d.ts,agentSdkTypes.d.ts"
)
  .split(",")
  .map((file) => file.trim())
  .filter(Boolean);
const BADGE_PATH = process.env.API_SURFACE_BADGE_PATH;
const BADGE_LABEL = process.env.API_SURFACE_BADGE_LABEL ?? "api surface";
const GIST_ID = process.env.API_SURFACE_GIST_ID;
const GIST_TOKEN = process.env.API_SURFACE_GIST_TOKEN;
const GIST_FILE_NAME = process.env.API_SURFACE_GIST_FILE_NAME ?? "api-surface-badge.json";

function badgeColor(coverage) {
  if (coverage >= 95) return "brightgreen";
  if (coverage >= 85) return "green";
  if (coverage >= 70) return "yellow";
  return "red";
}

function collectExportedMembers(sourceText) {
  const sourceFile = ts.createSourceFile(
    "surface.d.ts",
    sourceText,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );

  const symbolMembers = new Map();

  const getModifiers = (node) => {
    if (!ts.canHaveModifiers(node)) return [];
    return ts.getModifiers(node) ?? [];
  };

  const extractMembers = (members) => {
    const names = [];
    for (const member of members) {
      if (
        (ts.isPropertySignature(member) || ts.isMethodSignature(member)) &&
        member.name &&
        ts.isIdentifier(member.name)
      ) {
        names.push(member.name.text);
      }
    }
    return names.sort();
  };

  for (const statement of sourceFile.statements) {
    const modifiers = getModifiers(statement);
    const hasExport = modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!hasExport) continue;

    if (ts.isInterfaceDeclaration(statement) && statement.name) {
      symbolMembers.set(statement.name.text, extractMembers(statement.members));
      continue;
    }

    if (
      ts.isTypeAliasDeclaration(statement) &&
      statement.name &&
      statement.type &&
      ts.isTypeLiteralNode(statement.type)
    ) {
      symbolMembers.set(statement.name.text, extractMembers(statement.type.members));
      continue;
    }
  }

  return symbolMembers;
}

function resolveReExportSources(sourceText, sourceFilePath) {
  const sourceFile = ts.createSourceFile(
    "surface.d.ts",
    sourceText,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  const dir = sourceFilePath.replace(/\/[^/]+$/, "");
  const sources = new Set();

  for (const statement of sourceFile.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const specifier = statement.moduleSpecifier.text;
      if (specifier.startsWith(".")) {
        const resolved = joinPath(dir, specifier);
        sources.add(resolved);
        sources.add(resolved.replace(/\.ts$/, ".d.ts"));
        if (!resolved.endsWith(".ts")) sources.add(resolved + ".d.ts");
      }
    }
  }

  return [...sources];
}

async function collectMembersFromDeclarationFiles(filePaths) {
  const merged = new Map();
  const visited = new Set();

  const processFile = async (filePath) => {
    if (visited.has(filePath)) return;
    visited.add(filePath);

    if (!(await Bun.file(filePath).exists())) return;

    const text = await readDeclText(filePath);

    for (const [symbol, members] of collectExportedMembers(text)) {
      merged.set(symbol, members);
    }

    for (const source of resolveReExportSources(text, filePath)) {
      await processFile(source);
    }
  };

  for (const filePath of filePaths) {
    await processFile(filePath);
  }
  return merged;
}

function checkMemberCoverage(referenceMembers, localMembers) {
  const results = [];

  for (const [symbol, refMembers] of referenceMembers) {
    const localMems = localMembers.get(symbol);
    if (!localMems) continue;

    const localSet = new Set(localMems);
    const refSet = new Set(refMembers);
    const missing = refMembers.filter((m) => !localSet.has(m));
    const extra = localMems.filter((m) => !refSet.has(m));

    if (missing.length || extra.length) {
      results.push({
        symbol,
        missing,
        extra,
        refCount: refMembers.length,
        localCount: localMems.length,
      });
    }
  }

  return results;
}

function collectExportedNames(sourceText) {
  const sourceFile = ts.createSourceFile(
    "surface.d.ts",
    sourceText,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  const names = new Set();

  const addBindingName = (nameNode) => {
    if (ts.isIdentifier(nameNode)) {
      names.add(nameNode.text);
      return;
    }

    if (ts.isObjectBindingPattern(nameNode) || ts.isArrayBindingPattern(nameNode)) {
      for (const element of nameNode.elements) {
        if (ts.isBindingElement(element) && element.name) {
          addBindingName(element.name);
        }
      }
    }
  };

  const getModifiers = (node) => {
    if (!ts.canHaveModifiers(node)) return [];
    return ts.getModifiers(node) ?? [];
  };

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          names.add(element.name.text);
        }
      } else if (statement.exportClause && ts.isNamespaceExport(statement.exportClause)) {
        names.add(statement.exportClause.name.text);
      }
      continue;
    }

    const modifiers = getModifiers(statement);
    const hasExport = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
    if (!hasExport || isDefault) continue;

    if (
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isModuleDeclaration(statement)
    ) {
      if (statement.name) addBindingName(statement.name);
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.name) addBindingName(declaration.name);
      }
      continue;
    }
  }

  return [...names];
}

async function readDeclText(filePath) {
  return await Bun.file(filePath).text();
}

async function collectFromDeclarationFiles(filePaths) {
  const allNames = new Set();
  for (const filePath of filePaths) {
    const text = await readDeclText(filePath);
    for (const name of collectExportedNames(text)) {
      allNames.add(name);
    }
  }
  return [...allNames].sort();
}

async function ensureFilesExist(files) {
  const missing = [];
  for (const filePath of files) {
    if (!(await Bun.file(filePath).exists())) {
      missing.push(filePath);
    }
  }
  if (missing.length) {
    throw new Error(`Missing declaration file(s): ${missing.join(", ")}`);
  }
}

function packageDir() {
  const segments = REFERENCE_PACKAGE.split("/");
  return joinPath(WORKSPACE_ROOT, "node_modules", ...segments);
}

async function resolveReferenceDeclPath(basePath) {
  for (const relative of REFERENCE_DECL_FILES) {
    const candidate = joinPath(basePath, relative);
    if (await Bun.file(candidate).exists()) return candidate;
  }
  return null;
}

async function writeBadgeFile(coverage) {
  if (!BADGE_PATH) return;

  const payload = {
    schemaVersion: 1,
    label: BADGE_LABEL,
    message: `${coverage.toFixed(2)}%`,
    color: badgeColor(coverage),
  };

  await Bun.write(BADGE_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`Wrote badge data to ${BADGE_PATH}`);
}

async function updateGist(coverage) {
  if (!GIST_ID) return;
  if (!GIST_TOKEN) {
    console.log("Skipping gist update: missing API_SURFACE_GIST_TOKEN environment variable.");
    return;
  }

  const payload = {
    files: {
      [GIST_FILE_NAME]: {
        content: JSON.stringify(
          {
            schemaVersion: 1,
            label: BADGE_LABEL,
            message: `${coverage.toFixed(2)}%`,
            color: badgeColor(coverage),
          },
          null,
          2,
        ),
      },
    },
  };

  const response = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method: "PATCH",
    headers: {
      Authorization: `token ${GIST_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
      "User-Agent": "api-surface-check",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to update gist ${GIST_ID}: ${response.status} ${response.statusText} ${body}`,
    );
  }

  const result = await response.json();
  const location = result.files?.[GIST_FILE_NAME]?.raw_url ?? result.url;
  console.log(`Updated gist badge: ${location}`);
}

function checkTypeCompatibility(localFiles, referenceFile, symbolNames) {
  const localImports = symbolNames.map((n) => `${n} as local_${n}`).join(", ");
  const refImports = symbolNames.map((n) => `${n} as ref_${n}`).join(", ");

  const bridgeSource = [
    ...symbolNames.map(
      (n) => `declare const __local_${n}: typeof import("./local_surface").local_${n};`,
    ),
    ...symbolNames.map((n) => `declare const __ref_${n}: typeof import("./ref_surface").ref_${n};`),
    ...symbolNames.map((n) => `const __check_${n}: typeof __ref_${n} = __local_${n};`),
  ].join("\n");

  const localSurfaceSource = localFiles
    .map((f) => {
      const relPath = f.replace(/\.d\.ts$/, "").replace(/\.ts$/, "");
      return `export { ${localImports} } from "./${relPath}";`;
    })
    .join("\n");

  const refRelPath = referenceFile.replace(/\.d\.ts$/, "").replace(/\.ts$/, "");
  const refSurfaceSource = `export { ${refImports} } from "./${refRelPath}";`;

  const compilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    baseUrl: WORKSPACE_ROOT,
  };

  const virtualFiles = new Map([
    [joinPath(WORKSPACE_ROOT, "__bridge.ts"), bridgeSource],
    [joinPath(WORKSPACE_ROOT, "local_surface.d.ts"), localSurfaceSource],
    [joinPath(WORKSPACE_ROOT, "ref_surface.d.ts"), refSurfaceSource],
  ]);

  const host = ts.createCompilerHost(compilerOptions);
  const originalReadFile = host.readFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);

  host.readFile = (fileName) => {
    const normalized = fileName.replace(/\\/g, "/");
    if (virtualFiles.has(normalized)) return virtualFiles.get(normalized);
    return originalReadFile(fileName);
  };

  host.fileExists = (fileName) => {
    const normalized = fileName.replace(/\\/g, "/");
    if (virtualFiles.has(normalized)) return true;
    return originalFileExists(fileName);
  };

  const program = ts.createProgram(
    [joinPath(WORKSPACE_ROOT, "__bridge.ts")],
    compilerOptions,
    host,
  );

  const diagnostics = ts.getPreEmitDiagnostics(program);

  const mismatches = [];
  const seen = new Set();

  for (const diag of diagnostics) {
    const text = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
    if (diag.file?.fileName?.endsWith("__bridge.ts")) {
      const lineText = diag.file.text.substring(
        diag.file.getLineAndCharacterOfPosition(diag.start).line === 0
          ? 0
          : diag.file.getLineStarts()[diag.file.getLineAndCharacterOfPosition(diag.start).line],
        diag.file.text.indexOf("\n", diag.start),
      );
      const match = lineText.match(/__check_(\w+)/);
      if (match && !seen.has(match[1])) {
        seen.add(match[1]);
        mismatches.push({ name: match[1], reason: text });
      }
    }
  }

  return mismatches;
}

async function main() {
  await ensureFilesExist(LOCAL_DECL_FILES);

  const localExports = await collectFromDeclarationFiles(LOCAL_DECL_FILES);
  const localSet = new Set(localExports);

  const referenceBase = packageDir();
  const referencePackagePath = joinPath(referenceBase, "package.json");
  if (!(await Bun.file(referencePackagePath).exists())) {
    throw new Error(
      `Reference package not installed: ${REFERENCE_PACKAGE}. ` +
        `Run: bun add --no-save ${REFERENCE_PACKAGE}@${REFERENCE_VERSION}`,
    );
  }

  const referencePackageJson = await Bun.file(referencePackagePath).json();
  if (referencePackageJson.version && referencePackageJson.version !== REFERENCE_VERSION) {
    console.warn(
      `Expected ${REFERENCE_PACKAGE}@${REFERENCE_VERSION}, but installed ${REFERENCE_PACKAGE}@${referencePackageJson.version}. ` +
        "Set API_SURFACE_VERSION to match the installed package.",
    );
  }

  const referenceDeclPath = await resolveReferenceDeclPath(referenceBase);
  if (!referenceDeclPath) {
    throw new Error(
      `Could not find reference declaration file in ${referenceBase} from: ${REFERENCE_DECL_FILES.join(", ")}`,
    );
  }

  const referenceExports = await collectFromDeclarationFiles([referenceDeclPath]);
  const referenceSet = new Set(referenceExports);

  const missing = [...referenceSet].filter((name) => !localSet.has(name)).sort();
  const extra = [...localSet].filter((name) => !referenceSet.has(name)).sort();
  const matched = [...referenceSet].filter((name) => localSet.has(name)).sort();

  const mismatches = checkTypeCompatibility(LOCAL_DECL_FILES, referenceDeclPath, matched);

  const referenceMembers = await collectMembersFromDeclarationFiles([referenceDeclPath]);
  const localMembers = await collectMembersFromDeclarationFiles(
    LOCAL_DECL_FILES.map((f) => joinPath(WORKSPACE_ROOT, f)),
  );
  const memberDiffs = checkMemberCoverage(referenceMembers, localMembers);

  let totalRefMembers = 0;
  let totalMissingMembers = 0;
  for (const [, members] of referenceMembers) {
    totalRefMembers += members.length;
  }
  for (const diff of memberDiffs) {
    totalMissingMembers += diff.missing.length;
  }
  const memberCoverage = totalRefMembers
    ? ((totalRefMembers - totalMissingMembers) / totalRefMembers) * 100
    : 100;

  const compatible = matched.length - mismatches.length;
  const implemented = compatible;
  const coverage = referenceSet.size ? (implemented / referenceSet.size) * 100 : 100;

  console.log(`Reference package: ${REFERENCE_PACKAGE}@${REFERENCE_VERSION}`);
  console.log(`Reference declarations: ${referenceDeclPath}`);
  console.log(`Reference exported symbols: ${referenceSet.size}`);
  console.log(`Local exported symbols: ${localSet.size}`);
  console.log(`Name-matched symbols: ${matched.length}`);
  console.log(`Type-compatible symbols: ${compatible}`);
  console.log(`Type mismatches: ${mismatches.length}`);
  console.log(`Missing symbols: ${missing.length}`);
  console.log(`Extra symbols: ${extra.length}`);
  console.log(`Coverage: ${coverage.toFixed(2)}%`);
  if (mismatches.length) {
    console.log(`\nType mismatches:`);
    for (const m of mismatches) {
      console.log(`  ${m.name}: ${m.reason}`);
    }
  }
  if (missing.length) console.log(`\nMissing: ${missing.join(", ")}`);
  if (extra.length) console.log(`Extra: ${extra.join(", ")}`);

  console.log(
    `\nMember coverage: ${memberCoverage.toFixed(2)}% (${totalRefMembers - totalMissingMembers}/${totalRefMembers} members)`,
  );
  if (memberDiffs.length) {
    console.log(`Symbols with member differences: ${memberDiffs.length}`);
    for (const diff of memberDiffs) {
      if (diff.missing.length) {
        console.log(`  ${diff.symbol}: missing ${diff.missing.join(", ")}`);
      }
      if (diff.extra.length) {
        console.log(`  ${diff.symbol}: extra ${diff.extra.join(", ")}`);
      }
    }
  }

  const totalItems = referenceSet.size + totalRefMembers;
  const totalCovered = implemented + (totalRefMembers - totalMissingMembers);
  const combinedCoverage = totalItems ? (totalCovered / totalItems) * 100 : 100;
  await writeBadgeFile(combinedCoverage);
  await updateGist(combinedCoverage);
}

await main();
