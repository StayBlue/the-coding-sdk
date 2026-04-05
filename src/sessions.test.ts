/*
 * This file incorporates material from claude-agent-sdk-python, licensed under
 * the MIT License:
 *
 * Copyright (c) 2025 Anthropic, PBC
 *
 * Modifications Copyright 2026 StayBlue, licensed under the Apache License,
 * Version 2.0. See the LICENSE file in the project root for details.
 */

import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  deleteSession,
  forkSession,
  getSessionInfo,
  getSessionMessages,
  getSubagentMessages,
  listSessions,
  listSubagents,
  unstable_v2_createSession,
  unstable_v2_prompt,
  unstable_v2_resumeSession,
  renameSession,
  tagSession,
} from "./sessions.ts";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
  delete process.env.CLAUDE_CONFIG_DIR;
});

test("session helpers list, read, mutate, and fork sessions", async () => {
  const root = await Bun.$`mktemp -d ${join(tmpdir(), "claude-sdk-test-XXXXXX")}`.text();
  const claudeRoot = root.trim();
  tempRoots.push(claudeRoot);
  process.env.CLAUDE_CONFIG_DIR = claudeRoot;

  const projectPath = "/tmp/example-project";
  const projectDir = join(claudeRoot, "projects", sanitizePath(projectPath));
  mkdirSync(projectDir, { recursive: true });

  const sessionId = "550e8400-e29b-41d4-a716-446655440000";
  const sessionFile = join(projectDir, `${sessionId}.jsonl`);

  writeFileSync(
    sessionFile,
    [
      JSON.stringify({
        type: "user",
        uuid: "00000000-0000-4000-8000-000000000001",
        sessionId,
        message: {
          role: "user",
          content: "hello there",
        },
        timestamp: "2026-04-03T00:00:00.000Z",
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "00000000-0000-4000-8000-000000000002",
        parentUuid: "00000000-0000-4000-8000-000000000001",
        sessionId,
        message: {
          role: "assistant",
          content: "general kenobi",
        },
      }),
      JSON.stringify({
        type: "custom-title",
        sessionId,
        customTitle: "Greeting thread",
      }),
      JSON.stringify({
        type: "tag",
        sessionId,
        tag: "demo",
      }),
      "",
    ].join("\n"),
    "utf8",
  );

  const sessions = await listSessions({ dir: projectPath });
  expect(sessions).toHaveLength(1);
  expect(sessions[0]).toEqual(
    expect.objectContaining({
      sessionId,
      summary: "Greeting thread",
      tag: "demo",
      firstPrompt: "hello there",
    }),
  );

  const messages = await getSessionMessages(sessionId, { dir: projectPath });
  expect(messages.map((message) => message.type)).toEqual(["user", "assistant"]);

  await renameSession(sessionId, "Renamed", { dir: projectPath });
  await tagSession(sessionId, "updated", { dir: projectPath });

  const renamed = await getSessionInfo(sessionId, { dir: projectPath });
  expect(renamed).toEqual(
    expect.objectContaining({
      summary: "Renamed",
      tag: "updated",
    }),
  );

  const forked = await forkSession(sessionId, { dir: projectPath });
  expect(forked.sessionId).not.toBe(sessionId);

  const allSessions = await listSessions({ dir: projectPath });
  expect(allSessions).toHaveLength(2);

  await deleteSession(sessionId, { dir: projectPath });
  expect(await getSessionInfo(sessionId, { dir: projectPath })).toBeUndefined();
});

test("getSessionMessages returns empty array for unknown session", async () => {
  const root = await Bun.$`mktemp -d ${join(tmpdir(), "claude-sdk-test-XXXXXX")}`.text();
  const claudeRoot = root.trim();
  tempRoots.push(claudeRoot);
  process.env.CLAUDE_CONFIG_DIR = claudeRoot;

  const messages = await getSessionMessages("550e8400-e29b-41d4-a716-446655440099", {
    dir: "/tmp/nonexistent-project",
  });
  expect(messages).toEqual([]);
});

test("listSessions returns empty array for nonexistent directory", async () => {
  const root = await Bun.$`mktemp -d ${join(tmpdir(), "claude-sdk-test-XXXXXX")}`.text();
  const claudeRoot = root.trim();
  tempRoots.push(claudeRoot);
  process.env.CLAUDE_CONFIG_DIR = claudeRoot;

  const sessions = await listSessions({ dir: "/tmp/no-such-project-dir" });
  expect(sessions).toEqual([]);
});

test("session parsing skips malformed JSONL lines", async () => {
  const root = await Bun.$`mktemp -d ${join(tmpdir(), "claude-sdk-test-XXXXXX")}`.text();
  const claudeRoot = root.trim();
  tempRoots.push(claudeRoot);
  process.env.CLAUDE_CONFIG_DIR = claudeRoot;

  const projectPath = "/tmp/malformed-project";
  const projectDir = join(claudeRoot, "projects", sanitizePath(projectPath));
  mkdirSync(projectDir, { recursive: true });

  const sessionId = "550e8400-e29b-41d4-a716-446655440001";
  const sessionFile = join(projectDir, `${sessionId}.jsonl`);

  writeFileSync(
    sessionFile,
    [
      "this is not valid json",
      JSON.stringify({
        type: "user",
        uuid: "00000000-0000-4000-8000-000000000010",
        sessionId,
        message: { role: "user", content: "valid entry" },
        timestamp: "2026-04-03T00:00:00.000Z",
      }),
      '{"missing_uuid": true}',
      "",
    ].join("\n"),
    "utf8",
  );

  const messages = await getSessionMessages(sessionId, { dir: projectPath });
  expect(messages).toHaveLength(1);
  expect(messages[0]!.type).toBe("user");
});

test("listSubagents and getSubagentMessages work with subagent transcripts", async () => {
  const root = await Bun.$`mktemp -d ${join(tmpdir(), "claude-sdk-test-XXXXXX")}`.text();
  const claudeRoot = root.trim();
  tempRoots.push(claudeRoot);
  process.env.CLAUDE_CONFIG_DIR = claudeRoot;

  const projectPath = "/tmp/subagent-project";
  const projectDir = join(claudeRoot, "projects", sanitizePath(projectPath));

  const sessionId = "550e8400-e29b-41d4-a716-446655440002";
  const sessionFile = join(projectDir, `${sessionId}.jsonl`);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: "user",
      uuid: "00000000-0000-4000-8000-000000000020",
      sessionId,
      message: { role: "user", content: "test" },
      timestamp: "2026-04-03T00:00:00.000Z",
    }) + "\n",
    "utf8",
  );

  const subagentsDir = join(projectDir, sessionId, "subagents");
  mkdirSync(subagentsDir, { recursive: true });
  writeFileSync(
    join(subagentsDir, "agent-abc123.jsonl"),
    JSON.stringify({
      type: "user",
      uuid: "00000000-0000-4000-8000-000000000030",
      sessionId,
      message: { role: "user", content: "subagent prompt" },
    }) + "\n",
    "utf8",
  );

  const agents = await listSubagents(sessionId, { dir: projectPath });
  expect(agents).toEqual(["abc123"]);

  const messages = await getSubagentMessages(sessionId, "abc123", { dir: projectPath });
  expect(messages).toHaveLength(1);
  expect(messages[0]!.type).toBe("user");

  const noAgents = await listSubagents(sessionId, { dir: "/tmp/nonexistent" });
  expect(noAgents).toEqual([]);
});

test("unstable_v2_prompt returns a result with session id from transport", async () => {
  const root = await Bun.$`mktemp -d ${join(tmpdir(), "claude-sdk-test-unstable-XXXXXX")}`.text();
  const claudeRoot = root.trim();
  tempRoots.push(claudeRoot);
  const executable = createFakeClaudeExecutable(claudeRoot);

  const result = await unstable_v2_prompt("Please reply with OK", {
    model: "dummy",
    pathToClaudeCodeExecutable: executable,
  });

  expect(result).toEqual(
    expect.objectContaining({
      type: "result",
      session_id: "fake-session-id",
    }),
  );
});

test("unstable_v2_session APIs stream all messages and support resume session id", async () => {
  const root = await Bun.$`mktemp -d ${join(tmpdir(), "claude-sdk-test-unstable-XXXXXX")}`.text();
  const claudeRoot = root.trim();
  tempRoots.push(claudeRoot);
  const executable = createFakeClaudeExecutable(claudeRoot);

  const created = unstable_v2_createSession({
    model: "dummy",
    pathToClaudeCodeExecutable: executable,
  });

  expect(() => created.sessionId).toThrow("Session has not been initialized yet");

  const eventTypes: string[] = [];

  await created.send("Hello");
  for await (const message of created.stream()) {
    eventTypes.push(message.type);
  }

  expect(eventTypes).toEqual(["system", "assistant", "result"]);
  expect(created.sessionId).toBe("fake-session-id");

  const resumed = unstable_v2_resumeSession("resume-session-id", {
    model: "dummy",
    pathToClaudeCodeExecutable: executable,
  });

  expect(resumed.sessionId).toBe("resume-session-id");
  const resumedEventTypes: string[] = [];

  await resumed.send({
    type: "user",
    message: { role: "user", content: "Hi" },
    parent_tool_use_id: null,
  });
  for await (const message of resumed.stream()) {
    resumedEventTypes.push(message.type);
  }

  expect(resumedEventTypes).toEqual(["system", "assistant", "result"]);
});

function sanitizePath(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "-");
}

function createFakeClaudeExecutable(claudeRoot: string): string {
  const executable = join(claudeRoot, "fake-claude.js");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
"use strict";

const readline = require("node:readline");

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  if (!line || !line.trim()) {
    return;
  }

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.type === "control_request" && message.request?.subtype === "initialize") {
    process.stdout.write(
      JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: message.request_id,
          response: {
            commands: [],
            agents: [],
            output_style: "default",
            available_output_styles: [],
            models: [],
            account: {},
          },
        },
      }) + "\\n",
    );
    return;
  }

  if (message.type === "user") {
    const sessionId = message.session_id ? message.session_id : "fake-session-id";
    process.stdout.write(
      JSON.stringify({
        type: "system",
        uuid: "sys-1",
        session_id: sessionId,
        message: {
          role: "system",
          content: [{ type: "text", text: "start" }],
        },
      }) + "\\n",
    );
    process.stdout.write(
      JSON.stringify({
        type: "assistant",
        uuid: "assistant-1",
        session_id: sessionId,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "OK" }],
        },
      }) + "\\n",
    );
    process.stdout.write(
      JSON.stringify({
        type: "result",
        uuid: "result-1",
        session_id: sessionId,
      }) + "\\n",
    );
    process.exit(0);
  }
});
`,
    "utf8",
  );

  chmodSync(executable, 0o755);
  return executable;
}
