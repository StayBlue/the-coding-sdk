/*
 * This file incorporates material from claude-agent-sdk-python, licensed under
 * the MIT License:
 *
 * Copyright (c) 2025 Anthropic, PBC
 *
 * Modifications Copyright 2026 StayBlue, licensed under the Apache License,
 * Version 2.0. See the LICENSE file in the project root for details.
 */

import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { AsyncQueue } from "./async-queue.ts";
import { AbortError, CLIConnectionError } from "./errors.ts";
import { McpBridgeTransport } from "./mcp-bridge-transport.ts";
import { dispatchSdkMcpRequest } from "./sdk-tools.ts";
import {
  parseJSONRPCMessage,
  type ParsedJSONRPCMessage,
  parseJSONRPCMessageId,
  parseRecordUnknown,
  parseSDKControlRequestInner,
} from "./schemas.ts";
import { SubprocessCLITransport } from "./subprocess-transport.ts";
import type {
  AccountInfo,
  AgentInfo,
  ElicitationRequest,
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  McpServerConfig,
  McpServerStatus,
  McpSetServersResult,
  ModelInfo,
  Options,
  PermissionMode,
  PermissionResult,
  Query,
  RewindFilesOptions,
  RewindFilesResult,
  SDKControlGetContextUsageResponse,
  SDKControlInitializeResponse,
  SDKControlReadFileResponse,
  SDKControlReloadPluginsResponse,
  SDKControlRequest,
  SDKControlRequestInner,
  SDKControlResponse,
  SDKMessage,
  SDKResultMessage,
  SessionKey,
  SessionStoreEntry,
  SDKUserMessage,
  Settings,
  SlashCommand,
  StdoutMessage,
  Transport,
  WarmQuery,
} from "./types.ts";

const MAX_SANITIZED_LENGTH = 200;
const SANITIZE_RE = /[^a-zA-Z0-9]/g;

type QueryControllerOptions = {
  transport: Transport;
  options: Options;
};

/** Implements the streaming query API over a connected Claude Code transport. */
export class QueryController implements Query {
  #transport: Transport;
  #options: Options;
  #queue = new AsyncQueue<SDKMessage>();
  // oxlint-disable-next-line no-unused-private-class-members
  #startupPromise: Promise<void> = Promise.resolve();
  #started = false;
  #closed = false;
  #firstResultSeen = false;
  #firstResultWaiters: Array<() => void> = [];
  #requestCounter = 0;
  #pendingControls = new Map<
    string,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: unknown) => void;
      timer: Timer | number;
    }
  >();
  #controlHandlers = new Map<string, HookCallback>();
  #inflightControlRequests = new Map<string, AbortController>();
  #initializationResponse?: SDKControlInitializeResponse;
  #sdkMcpServers = new Map<string, NonNullable<Options["mcpServers"]>[string] & { type: "sdk" }>();
  #sdkMcpBridges = new Map<string, McpBridgeTransport>();
  #pendingMcpResponses = new Map<string, { resolve: (msg: JSONRPCMessage) => void }>();
  #cleanupCallbacks: Array<() => void> = [];
  #cleanupRun = false;

  constructor({ transport, options }: QueryControllerOptions) {
    this.#transport = transport;
    this.#options = options;
    this.#seedSdkMcpServers(options.mcpServers);
  }

  setStartupPromise(promise: Promise<void>): void {
    this.#startupPromise = promise.catch((error) => {
      this.#queue.fail(error);
      throw error;
    });
  }

  addCleanupCallback(callback: () => void): void {
    if (this.#cleanupRun || this.#closed) {
      callback();
      return;
    }
    this.#cleanupCallbacks.push(callback);
  }

  async initialize(): Promise<SDKControlInitializeResponse> {
    await this.#connectSdkMcpBridges();

    const hooks = this.#convertHooks();
    const systemPrompt =
      typeof this.#options.systemPrompt === "string"
        ? [this.#options.systemPrompt]
        : Array.isArray(this.#options.systemPrompt)
          ? this.#options.systemPrompt
          : undefined;
    const appendSystemPrompt =
      typeof this.#options.systemPrompt === "object" && !Array.isArray(this.#options.systemPrompt)
        ? this.#options.systemPrompt.append
        : undefined;
    const excludeDynamicSections =
      typeof this.#options.systemPrompt === "object" && !Array.isArray(this.#options.systemPrompt)
        ? this.#options.systemPrompt.excludeDynamicSections
        : undefined;
    const outputFormat =
      this.#options.outputFormat?.type === "json_schema"
        ? this.#options.outputFormat.schema
        : undefined;

    const response = await this.#sendControlRequest<SDKControlInitializeResponse>(
      {
        subtype: "initialize",
        sdkMcpServers: [...this.#sdkMcpServers.keys()],
        ...(hooks ? { hooks } : {}),
        ...(outputFormat ? { jsonSchema: outputFormat } : {}),
        ...(systemPrompt ? { systemPrompt } : {}),
        ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
        ...(excludeDynamicSections != null ? { excludeDynamicSections } : {}),
        ...(this.#options.agents ? { agents: this.#options.agents } : {}),
        ...(this.#options.title ? { title: this.#options.title } : {}),
        ...(this.#options.planModeInstructions !== undefined
          ? { planModeInstructions: this.#options.planModeInstructions }
          : {}),
        ...(Array.isArray(this.#options.skills) ? { skills: this.#options.skills } : {}),
        ...(this.#options.promptSuggestions != null
          ? { promptSuggestions: this.#options.promptSuggestions }
          : {}),
        ...(this.#options.agentProgressSummaries != null
          ? { agentProgressSummaries: this.#options.agentProgressSummaries }
          : {}),
        ...(this.#options.forwardSubagentText != null
          ? { forwardSubagentText: this.#options.forwardSubagentText }
          : {}),
      },
      60_000,
    );

    this.#initializationResponse = response;
    return this.#initializationResponse;
  }

  async interrupt(): Promise<void> {
    await this.#ready();
    await this.#sendControlRequest({ subtype: "interrupt" });
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.#ready();
    await this.#sendControlRequest({ subtype: "set_permission_mode", mode });
  }

  async setModel(model?: string): Promise<void> {
    await this.#ready();
    await this.#sendControlRequest({
      subtype: "set_model",
      ...(model ? { model } : {}),
    });
  }

  async setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void> {
    await this.#ready();
    await this.#sendControlRequest({
      subtype: "set_max_thinking_tokens",
      max_thinking_tokens: maxThinkingTokens,
    });
  }

  async applyFlagSettings(settings: Settings): Promise<void> {
    await this.#ready();
    await this.#sendControlRequest({ subtype: "apply_flag_settings", settings });
  }

  async initializationResult(): Promise<SDKControlInitializeResponse> {
    await this.#ready();
    return this.#initializationResponse ?? (await this.initialize());
  }

  async supportedCommands(): Promise<SlashCommand[]> {
    return (await this.initializationResult()).commands ?? [];
  }

  async supportedModels(): Promise<ModelInfo[]> {
    return (await this.initializationResult()).models ?? [];
  }

  async supportedAgents(): Promise<AgentInfo[]> {
    return (await this.initializationResult()).agents ?? [];
  }

  async mcpServerStatus(): Promise<McpServerStatus[]> {
    await this.#ready();
    const response = await this.#sendControlRequest<{ mcpServers?: McpServerStatus[] }>({
      subtype: "mcp_status",
    });
    return response.mcpServers ?? [];
  }

  async getContextUsage(): Promise<SDKControlGetContextUsageResponse> {
    await this.#ready();
    return this.#sendControlRequest<SDKControlGetContextUsageResponse>({
      subtype: "get_context_usage",
    });
  }

  async readFile(
    path: string,
    options?: { maxBytes?: number; encoding?: "utf-8" | "base64" },
  ): Promise<SDKControlReadFileResponse | null> {
    await this.#ready();
    try {
      return await this.#sendControlRequest<SDKControlReadFileResponse>({
        subtype: "read_file",
        path,
        ...(options?.maxBytes != null ? { max_bytes: options.maxBytes } : {}),
        ...(options?.encoding ? { encoding: options.encoding } : {}),
      });
    } catch {
      return null;
    }
  }

  async setMcpServers(servers: Record<string, McpServerConfig>): Promise<McpSetServersResult> {
    await this.#ready();

    const sdkServers = new Map<
      string,
      NonNullable<Options["mcpServers"]>[string] & { type: "sdk" }
    >();
    const processServers: Record<string, McpServerConfig> = {};

    for (const [name, server] of Object.entries(servers)) {
      if (server.type === "sdk") {
        sdkServers.set(
          name,
          server as NonNullable<Options["mcpServers"]>[string] & { type: "sdk" },
        );
      } else {
        processServers[name] = server;
      }
    }

    const oldNames = new Set(this.#sdkMcpServers.keys());
    for (const name of oldNames) {
      if (!sdkServers.has(name)) {
        await this.#disconnectSdkMcpServer(name);
      }
    }

    for (const [name, server] of sdkServers) {
      if (oldNames.has(name)) {
        await this.#disconnectSdkMcpServer(name);
      }
      this.#sdkMcpServers.set(name, server);
      const instance = server.instance as unknown as Record<string, unknown>;
      if (typeof instance.connect === "function") {
        try {
          await this.#connectSdkMcpServer(
            name,
            instance as { connect(transport: McpBridgeTransport): Promise<void> },
          );
        } catch {
          sdkServers.delete(name);
        }
      }
    }

    const sdkStubs: Record<string, { type: "sdk"; name: string }> = {};
    for (const name of sdkServers.keys()) {
      sdkStubs[name] = { type: "sdk", name };
    }

    return this.#sendControlRequest<McpSetServersResult>({
      subtype: "mcp_set_servers",
      servers: { ...processServers, ...sdkStubs } as Record<string, McpServerConfig>,
    });
  }

  async reloadPlugins(): Promise<SDKControlReloadPluginsResponse> {
    await this.#ready();
    return this.#sendControlRequest<SDKControlReloadPluginsResponse>({
      subtype: "reload_plugins",
    });
  }

  async accountInfo(): Promise<AccountInfo> {
    return (await this.initializationResult()).account ?? {};
  }

  async rewindFiles(
    userMessageId: string,
    options?: RewindFilesOptions,
  ): Promise<RewindFilesResult> {
    await this.#ready();
    return this.#sendControlRequest<RewindFilesResult>({
      subtype: "rewind_files",
      user_message_id: userMessageId,
      ...(options?.dryRun != null ? { dry_run: options.dryRun } : {}),
    });
  }

  async reconnectMcpServer(serverName: string): Promise<void> {
    await this.#ready();
    await this.#sendControlRequest({
      subtype: "mcp_reconnect",
      serverName,
    });
  }

  async toggleMcpServer(serverName: string, enabled: boolean): Promise<void> {
    await this.#ready();
    await this.#sendControlRequest({
      subtype: "mcp_toggle",
      serverName,
      enabled,
    });
  }

  async streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void> {
    await this.#ready();

    try {
      for await (const message of stream) {
        if (this.#closed) {
          break;
        }
        await this.#transport.write(`${JSON.stringify(message)}\n`);
      }
      await this.#waitForResultAndEndInput();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new AbortError(error.message);
      }
      throw error;
    }
  }

  async stopTask(taskId: string): Promise<void> {
    await this.#ready();
    await this.#sendControlRequest({
      subtype: "stop_task",
      task_id: taskId,
    });
  }

  async seedReadState(path: string, mtime: number): Promise<void> {
    await this.#ready();
    await this.#sendControlRequest({ subtype: "seed_read_state", path, mtime });
  }

  close(error?: unknown): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const abortController of this.#inflightControlRequests.values()) {
      abortController.abort();
    }
    const closeError =
      error instanceof Error
        ? error
        : new CLIConnectionError(typeof error === "string" ? error : "Query closed");

    for (const { reject, timer } of this.#pendingControls.values()) {
      clearTimeout(timer as number);
      reject(closeError);
    }
    this.#pendingControls.clear();
    for (const { resolve } of this.#pendingMcpResponses.values()) {
      resolve({
        jsonrpc: "2.0",
        error: { code: -32600, message: closeError.message },
      } as unknown as JSONRPCMessage);
    }
    this.#pendingMcpResponses.clear();

    for (const bridge of this.#sdkMcpBridges.values()) {
      void bridge.close();
    }
    this.#sdkMcpBridges.clear();

    if (error !== undefined) {
      this.#queue.fail(error);
    } else {
      this.#queue.close();
    }

    this.#transport.close();
    this.#runCleanupCallbacks();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.close();
  }

  async start(): Promise<void> {
    if (this.#started) {
      return;
    }
    this.#started = true;

    try {
      for await (const message of this.#transport.readMessages()) {
        if (this.#closed) {
          break;
        }

        if (message.type === "control_response") {
          this.#handleControlResponse(message);
          continue;
        }

        if (message.type === "control_request") {
          this.#handleControlRequest(message);
          continue;
        }

        if (message.type === "control_cancel_request") {
          const requestId = message.request_id;
          this.#inflightControlRequests.get(requestId)?.abort();
          this.#inflightControlRequests.delete(requestId);
          continue;
        }

        if (message.type === "keep_alive") {
          continue;
        }

        if (message.type === "transcript_mirror") {
          await this.#handleTranscriptMirror(message);
          continue;
        }

        if (!isSdkMessage(message)) {
          continue;
        }

        const sdkMessage = message;
        if (sdkMessage.type === "result") {
          this.#markFirstResult();
        }
        this.#queue.push(sdkMessage);
      }
      this.#markFirstResult();
      this.#queue.close();
      this.#runCleanupCallbacks();
    } catch (error) {
      this.#markFirstResult();
      this.#queue.fail(error);
      this.#runCleanupCallbacks();
      throw error;
    }
  }

  async next(): Promise<IteratorResult<SDKMessage>> {
    await this.#startupPromise;
    return this.#queue.next();
  }

  async return(): Promise<IteratorResult<SDKMessage>> {
    this.close();
    return this.#queue.return();
  }

  async throw(error?: unknown): Promise<IteratorResult<SDKMessage>> {
    this.close(error);
    return this.#queue.throw(error);
  }

  [Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void> {
    return this;
  }

  async sendUserMessage(message: SDKUserMessage): Promise<void> {
    await this.#ready();
    await this.#transport.write(`${JSON.stringify(message)}\n`);
  }

  waitForResultAndEndInput(): Promise<void> {
    return this.#waitForResultAndEndInput();
  }

  async #ready(): Promise<void> {
    await this.#startupPromise;
  }

  #convertHooks():
    | Partial<
        Record<HookEvent, Array<{ matcher?: string; hookCallbackIds: string[]; timeout?: number }>>
      >
    | undefined {
    const hooks = this.#options.hooks;
    if (!hooks) {
      return undefined;
    }

    const converted: Partial<
      Record<HookEvent, Array<{ matcher?: string; hookCallbackIds: string[]; timeout?: number }>>
    > = {};

    for (const [event, matchers] of Object.entries(hooks) as Array<
      [HookEvent, HookCallbackMatcher[]]
    >) {
      converted[event] = matchers.map((matcher) => {
        const hookCallbackIds = matcher.hooks.map((hook) => {
          const id = `hook_${this.#controlHandlers.size}`;
          this.#controlHandlers.set(id, hook);
          return id;
        });

        return {
          hookCallbackIds,
          ...(matcher.matcher ? { matcher: matcher.matcher } : {}),
          ...(matcher.timeout != null ? { timeout: matcher.timeout } : {}),
        };
      });
    }

    return converted;
  }

  async #sendControlRequest<T = Record<string, unknown>>(
    request: SDKControlRequestInner,
    timeoutMs = 30_000,
  ): Promise<T> {
    if (this.#closed) {
      throw new CLIConnectionError("Query is closed");
    }

    const requestId = `req_${++this.#requestCounter}_${randomUUID()}`;
    const message: SDKControlRequest = {
      type: "control_request",
      request_id: requestId,
      request,
    };

    const responsePromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingControls.delete(requestId);
        reject(new CLIConnectionError(`Control request timeout: ${request.subtype}`));
      }, timeoutMs);

      this.#pendingControls.set(requestId, {
        resolve,
        reject,
        timer,
      });
    });

    await this.#transport.write(`${JSON.stringify(message)}\n`);
    return responsePromise as Promise<T>;
  }

  #handleControlResponse(message: Extract<StdoutMessage, { type: "control_response" }>): void {
    const pending = this.#pendingControls.get(message.response.request_id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer as number);
    this.#pendingControls.delete(message.response.request_id);

    if (message.response.subtype === "error") {
      pending.reject(new CLIConnectionError(message.response.error ?? "Unknown control error"));
      return;
    }

    pending.resolve(message.response.response ?? {});
  }

  #handleControlRequest(message: Extract<StdoutMessage, { type: "control_request" }>): void {
    const requestId = message.request_id;
    const request = parseSDKControlRequestInner(message.request);
    if (!request) {
      throw new CLIConnectionError("Malformed control request payload");
    }
    const abortController = new AbortController();
    this.#inflightControlRequests.set(requestId, abortController);

    void (async () => {
      try {
        const response = await this.#fulfillControlRequest(request, abortController.signal);
        const controlResponse: SDKControlResponse = {
          type: "control_response",
          response: {
            subtype: "success",
            request_id: requestId,
            response,
          },
        };
        await this.#transport.write(`${JSON.stringify(controlResponse)}\n`);
      } catch (error) {
        if (abortController.signal.aborted) {
          return;
        }

        const controlResponse: SDKControlResponse = {
          type: "control_response",
          response: {
            subtype: "error",
            request_id: requestId,
            error: error instanceof Error ? error.message : String(error),
          },
        };
        await this.#transport.write(`${JSON.stringify(controlResponse)}\n`);
      } finally {
        this.#inflightControlRequests.delete(requestId);
      }
    })();
  }

  async #fulfillControlRequest(
    request: SDKControlRequestInner,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    switch (request.subtype) {
      case "can_use_tool": {
        if (!this.#options.canUseTool) {
          throw new CLIConnectionError("canUseTool callback is not configured");
        }

        const result = await this.#options.canUseTool(request.tool_name, request.input, {
          signal,
          toolUseID: request.tool_use_id,
          ...(request.permission_suggestions
            ? { suggestions: request.permission_suggestions }
            : {}),
          ...(request.blocked_path ? { blockedPath: request.blocked_path } : {}),
          ...(request.decision_reason ? { decisionReason: request.decision_reason } : {}),
          ...(request.title ? { title: request.title } : {}),
          ...(request.display_name ? { displayName: request.display_name } : {}),
          ...(request.description ? { description: request.description } : {}),
          ...(request.agent_id ? { agentID: request.agent_id } : {}),
        });

        return buildCanUseToolResponse(result, request.input);
      }
      case "hook_callback": {
        const callbackId = request.callback_id;
        if (!callbackId) {
          throw new CLIConnectionError("Missing hook callback id");
        }

        const callback = this.#controlHandlers.get(callbackId);
        if (!callback) {
          throw new CLIConnectionError(`Unknown hook callback: ${callbackId}`);
        }
        return (await callback(request.input, request.tool_use_id, { signal })) as Record<
          string,
          unknown
        >;
      }
      case "mcp_message": {
        const bridge = this.#sdkMcpBridges.get(request.server_name);
        const parsedMessage = parseJSONRPCMessage(request.message);
        if (!parsedMessage) {
          throw new CLIConnectionError(`Invalid MCP message for server: ${request.server_name}`);
        }

        if (bridge) {
          let msg: ParsedJSONRPCMessage = parsedMessage;

          const params = parseRecordUnknown(parsedMessage.params);
          if (parsedMessage.method === "initialize" && params) {
            const capabilities = parseRecordUnknown(params.capabilities);
            if (!capabilities?.elicitation) {
              msg = {
                ...parsedMessage,
                params: {
                  ...params,
                  capabilities: { ...capabilities, elicitation: {} },
                },
              };
            }
          }

          const rpcMessage = msg as JSONRPCMessage;
          const msgId = parseJSONRPCMessageId(msg.id);

          if (("result" in msg || "error" in msg) && msgId !== undefined) {
            const key = `${request.server_name}:${msgId}`;
            const pending = this.#pendingMcpResponses.get(key);
            if (pending) {
              pending.resolve(rpcMessage);
              this.#pendingMcpResponses.delete(key);
              return {};
            }
          }

          if (typeof msg.method === "string" && msgId !== undefined) {
            const key = `${request.server_name}:${msgId}`;
            let timer: Timer | number;
            const responsePromise = new Promise<JSONRPCMessage>((resolve, reject) => {
              this.#pendingMcpResponses.set(key, {
                resolve: (value) => {
                  clearTimeout(timer as number);
                  resolve(value);
                },
              });
              timer = setTimeout(() => {
                if (this.#pendingMcpResponses.delete(key)) {
                  reject(new CLIConnectionError("MCP response timeout"));
                }
              }, 30_000);
            });
            bridge.handleInbound(rpcMessage);
            const response = await responsePromise;
            return { mcp_response: response };
          }

          bridge.handleInbound(rpcMessage);
          return {};
        }

        const server = this.#sdkMcpServers.get(request.server_name);
        if (!server) {
          throw new CLIConnectionError(`Unknown SDK MCP server: ${request.server_name}`);
        }
        return {
          mcp_response: await dispatchSdkMcpRequest(server.instance, parsedMessage),
        };
      }
      case "elicitation": {
        if (this.#options.onElicitation) {
          return (await this.#options.onElicitation(
            this.#buildElicitationRequest(request.mcp_server_name, request),
            { signal },
          )) as unknown as Record<string, unknown>;
        }

        return { action: "decline" };
      }
      default:
        throw new CLIConnectionError(`Unsupported control request subtype: ${request.subtype}`);
    }
  }

  async #waitForResultAndEndInput(): Promise<void> {
    if (this.#sdkMcpServers.size > 0 || this.#controlHandlers.size > 0) {
      if (!this.#firstResultSeen) {
        await new Promise<void>((resolve) => {
          this.#firstResultWaiters.push(resolve);
        });
      }
    }

    this.#transport.endInput();
  }

  #markFirstResult(): void {
    if (this.#firstResultSeen) {
      return;
    }
    this.#firstResultSeen = true;
    const waiters = [...this.#firstResultWaiters];
    this.#firstResultWaiters = [];
    for (const waiter of waiters) {
      waiter();
    }
  }

  async #handleTranscriptMirror(
    message: Extract<StdoutMessage, { type: "transcript_mirror" }>,
  ): Promise<void> {
    const store = this.#options.sessionStore;
    if (!store) {
      return;
    }

    const key = sessionKeyFromTranscriptPath(message.filePath, this.#options);
    if (!key) {
      return;
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await store.append(key, message.entries);
        return;
      } catch (error) {
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
          continue;
        }
        this.#queue.push({
          type: "system",
          subtype: "mirror_error",
          error: error instanceof Error ? error.message : String(error),
          key,
          uuid: randomUUID(),
          session_id: key.sessionId,
        });
      }
    }
  }

  #runCleanupCallbacks(): void {
    if (this.#cleanupRun) {
      return;
    }
    this.#cleanupRun = true;
    const callbacks = this.#cleanupCallbacks;
    this.#cleanupCallbacks = [];
    for (const callback of callbacks) {
      try {
        callback();
      } catch {
        // best-effort cleanup
      }
    }
  }

  #seedSdkMcpServers(servers: Options["mcpServers"]): void {
    this.#sdkMcpServers.clear();
    this.#sdkMcpBridges.clear();
    if (!servers) {
      return;
    }

    for (const [name, server] of Object.entries(servers)) {
      if (server.type === "sdk") {
        this.#sdkMcpServers.set(name, server);
      }
    }
  }

  async #connectSdkMcpBridges(): Promise<string[]> {
    const failedServers: string[] = [];
    for (const [name, server] of this.#sdkMcpServers) {
      const instance = server.instance as unknown as Record<string, unknown>;
      if (typeof instance.connect === "function") {
        try {
          await this.#connectSdkMcpServer(
            name,
            instance as { connect(transport: McpBridgeTransport): Promise<void> },
          );
        } catch {
          this.#sdkMcpServers.delete(name);
          failedServers.push(name);
        }
      }
    }
    return failedServers;
  }

  async #connectSdkMcpServer(
    name: string,
    mcpServer: { connect(transport: McpBridgeTransport): Promise<void> },
  ): Promise<void> {
    const bridge = new McpBridgeTransport(
      (message: JSONRPCMessage) => {
        this.#sendMcpServerMessageToCli(name, message);
      },
      this.#options.onElicitation
        ? async (params) => {
            return (await this.#options.onElicitation!(
              this.#buildElicitationRequest(name, params),
              { signal: AbortSignal.timeout(30_000) },
            )) as unknown as Record<string, unknown>;
          }
        : undefined,
    );
    this.#sdkMcpBridges.set(name, bridge);
    try {
      await mcpServer.connect(bridge);
    } catch (error) {
      this.#sdkMcpBridges.delete(name);
      this.#sdkMcpServers.delete(name);
      throw new CLIConnectionError(`Failed to connect SDK MCP server: ${name}`, { cause: error });
    }
  }

  #buildElicitationRequest(
    serverName: string,
    params: {
      message?: unknown;
      mode?: unknown;
      url?: unknown;
      elicitationId?: unknown;
      elicitation_id?: unknown;
      requestedSchema?: unknown;
      requested_schema?: unknown;
      title?: unknown;
      displayName?: unknown;
      display_name?: unknown;
      description?: unknown;
    },
  ): ElicitationRequest {
    return {
      serverName,
      message: String(params.message ?? ""),
      ...(params.mode ? { mode: params.mode as "form" | "url" } : {}),
      ...(params.url ? { url: String(params.url) } : {}),
      ...((params.elicitationId ?? params.elicitation_id)
        ? { elicitationId: String(params.elicitationId ?? params.elicitation_id) }
        : {}),
      ...((params.requestedSchema ?? params.requested_schema)
        ? {
            requestedSchema: (params.requestedSchema ?? params.requested_schema) as Record<
              string,
              unknown
            >,
          }
        : {}),
      ...(params.title ? { title: String(params.title) } : {}),
      ...((params.displayName ?? params.display_name)
        ? { displayName: String(params.displayName ?? params.display_name) }
        : {}),
      ...(params.description ? { description: String(params.description) } : {}),
    };
  }

  async #disconnectSdkMcpServer(name: string): Promise<void> {
    const prefix = `${name}:`;
    for (const [key, { resolve }] of this.#pendingMcpResponses) {
      if (key.startsWith(prefix)) {
        resolve({
          jsonrpc: "2.0",
          error: { code: -32600, message: "Server disconnected" },
        } as unknown as JSONRPCMessage);
        this.#pendingMcpResponses.delete(key);
      }
    }
    const bridge = this.#sdkMcpBridges.get(name);
    if (bridge) {
      await bridge.close();
      this.#sdkMcpBridges.delete(name);
    }
    this.#sdkMcpServers.delete(name);
  }

  #sendMcpServerMessageToCli(serverName: string, message: JSONRPCMessage): void {
    if ("id" in message && message.id != null) {
      const key = `${serverName}:${message.id}`;
      const pending = this.#pendingMcpResponses.get(key);
      if (pending) {
        pending.resolve(message);
        this.#pendingMcpResponses.delete(key);
        return;
      }
    }

    void this.#sendControlRequest(
      {
        subtype: "mcp_message",
        server_name: serverName,
        message: message as JSONRPCMessage,
      },
      30_000,
    ).catch(() => {});
  }
}

export function createUserPromptMessage(prompt: string, sessionId = ""): SDKUserMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: prompt,
    },
    parent_tool_use_id: null,
    session_id: sessionId,
  };
}

/** Starts a Claude Code query and returns an async iterator of streamed SDK messages. */
export function query(params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query {
  const baseOptions = params.options ?? {};
  assertCanUseToolPromptMode(baseOptions, params.prompt);
  const options = normalizeOptionsForCanUseTool(baseOptions);

  const transport = new SubprocessCLITransport(options);
  const controller = new QueryController({ transport, options });

  const startupPromise = (async () => {
    const cleanup = await prepareSessionStoreResume(options);
    controller.addCleanupCallback(cleanup);
    await transport.connect();
    void controller.start();
    await controller.initialize();
  })();

  controller.setStartupPromise(startupPromise);

  const sendPrompt = async (): Promise<void> => {
    await startupPromise;

    if (typeof params.prompt === "string") {
      const message = createUserPromptMessage(params.prompt);
      await controller.sendUserMessage(message);
      void controller.waitForResultAndEndInput();
      return;
    }

    await controller.streamInput(params.prompt);
  };

  void sendPrompt().catch((error) => {
    controller.close(error);
  });

  return controller;
}

/** Pre-warms a Claude Code subprocess and returns a one-shot query handle. */
export async function startup(
  params: {
    options?: Options;
    initializeTimeoutMs?: number;
  } = {},
): Promise<WarmQuery> {
  const options = normalizeOptionsForCanUseTool(params.options ?? {});
  const transport = new SubprocessCLITransport(options);
  const controller = new QueryController({ transport, options });
  const cleanup = await prepareSessionStoreResume(options);
  controller.addCleanupCallback(cleanup);

  const startupPromise = (async () => {
    await transport.connect();
    void controller.start();
    await withTimeout(
      controller.initialize(),
      params.initializeTimeoutMs ?? 60_000,
      "Subprocess initialization did not complete within the configured timeout",
    );
  })();

  controller.setStartupPromise(startupPromise);
  await startupPromise;

  let used = false;
  const close = () => {
    used = true;
    controller.close();
  };

  return {
    query(prompt: string | AsyncIterable<SDKUserMessage>): Query {
      if (used) {
        throw new Error("WarmQuery.query() can only be called once");
      }
      assertCanUseToolPromptMode(options, prompt);
      used = true;

      if (typeof prompt === "string") {
        void (async () => {
          try {
            await controller.sendUserMessage(createUserPromptMessage(prompt));
            void controller.waitForResultAndEndInput();
          } catch (error) {
            controller.close(error);
          }
        })();
        return controller;
      }

      void controller.streamInput(prompt).catch((error) => {
        controller.close(error);
      });
      return controller;
    },
    close(): void {
      close();
    },
    async [Symbol.asyncDispose](): Promise<void> {
      close();
    },
  };
}

function normalizeOptionsForCanUseTool(baseOptions: Options): Options {
  if (baseOptions.canUseTool == null) {
    return { ...baseOptions };
  }
  if (baseOptions.permissionPromptToolName != null) {
    throw new Error(
      "canUseTool callback cannot be used with permissionPromptToolName. Please use one or the other.",
    );
  }
  return {
    ...baseOptions,
    permissionPromptToolName: "stdio",
  };
}

function assertCanUseToolPromptMode(
  options: Options,
  prompt: string | AsyncIterable<SDKUserMessage>,
): void {
  if (options.canUseTool != null && typeof prompt === "string") {
    throw new Error(
      "canUseTool callback requires streaming mode. Please provide prompt as an AsyncIterable instead of a string.",
    );
  }
}

export async function collectUntilResult(controller: Query): Promise<SDKResultMessage> {
  for await (const message of controller) {
    if (message.type === "result") {
      return message as SDKResultMessage;
    }
  }
  throw new CLIConnectionError("No result message was received");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: Timer | number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new CLIConnectionError(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer as number);
    }
  }
}

async function prepareSessionStoreResume(options: Options): Promise<() => void> {
  const store = options.sessionStore;
  if (!store || (!options.resume && !options.continue)) {
    return () => {};
  }

  if (options.persistSession === false) {
    throw new Error(
      "sessionStore cannot be used with persistSession: false -- local writes are required for transcript mirroring.",
    );
  }
  if (options.enableFileCheckpointing) {
    throw new Error("enableFileCheckpointing is not yet supported with sessionStore.");
  }

  let sessionId = options.resume;
  const projectKey = projectKeyForCwd(options.cwd);
  const timeoutMs = options.loadTimeoutMs ?? 60_000;

  if (!sessionId && options.continue) {
    if (!store.listSessions) {
      throw new Error(
        "Options.continue with sessionStore requires store.listSessions to be implemented",
      );
    }
    const sessions = await withTimeout(
      store.listSessions(projectKey),
      timeoutMs,
      `SessionStore.listSessions() timed out after ${timeoutMs}ms`,
    );
    sessionId = sessions.slice().sort((left, right) => right.mtime - left.mtime)[0]?.sessionId;
  }

  if (!sessionId) {
    return () => {};
  }

  const entries = await withTimeout(
    store.load({ projectKey, sessionId }),
    timeoutMs,
    `SessionStore.load() timed out after ${timeoutMs}ms for session ${sessionId}`,
  );
  if (!entries || entries.length === 0) {
    return () => {};
  }

  const tempDir = mkdtempSync(join(tmpdir(), "claude-sdk-store-"));
  const projectDir = join(tempDir, "projects", projectKey);
  mkdirSync(projectDir, { recursive: true });
  writeEntriesJsonl(join(projectDir, `${sessionId}.jsonl`), entries);

  if (store.listSubkeys) {
    const subkeys = await withTimeout(
      store.listSubkeys({ projectKey, sessionId }),
      timeoutMs,
      `SessionStore.listSubkeys() timed out after ${timeoutMs}ms for session ${sessionId}`,
    );
    for (const subpath of subkeys) {
      if (!isSafeStoreSubpath(subpath)) {
        continue;
      }
      const subEntries = await withTimeout(
        store.load({ projectKey, sessionId, subpath }),
        timeoutMs,
        `SessionStore.load() timed out after ${timeoutMs}ms for session ${sessionId} subpath ${subpath}`,
      );
      if (!subEntries || subEntries.length === 0) {
        continue;
      }
      writeEntriesJsonl(join(projectDir, sessionId, `${subpath}.jsonl`), subEntries);
    }
  }

  copyAuthFiles(tempDir, options.env);
  options.resume = sessionId;
  options.env = {
    ...(options.env ?? process.env),
    CLAUDE_CONFIG_DIR: tempDir,
  };

  return () => {
    rmSync(tempDir, { recursive: true, force: true });
  };
}

function writeEntriesJsonl(filePath: string, entries: SessionStoreEntry[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", {
    mode: 0o600,
  });
}

function copyAuthFiles(tempDir: string, env: Options["env"]): void {
  const configDir = env?.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR;
  const candidates = [
    configDir
      ? join(configDir, ".credentials.json")
      : join(homedir(), ".claude", ".credentials.json"),
    configDir ? join(configDir, ".claude.json") : join(homedir(), ".claude.json"),
  ];

  for (const source of candidates) {
    if (!existsSync(source)) {
      continue;
    }
    try {
      copyFileSync(
        source,
        join(tempDir, source.endsWith(".claude.json") ? ".claude.json" : ".credentials.json"),
      );
    } catch {
      // Auth files are best-effort; the CLI can still authenticate through env vars.
    }
  }
}

function isSafeStoreSubpath(subpath: string): boolean {
  if (!subpath || isAbsolute(subpath) || subpath.split(/[\\/]/).includes("..")) {
    return false;
  }
  return true;
}

function sessionKeyFromTranscriptPath(filePath: string, options: Options): SessionKey | undefined {
  const configDir = options.env?.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR;
  const projectsDir = join(configDir ? resolve(configDir) : join(homedir(), ".claude"), "projects");
  const relativePath = relative(projectsDir, resolve(filePath));
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return undefined;
  }

  const parts = relativePath.split(/[\\/]/);
  const [projectKey, sessionPart] = parts;
  if (!projectKey || !sessionPart) {
    return undefined;
  }

  if (parts.length === 2 && sessionPart.endsWith(".jsonl")) {
    return {
      projectKey,
      sessionId: sessionPart.slice(0, -".jsonl".length),
    };
  }

  if (parts.length >= 4) {
    const subParts = parts.slice(2);
    const last = subParts.at(-1);
    if (!last?.endsWith(".jsonl")) {
      return undefined;
    }
    subParts[subParts.length - 1] = last.slice(0, -".jsonl".length);
    return {
      projectKey,
      sessionId: sessionPart,
      subpath: subParts.join("/"),
    };
  }

  return undefined;
}

function projectKeyForCwd(cwd?: string): string {
  return sanitizePath(canonicalizePath(cwd ?? "."));
}

function sanitizePath(value: string): string {
  const sanitized = value.replace(SANITIZE_RE, "-");
  if (sanitized.length <= MAX_SANITIZED_LENGTH) {
    return sanitized;
  }
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${simpleHash(value)}`;
}

function simpleHash(value: string): string {
  let hash = 0;
  for (const char of value) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }
  return (hash >>> 0).toString(36);
}

function canonicalizePath(value: string): string {
  return resolve(value).normalize("NFC");
}

function isSdkMessage(message: StdoutMessage): message is SDKMessage {
  switch (message.type) {
    case "user":
    case "assistant":
    case "result":
    case "system":
    case "stream_event":
    case "rate_limit_event":
    case "auth_status":
    case "tool_progress":
    case "tool_use_summary":
    case "prompt_suggestion":
      return true;
    default:
      return false;
  }
}

function buildCanUseToolResponse(
  result: PermissionResult,
  originalInput: Record<string, unknown>,
): Record<string, unknown> {
  if (result.behavior === "allow") {
    return {
      behavior: "allow",
      updatedInput: result.updatedInput ?? originalInput,
      ...(result.updatedPermissions ? { updatedPermissions: result.updatedPermissions } : {}),
      ...(result.toolUseID ? { toolUseID: result.toolUseID } : {}),
      ...(result.decisionClassification
        ? { decisionClassification: result.decisionClassification }
        : {}),
    };
  }

  return {
    behavior: "deny",
    message: result.message,
    ...(result.interrupt ? { interrupt: result.interrupt } : {}),
    ...(result.toolUseID ? { toolUseID: result.toolUseID } : {}),
    ...(result.decisionClassification
      ? { decisionClassification: result.decisionClassification }
      : {}),
  };
}
