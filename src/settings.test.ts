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

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterEscalatingDefaultMode, resolveSettings } from "./settings.ts";

const tempRoots: string[] = [];
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }

  if (originalClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  }
});

test("resolveSettings merges user, project, local, and managed sources with provenance", async () => {
  const root = mkdtempSync(join(tmpdir(), "coding-sdk-settings-"));
  tempRoots.push(root);

  const userDir = join(root, "user");
  const projectDir = join(root, "project");
  mkdirSync(join(projectDir, ".claude"), { recursive: true });
  mkdirSync(userDir, { recursive: true });

  process.env.CLAUDE_CONFIG_DIR = userDir;
  writeFileSync(
    join(userDir, "settings.json"),
    JSON.stringify({
      env: { FROM_USER: "1" },
      permissions: { allow: ["Read"], defaultMode: "default" },
    }),
  );
  writeFileSync(
    join(projectDir, ".claude", "settings.json"),
    JSON.stringify({
      model: "project-model",
      permissions: { allow: ["Bash"], defaultMode: "auto" },
    }),
  );
  writeFileSync(
    join(projectDir, ".claude", "settings.local.json"),
    `{
      // JSONC is accepted by Claude Code settings files.
      "model": "local-model",
      "permissions": { "ask": ["Edit"], },
    }`,
  );

  const resolved = await resolveSettings({
    cwd: projectDir,
    managedSettings: {
      model: "managed-model",
      permissions: { deny: ["WebFetch"] },
      sandbox: {
        enabled: true,
        network: {
          deniedDomains: ["blocked.example"],
        },
      },
    },
  });

  expect(resolved.sources.map((source) => source.source)).toEqual([
    "user",
    "project",
    "local",
    "managed",
  ]);
  expect(resolved.provenance.model?.source).toBe("local");
  expect(resolved.provenance.sandbox?.source).toBe("managed");
  expect(resolved.sources.at(-1)?.policyOrigin).toBe("parent");
  expect(resolved.effective).toMatchObject({
    env: { FROM_USER: "1" },
    model: "local-model",
    sandbox: {
      enabled: true,
      network: {
        deniedDomains: ["blocked.example"],
      },
    },
  });
  expect((resolved.effective.permissions as { allow?: string[] }).allow).toEqual(["Read", "Bash"]);
  expect((resolved.effective.permissions as { ask?: string[] }).ask).toEqual(["Edit"]);
  expect((resolved.effective.permissions as { deny?: string[] }).deny).toEqual(["WebFetch"]);
  expect(filterEscalatingDefaultMode(resolved).permissions).toEqual({
    allow: ["Read", "Bash"],
    ask: ["Edit"],
    deny: ["WebFetch"],
  });
});

test("filterEscalatingDefaultMode preserves non-project default modes", () => {
  const resolved = {
    effective: {
      permissions: {
        defaultMode: "auto",
      },
    },
    provenance: {},
    sources: [
      {
        source: "managed" as const,
        settings: {
          permissions: {
            defaultMode: "auto",
          },
        },
      },
    ],
  };

  expect(filterEscalatingDefaultMode(resolved)).toBe(resolved.effective);
});
