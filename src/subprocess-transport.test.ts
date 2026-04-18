/*
 * This file incorporates material from claude-agent-sdk-python, licensed under
 * the MIT License:
 *
 * Copyright (c) 2025 Anthropic, PBC
 *
 * Modifications Copyright 2026 StayBlue, licensed under the Apache License,
 * Version 2.0. See the LICENSE file in the project root for details.
 */

import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SubprocessCLITransport } from "./subprocess-transport.ts";
import { CLIConnectionError, CLIJSONDecodeError, ProcessError } from "./errors.ts";
import type { SpawnedProcess } from "./types.ts";

function createMockProcess(
  stdoutData: string[] = [],
  exitCode = 0,
): { process: SpawnedProcess; pushStdout: (data: string) => void; finish: () => void } {
  const emitter = new EventEmitter();
  const stdoutReadable = new Readable({ read() {} });
  const stdinData: string[] = [];
  const stdinWritable = new Writable({
    write(chunk, _encoding, callback) {
      stdinData.push(chunk.toString());
      callback();
    },
  });

  let processExitCode: number | null = null;

  const proc = {
    stdin: stdinWritable,
    stdout: stdoutReadable,
    stderr: new Readable({ read() {} }),
    killed: false,
    get exitCode() {
      return processExitCode;
    },
    kill(_signal?: string) {
      (proc as { killed: boolean }).killed = true;
      return true;
    },
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    off: emitter.off.bind(emitter),
  } as unknown as SpawnedProcess;

  for (const data of stdoutData) {
    stdoutReadable.push(data);
  }

  return {
    process: proc,
    pushStdout(data: string) {
      stdoutReadable.push(data);
    },
    finish() {
      stdoutReadable.push(null);
      processExitCode = exitCode;
      emitter.emit("exit", exitCode, null);
    },
  };
}

function createFakeExecutable(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\nexit 0\n");
  if (process.platform !== "win32") {
    chmodSync(path, 0o755);
  }
}

function getBundledCliPath(): string {
  const cliName = process.platform === "win32" ? "claude.exe" : "claude";
  return join(process.cwd(), "dist", "_bundled", cliName);
}

function stashFile(path: string): () => void {
  const backupPath = `${path}.bak-${process.pid}-${Date.now()}`;
  if (existsSync(path)) {
    renameSync(path, backupPath);
    return () => {
      rmSync(path, { force: true });
      renameSync(backupPath, path);
    };
  }

  return () => {
    rmSync(path, { force: true });
  };
}

test("readMessages yields parsed JSON messages from stdout", async () => {
  const msg1 = JSON.stringify({ type: "user", uuid: "u1" });
  const msg2 = JSON.stringify({ type: "assistant", uuid: "u2" });
  const { process: proc, finish } = createMockProcess([`${msg1}\n${msg2}\n`]);

  const transport = new SubprocessCLITransport({
    spawnClaudeCodeProcess: () => proc,
  });
  await transport.connect();
  finish();

  const messages = [];
  for await (const msg of transport.readMessages()) {
    messages.push(msg);
  }

  expect(messages).toHaveLength(2);
  expect(messages[0]!.type).toBe("user");
  expect(messages[1]!.type).toBe("assistant");
});

test("readMessages throws ProcessError on non-zero exit code", async () => {
  const { process: proc, finish } = createMockProcess([], 1);

  const transport = new SubprocessCLITransport({
    spawnClaudeCodeProcess: () => proc,
  });
  await transport.connect();
  finish();

  const messages = [];
  try {
    for await (const msg of transport.readMessages()) {
      messages.push(msg);
    }
    expect.unreachable("should have thrown");
  } catch (error) {
    expect(error).toBeInstanceOf(ProcessError);
    expect((error as ProcessError).exitCode).toBe(1);
  }
});

test("readMessages throws CLIJSONDecodeError on malformed JSON", async () => {
  const { process: proc, finish } = createMockProcess(["{bad json}\n"]);

  const transport = new SubprocessCLITransport({
    spawnClaudeCodeProcess: () => proc,
  });
  await transport.connect();
  finish();

  try {
    for await (const _msg of transport.readMessages()) {
      // should throw before yielding
    }
    expect.unreachable("should have thrown");
  } catch (error) {
    expect(error).toBeInstanceOf(CLIJSONDecodeError);
  }
});

test("buildSpawnCommand includes model and permission flags", async () => {
  let capturedArgs: string[] = [];

  const { process: proc } = createMockProcess();
  const transport = new SubprocessCLITransport({
    model: "claude-sonnet-4-5-20250514",
    permissionMode: "bypassPermissions",
    maxTurns: 5,
    maxBudgetUsd: 10,
    debug: true,
    spawnClaudeCodeProcess: (opts) => {
      capturedArgs = opts.args;
      return proc;
    },
  });
  await transport.connect();

  expect(capturedArgs).toContain("--model");
  expect(capturedArgs).toContain("claude-sonnet-4-5-20250514");
  expect(capturedArgs).toContain("--permission-mode");
  expect(capturedArgs).toContain("bypassPermissions");
  expect(capturedArgs).toContain("--max-turns");
  expect(capturedArgs).toContain("5");
  expect(capturedArgs).toContain("--max-budget-usd");
  expect(capturedArgs).toContain("10");
  expect(capturedArgs).toContain("--debug");
});

test("connect uses provided env without inheriting process.env", async () => {
  const originalMarker = process.env.CLAUDE_SDK_TEST_INHERIT;
  process.env.CLAUDE_SDK_TEST_INHERIT = "from-process";
  let capturedEnv: Record<string, string | undefined> | undefined;

  try {
    const { process: proc } = createMockProcess();
    const transport = new SubprocessCLITransport({
      pathToClaudeCodeExecutable: "/fake/claude",
      env: { CUSTOM_ENV: "from-options" },
      spawnClaudeCodeProcess: (opts) => {
        capturedEnv = opts.env;
        return proc;
      },
    });
    await transport.connect();

    expect(capturedEnv?.CUSTOM_ENV).toBe("from-options");
    expect(capturedEnv?.CLAUDE_CODE_ENTRYPOINT).toBe("sdk-ts");
    expect(capturedEnv?.CLAUDE_SDK_TEST_INHERIT).toBeUndefined();
  } finally {
    if (originalMarker === undefined) {
      delete process.env.CLAUDE_SDK_TEST_INHERIT;
    } else {
      process.env.CLAUDE_SDK_TEST_INHERIT = originalMarker;
    }
  }
});

test("buildSpawnCommand includes thinking display and session mirror flags", async () => {
  let capturedArgs: string[] = [];

  const { process: proc } = createMockProcess();
  const transport = new SubprocessCLITransport({
    pathToClaudeCodeExecutable: "/fake/claude",
    thinking: { type: "enabled", budgetTokens: 1024, display: "summarized" },
    sessionStore: {
      async append() {},
      async load() {
        return null;
      },
    },
    spawnClaudeCodeProcess: (opts) => {
      capturedArgs = opts.args;
      return proc;
    },
  });
  await transport.connect();

  expect(capturedArgs).toContain("--max-thinking-tokens");
  expect(capturedArgs).toContain("1024");
  expect(capturedArgs).toContain("--thinking-display");
  expect(capturedArgs).toContain("summarized");
  expect(capturedArgs).toContain("--session-mirror");
});

test("findCli prefers bundled CLI over PATH", async () => {
  const root = mkdtempSync(join(tmpdir(), "claude-sdk-test-"));
  const bundledPath = getBundledCliPath();
  const restoreBundled = stashFile(bundledPath);
  const pathCli = join(root, "path-bin", process.platform === "win32" ? "claude.exe" : "claude");
  const originalHome = process.env.HOME;
  const originalPath = process.env.PATH;
  let capturedCommand = "";

  createFakeExecutable(bundledPath);
  createFakeExecutable(pathCli);

  try {
    process.env.HOME = root;
    process.env.PATH = dirname(pathCli);

    const { process: proc } = createMockProcess();
    const transport = new SubprocessCLITransport({
      spawnClaudeCodeProcess: (opts) => {
        capturedCommand = opts.command;
        return proc;
      },
    });

    await transport.connect();
    expect(capturedCommand).toBe(bundledPath);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    restoreBundled();
    rmSync(root, { recursive: true, force: true });
  }
});

test("findCli prefers PATH over fallback locations", async () => {
  const root = mkdtempSync(join(tmpdir(), "claude-sdk-test-"));
  const bundledPath = getBundledCliPath();
  const restoreBundled = stashFile(bundledPath);
  const pathCli = join(root, "path-bin", process.platform === "win32" ? "claude.exe" : "claude");
  const fallbackCli = join(root, ".local", "bin", "claude");
  const originalHome = process.env.HOME;
  const originalPath = process.env.PATH;
  let capturedCommand = "";

  createFakeExecutable(pathCli);
  createFakeExecutable(fallbackCli);

  try {
    process.env.HOME = root;
    process.env.PATH = dirname(pathCli);

    const { process: proc } = createMockProcess();
    const transport = new SubprocessCLITransport({
      spawnClaudeCodeProcess: (opts) => {
        capturedCommand = opts.command;
        return proc;
      },
    });

    await transport.connect();
    expect(capturedCommand).toBe(pathCli);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    restoreBundled();
    rmSync(root, { recursive: true, force: true });
  }
});

test("readMessages throws CLIJSONDecodeError on buffer overflow", async () => {
  const hugeChunk = "x".repeat(1024 * 1024 + 1); // Exceeds 1MB buffer
  const { process: proc, pushStdout, finish } = createMockProcess();

  const transport = new SubprocessCLITransport({
    spawnClaudeCodeProcess: () => proc,
  });
  await transport.connect();
  pushStdout(hugeChunk);
  finish();

  try {
    for await (const _msg of transport.readMessages()) {
      // should throw
    }
    expect.unreachable("should have thrown");
  } catch (error) {
    expect(error).toBeInstanceOf(CLIJSONDecodeError);
    expect((error as CLIJSONDecodeError).message).toContain("buffer overflow");
  }
});

test("write throws CLIConnectionError when not ready", async () => {
  const transport = new SubprocessCLITransport({
    spawnClaudeCodeProcess: () => createMockProcess().process,
  });

  // Don't call connect() — transport is not ready
  await expect(transport.write("test\n")).rejects.toThrow(CLIConnectionError);
});

test("close kills the process", async () => {
  const { process: proc } = createMockProcess();

  const transport = new SubprocessCLITransport({
    spawnClaudeCodeProcess: () => proc,
  });
  await transport.connect();
  transport.close();

  expect(proc.killed).toBe(true);
  expect(transport.isReady()).toBe(false);
});

test("buildSpawnCommand merges sandbox into JSON settings", async () => {
  let capturedArgs: string[] = [];

  const { process: proc } = createMockProcess();
  const transport = new SubprocessCLITransport({
    settings: { theme: "dark" },
    sandbox: { enabled: true },
    spawnClaudeCodeProcess: (opts) => {
      capturedArgs = opts.args;
      return proc;
    },
  });
  await transport.connect();

  const settingsIndex = capturedArgs.indexOf("--settings");
  expect(settingsIndex).toBeGreaterThanOrEqual(0);
  const settingsValue = capturedArgs[settingsIndex + 1];
  expect(JSON.parse(settingsValue!)).toEqual({
    theme: "dark",
    sandbox: { enabled: true },
  });
});

test("buildSpawnCommand rejects invalid settings JSON when used with sandbox", async () => {
  const { process: proc } = createMockProcess();
  const transport = new SubprocessCLITransport({
    settings: '{"broken": }',
    sandbox: { enabled: true },
    spawnClaudeCodeProcess: () => proc,
  });

  await expect(transport.connect()).rejects.toThrow(
    "Failed to parse settings JSON when used with sandbox",
  );
});

test("buildSpawnCommand rejects settings file paths when used with sandbox", async () => {
  const { process: proc } = createMockProcess();
  const transport = new SubprocessCLITransport({
    settings: "/tmp/settings.json",
    sandbox: { enabled: true },
    spawnClaudeCodeProcess: () => proc,
  });

  await expect(transport.connect()).rejects.toThrow(
    "Cannot use both a settings file path and the sandbox option",
  );
});

test("buildSpawnCommand rejects non-object-looking settings string when used with sandbox", async () => {
  const { process: proc } = createMockProcess();
  const transport = new SubprocessCLITransport({
    settings: "[]",
    sandbox: { enabled: true },
    spawnClaudeCodeProcess: () => proc,
  });

  await expect(transport.connect()).rejects.toThrow(
    "Cannot use both a settings file path and the sandbox option",
  );
});
