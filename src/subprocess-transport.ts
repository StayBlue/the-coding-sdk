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
import { spawn } from "node:child_process";
import {
  CLIConnectionError,
  CLIJSONDecodeError,
  CLINotFoundError,
  ProcessError,
} from "./errors.ts";
import { tryCatchSync } from "./try-catch.ts";
import { parseStdoutMessage } from "./schemas.ts";
import type { Options, SpawnedProcess, StdoutMessage, Transport } from "./types.ts";

const DEFAULT_MAX_BUFFER_SIZE = 1024 * 1024;

export class SubprocessCLITransport implements Transport {
  #options: Options;
  #process: SpawnedProcess | null = null;
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
        (spawn(command, args, {
          env,
          stdio: ["pipe", "pipe", "pipe"],
          signal: this.#abortController.signal,
          ...(this.#options.cwd ? { cwd: this.#options.cwd } : {}),
        }) as SpawnedProcess);

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

    const proc = this.#process;
    this.#process = null;
    if (!proc) {
      return;
    }

    proc.once("error", () => {});

    if ("kill" in proc && typeof proc.kill === "function" && !proc.killed) {
      tryCatchSync(() => proc.kill("SIGTERM"));
      setTimeout(() => {
        if (!proc.killed) {
          tryCatchSync(() => proc.kill("SIGKILL"));
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
    try {
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

          let parsed: StdoutMessage | undefined;
          try {
            parsed = parseStdoutMessage(trimmed);
          } catch (error) {
            throw new CLIJSONDecodeError(trimmed, error);
          }
          if (!parsed) {
            throw new CLIJSONDecodeError(trimmed, new Error("Invalid stdout message structure"));
          }
          yield parsed;
        }
      }
    } catch (error) {
      if (!this.#ready && error instanceof Error && error.name === "AbortError") {
        return;
      }
      throw error;
    }

    if (buffer.trim().length > 0) {
      let parsed: StdoutMessage | undefined;
      try {
        parsed = parseStdoutMessage(buffer);
      } catch (error) {
        throw new CLIJSONDecodeError(buffer, error);
      }
      if (!parsed) {
        throw new CLIJSONDecodeError(buffer, new Error("Invalid stdout message structure"));
      }
      yield parsed;
    }

    const exitCode = await waitForExit(this.#process);
    if (this.#abortController.signal.aborted || !this.#ready) {
      return;
    }
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
    const cliArgs = [
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
    ];

    if (this.#options.thinking) {
      switch (this.#options.thinking.type) {
        case "enabled":
          if (this.#options.thinking.budgetTokens === undefined) {
            cliArgs.push("--thinking", "adaptive");
          } else {
            cliArgs.push("--max-thinking-tokens", String(this.#options.thinking.budgetTokens));
          }
          break;
        case "disabled":
          cliArgs.push("--thinking", "disabled");
          break;
        case "adaptive":
          cliArgs.push("--thinking", "adaptive");
          break;
      }
    } else if (this.#options.maxThinkingTokens != null) {
      if (this.#options.maxThinkingTokens === 0) {
        cliArgs.push("--thinking", "disabled");
      } else {
        cliArgs.push("--max-thinking-tokens", String(this.#options.maxThinkingTokens));
      }
    }
    if (this.#options.effort) {
      cliArgs.push("--effort", this.#options.effort);
    }
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
    if (this.#options.settingSources?.length) {
      cliArgs.push(`--setting-sources=${this.#options.settingSources.join(",")}`);
    }
    if (this.#options.allowDangerouslySkipPermissions) {
      cliArgs.push("--allow-dangerously-skip-permissions");
    }
    if (this.#options.includeHookEvents) {
      cliArgs.push("--include-hook-events");
    }
    if (this.#options.includePartialMessages) {
      cliArgs.push("--include-partial-messages");
    }
    if (this.#options.persistSession === false) {
      cliArgs.push("--no-session-persistence");
    }
    const settings = this.#buildSettingsValue();
    if (settings) {
      cliArgs.push("--settings", settings);
    }
    if (this.#options.additionalDirectories?.length) {
      for (const directory of this.#options.additionalDirectories) {
        cliArgs.push("--add-dir", directory);
      }
    }
    if (this.#options.plugins?.length) {
      for (const plugin of this.#options.plugins) {
        if (plugin.type === "local") {
          cliArgs.push("--plugin-dir", plugin.path);
        }
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

  #buildSettingsValue(): string | undefined {
    const hasSettings = this.#options.settings != null;
    const hasSandbox = this.#options.sandbox != null;

    if (!hasSettings && !hasSandbox) {
      return undefined;
    }

    if (hasSettings && !hasSandbox) {
      return typeof this.#options.settings === "string"
        ? this.#options.settings
        : JSON.stringify(this.#options.settings);
    }

    const settingsObject: Record<string, unknown> = {};
    if (hasSettings) {
      if (typeof this.#options.settings === "string") {
        const trimmed = this.#options.settings.trim();
        if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
          throw new Error(
            "Cannot use both a settings file path and the sandbox option. Include the sandbox configuration in your settings file instead.",
          );
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed) as unknown;
        } catch (error) {
          throw new Error(
            `Failed to parse settings JSON when used with sandbox: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("Settings JSON must parse to an object when used with sandbox.");
        }
        Object.assign(settingsObject, parsed);
      } else {
        Object.assign(settingsObject, this.#options.settings);
      }
    }

    settingsObject.sandbox = this.#options.sandbox;
    return JSON.stringify(settingsObject);
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

function waitForExit(processLike: SpawnedProcess | null): Promise<number | null> {
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
