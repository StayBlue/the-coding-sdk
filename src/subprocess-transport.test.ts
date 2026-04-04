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
