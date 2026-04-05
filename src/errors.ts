/*
 * This file incorporates material from claude-agent-sdk-python, licensed under
 * the MIT License:
 *
 * Copyright (c) 2025 Anthropic, PBC
 *
 * Modifications Copyright 2026 StayBlue, licensed under the Apache License,
 * Version 2.0. See the LICENSE file in the project root for details.
 */

export class ClaudeSDKError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Error thrown when an operation is aborted before completion. */
export class AbortError extends Error {
  constructor(message = "Aborted") {
    super(message);
    this.name = "AbortError";
  }
}

export class CLIConnectionError extends ClaudeSDKError {}

export class CLINotFoundError extends CLIConnectionError {
  constructor(message = "Claude Code not found", cliPath?: string) {
    super(cliPath ? `${message}: ${cliPath}` : message);
  }
}

export class ProcessError extends ClaudeSDKError {
  readonly exitCode: number | null;
  readonly stderr: string | undefined;

  constructor(message: string, options: { exitCode?: number | null; stderr?: string } = {}) {
    const detail =
      options.exitCode != null ? `${message} (exit code: ${options.exitCode})` : message;
    const withStderr = options.stderr ? `${detail}\nError output: ${options.stderr}` : detail;

    super(withStderr);
    this.exitCode = options.exitCode ?? null;
    this.stderr = options.stderr;
  }
}

export class CLIJSONDecodeError extends ClaudeSDKError {
  readonly line: string;
  readonly originalError: unknown;

  constructor(line: string, originalError: unknown) {
    super(`Failed to decode JSON: ${line.slice(0, 100)}...`);
    this.line = line;
    this.originalError = originalError;
  }
}
