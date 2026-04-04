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
import {
  AbortError,
  CLIConnectionError,
  CLIJSONDecodeError,
  CLINotFoundError,
  ClaudeSDKError,
  ProcessError,
} from "./errors.ts";

test("ClaudeSDKError sets name from constructor", () => {
  const error = new ClaudeSDKError("test message");
  expect(error.message).toBe("test message");
  expect(error.name).toBe("ClaudeSDKError");
  expect(error).toBeInstanceOf(Error);
});

test("AbortError defaults to 'Aborted'", () => {
  const defaultError = new AbortError();
  expect(defaultError.message).toBe("Aborted");
  expect(defaultError.name).toBe("AbortError");

  const customError = new AbortError("custom");
  expect(customError.message).toBe("custom");
});

test("CLIConnectionError inherits from ClaudeSDKError", () => {
  const error = new CLIConnectionError("connection lost");
  expect(error).toBeInstanceOf(ClaudeSDKError);
  expect(error.name).toBe("CLIConnectionError");
});

test("CLINotFoundError includes cli path when provided", () => {
  const withoutPath = new CLINotFoundError();
  expect(withoutPath.message).toBe("Claude Code not found");

  const withPath = new CLINotFoundError("Claude Code not found", "/usr/bin/claude");
  expect(withPath.message).toBe("Claude Code not found: /usr/bin/claude");
  expect(withPath).toBeInstanceOf(CLIConnectionError);
});

test("ProcessError includes exit code and stderr", () => {
  const minimal = new ProcessError("failed");
  expect(minimal.exitCode).toBeNull();
  expect(minimal.stderr).toBeUndefined();

  const full = new ProcessError("failed", { exitCode: 1, stderr: "segfault" });
  expect(full.message).toBe("failed (exit code: 1)\nError output: segfault");
  expect(full.exitCode).toBe(1);
  expect(full.stderr).toBe("segfault");
  expect(full).toBeInstanceOf(ClaudeSDKError);
});

test("CLIJSONDecodeError truncates long lines and stores original error", () => {
  const longLine = "x".repeat(200);
  const originalError = new SyntaxError("bad json");
  const error = new CLIJSONDecodeError(longLine, originalError);

  expect(error.message).toContain("x".repeat(100));
  expect(error.message.length).toBeLessThan(200);
  expect(error.line).toBe(longLine);
  expect(error.originalError).toBe(originalError);
  expect(error).toBeInstanceOf(ClaudeSDKError);
});
