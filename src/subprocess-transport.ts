/*
 * This file incorporates material from claude-agent-sdk-python, licensed under
 * the MIT License:
 *
 * Copyright (c) 2025 Anthropic, PBC
 *
 * Modifications Copyright 2026 StayBlue, licensed under the Apache License,
 * Version 2.0. See the LICENSE file in the project root for details.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ChildProcess, spawn } from "node:child_process";
import {
  CLIConnectionError,
  CLIJSONDecodeError,
  CLINotFoundError,
  ProcessError,
} from "./errors.ts";
import type { Options, SpawnedProcess, StdoutMessage, Transport } from "./types.ts";

const DEFAULT_MAX_BUFFER_SIZE = 1024 * 1024;

export class SubprocessCLITransport implements Transport {
  #options: Options;
  #process: SpawnedProcess | ChildProcess | null = null;
  #ready = false;
  #stdinClosed = false;
  #abortController: AbortController;
  #maxBufferSize = DEFAULT_MAX_BUFFER_SIZE;
  #stderrBuffer = "";

  constructor(options: Options) {
    this.#options = options;
    this.#abortController = options.abortController ?? new AbortController();
  }

  async connect(): Promise<void> {
    const cliPath = this.#findCli();

    const { command, args } = this.#buildSpawnCommand(cliPath);
    const env = {
      ...process.env,
      ...this.#options.env,
    };

    try {
      this.#process =
        this.#options.spawnClaudeCodeProcess?.({
          command,
          args,
          env,
          signal: this.#abortController.signal,
          ...(this.#options.cwd ? { cwd: this.#options.cwd } : {}),
        }) ??
        spawn(command, args, {
          env,
          stdio: ["pipe", "pipe", "pipe"],
          signal: this.#abortController.signal,
          ...(this.#options.cwd ? { cwd: this.#options.cwd } : {}),
        });

      this.#attachStderr();
      this.#ready = true;
      this.#stdinClosed = false;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new CLINotFoundError("Claude Code not found at", cliPath);
      }
      throw new CLIConnectionError(
        `Failed to start Claude Code: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  isReady(): boolean {
    return this.#ready;
  }

  async write(data: string): Promise<void> {
    const stdin = this.#process?.stdin;
    if (!this.#ready || !stdin || this.#stdinClosed) {
      throw new CLIConnectionError("Process transport is not ready for writing");
    }

    await new Promise<void>((resolve, reject) => {
      stdin.write(data, (error) => {
        if (error) {
          reject(new CLIConnectionError(`Failed to write to process stdin: ${error.message}`));
          return;
        }
        resolve();
      });
    });
  }

  endInput(): void {
    if (this.#stdinClosed) {
      return;
    }
    this.#stdinClosed = true;
    this.#process?.stdin?.end();
  }

  close(): void {
    this.#ready = false;
    this.endInput();
    this.#abortController.abort();

    const proc = this.#process;
    this.#process = null;
    if (!proc) {
      return;
    }

    if ("kill" in proc && typeof proc.kill === "function" && !proc.killed) {
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) {
          proc.kill("SIGKILL");
        }
      }, 1000).unref?.();
    }
  }

  async *readMessages(): AsyncGenerator<StdoutMessage, void, unknown> {
    const stdout = this.#process?.stdout;
    if (!stdout) {
      throw new CLIConnectionError("Transport is not connected");
    }

    let buffer = "";
    for await (const chunk of stdout) {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      buffer += text;

      if (buffer.length > this.#maxBufferSize) {
        const error = new CLIJSONDecodeError(
          "buffer overflow",
          new Error(`JSON message exceeded maximum buffer size of ${this.#maxBufferSize}`),
        );
        this.close();
        throw error;
      }

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("{")) {
          continue;
        }

        try {
          const parsed = JSON.parse(trimmed) as StdoutMessage;
          yield parsed;
        } catch (error) {
          throw new CLIJSONDecodeError(trimmed, error);
        }
      }
    }

    if (buffer.trim().length > 0) {
      try {
        yield JSON.parse(buffer) as StdoutMessage;
      } catch (error) {
        throw new CLIJSONDecodeError(buffer, error);
      }
    }

    const exitCode = await waitForExit(this.#process);
    if (exitCode !== 0 && exitCode !== null) {
      throw new ProcessError("Command failed", {
        exitCode,
        ...(this.#stderrBuffer ? { stderr: this.#stderrBuffer } : {}),
      });
    }
  }

  #attachStderr(): void {
    const processLike = this.#process;
    const stderr =
      processLike && "stderr" in processLike
        ? (processLike.stderr as NodeJS.ReadableStream | null | undefined)
        : undefined;
    if (!stderr) {
      return;
    }

    void (async () => {
      for await (const chunk of stderr) {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        const lines = text
          .split(/\r?\n/)
          .map((line: string) => line.trimEnd())
          .filter(Boolean);

        for (const line of lines) {
          this.#stderrBuffer += `${line}\n`;
          this.#options.stderr?.(line);
        }
      }
    })();
  }

  #findCli(): string {
    if (this.#options.pathToClaudeCodeExecutable) {
      return this.#options.pathToClaudeCodeExecutable;
    }

    // Prefer PATH resolution (matches Python SDK's shutil.which("claude") first-check).
    // Node/Bun spawn resolves bare commands via PATH, so we return "claude" as the
    // primary strategy and only fall through to explicit paths if spawn fails at
    // connect() time with ENOENT.
    //
    // Well-known fallback locations (matches Python SDK's fallback list):
    const fallbackLocations = [
      join(homedir(), ".npm-global/bin/claude"),
      "/usr/local/bin/claude",
      join(homedir(), ".local/bin/claude"),
      join(homedir(), "node_modules/.bin/claude"),
      join(homedir(), ".yarn/bin/claude"),
      join(homedir(), ".claude/local/claude"),
    ];

    for (const location of fallbackLocations) {
      if (existsSync(location)) {
        return location;
      }
    }

    // Fall back to bare "claude" — lets the OS resolve via PATH at spawn time
    return "claude";
  }

  #buildSpawnCommand(cliPath: string): { command: string; args: string[] } {
    const cliArgs = ["--output-format", "stream-json", "--verbose"];

    if (this.#options.tools) {
      if (Array.isArray(this.#options.tools)) {
        cliArgs.push("--tools", this.#options.tools.join(","));
      } else {
        cliArgs.push("--tools", "default");
      }
    }
    if (this.#options.allowedTools?.length) {
      cliArgs.push("--allowedTools", this.#options.allowedTools.join(","));
    }
    if (this.#options.disallowedTools?.length) {
      cliArgs.push("--disallowedTools", this.#options.disallowedTools.join(","));
    }
    if (this.#options.maxTurns != null) {
      cliArgs.push("--max-turns", String(this.#options.maxTurns));
    }
    if (this.#options.maxBudgetUsd != null) {
      cliArgs.push("--max-budget-usd", String(this.#options.maxBudgetUsd));
    }
    if (this.#options.taskBudget?.total != null) {
      cliArgs.push("--task-budget", String(this.#options.taskBudget.total));
    }
    if (this.#options.model) {
      cliArgs.push("--model", this.#options.model);
    }
    if (this.#options.fallbackModel) {
      cliArgs.push("--fallback-model", this.#options.fallbackModel);
    }
    if (this.#options.betas?.length) {
      cliArgs.push("--betas", this.#options.betas.join(","));
    }
    if (this.#options.permissionPromptToolName) {
      cliArgs.push("--permission-prompt-tool", this.#options.permissionPromptToolName);
    }
    if (this.#options.permissionMode) {
      cliArgs.push("--permission-mode", this.#options.permissionMode);
    }
    if (this.#options.continue) {
      cliArgs.push("--continue");
    }
    if (this.#options.resume) {
      cliArgs.push("--resume", this.#options.resume);
    }
    if (this.#options.sessionId) {
      cliArgs.push("--session-id", this.#options.sessionId);
    }
    if (this.#options.resumeSessionAt) {
      cliArgs.push("--resume-session-at", this.#options.resumeSessionAt);
    }
    if (this.#options.forkSession) {
      cliArgs.push("--fork-session");
    }
    if (this.#options.enableFileCheckpointing) {
      cliArgs.push("--enable-file-checkpointing");
    }
    if (this.#options.debug) {
      cliArgs.push("--debug");
    }
    if (this.#options.debugFile) {
      cliArgs.push("--debug-file", this.#options.debugFile);
    }
    if (this.#options.strictMcpConfig) {
      cliArgs.push("--strict-mcp-config");
    }
    if (this.#options.settings) {
      cliArgs.push(
        "--settings",
        typeof this.#options.settings === "string"
          ? this.#options.settings
          : JSON.stringify(this.#options.settings),
      );
    }
    if (this.#options.additionalDirectories?.length) {
      for (const directory of this.#options.additionalDirectories) {
        cliArgs.push("--add-dir", directory);
      }
    }
    if (this.#options.mcpServers && Object.keys(this.#options.mcpServers).length > 0) {
      cliArgs.push(
        "--mcp-config",
        JSON.stringify({
          mcpServers: stripSdkInstances(this.#options.mcpServers),
        }),
      );
    }
    if (this.#options.extraArgs) {
      for (const [key, value] of Object.entries(this.#options.extraArgs)) {
        cliArgs.push(`--${key}`);
        if (value != null) {
          cliArgs.push(value);
        }
      }
    }

    if (!this.#options.executable) {
      return {
        command: cliPath,
        args: cliArgs,
      };
    }

    return {
      command: this.#options.executable,
      args: [...(this.#options.executableArgs ?? []), cliPath, ...cliArgs],
    };
  }
}

function stripSdkInstances(servers: NonNullable<Options["mcpServers"]>) {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => {
      if (server.type !== "sdk") {
        return [name, server];
      }

      return [
        name,
        {
          type: "sdk",
          name: server.name,
        },
      ];
    }),
  );
}

function waitForExit(processLike: SpawnedProcess | ChildProcess | null): Promise<number | null> {
  if (!processLike) {
    return Promise.resolve(0);
  }

  if (processLike.exitCode != null) {
    return Promise.resolve(processLike.exitCode);
  }

  return new Promise((resolve) => {
    const proc = processLike as SpawnedProcess;
    proc.once("exit", (code: number | null) => resolve(code));
    proc.once("error", () => resolve(-1));
  });
}
