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
  SDKControlReloadPluginsResponse,
  SDKControlRequest,
  SDKControlRequestInner,
  SDKControlResponse,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
  SlashCommand,
  StdoutMessage,
  Transport,
} from "./types.ts";

type QueryControllerOptions = {
  transport: Transport;
  options: Options;
};

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

  async initialize(): Promise<SDKControlInitializeResponse> {
    await this.#connectSdkMcpBridges();

    const hooks = this.#convertHooks();
    const systemPrompt =
      typeof this.#options.systemPrompt === "string" ? this.#options.systemPrompt : undefined;
    const appendSystemPrompt =
      typeof this.#options.systemPrompt === "object"
        ? this.#options.systemPrompt.append
        : undefined;
    const outputFormat =
      this.#options.outputFormat?.type === "json_schema"
        ? this.#options.outputFormat.schema
        : undefined;

    const response = await this.#sendControlRequest(
      {
        subtype: "initialize",
        sdkMcpServers: [...this.#sdkMcpServers.keys()],
        ...(hooks ? { hooks } : {}),
        ...(outputFormat ? { jsonSchema: outputFormat } : {}),
        ...(systemPrompt ? { systemPrompt } : {}),
        ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
        ...(this.#options.agents ? { agents: this.#options.agents } : {}),
        ...(this.#options.promptSuggestions != null
          ? { promptSuggestions: this.#options.promptSuggestions }
          : {}),
        ...(this.#options.agentProgressSummaries != null
          ? { agentProgressSummaries: this.#options.agentProgressSummaries }
          : {}),
      },
      60_000,
    );

    this.#initializationResponse = response as unknown as SDKControlInitializeResponse;
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
    const response = await this.#sendControlRequest({ subtype: "mcp_status" });
    return (response.mcpServers as McpServerStatus[] | undefined) ?? [];
  }

  async getContextUsage(): Promise<SDKControlGetContextUsageResponse> {
    await this.#ready();
    return (await this.#sendControlRequest({
      subtype: "get_context_usage",
    })) as unknown as SDKControlGetContextUsageResponse;
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

    return (await this.#sendControlRequest({
      subtype: "mcp_set_servers",
      servers: { ...processServers, ...sdkStubs } as Record<string, McpServerConfig>,
    })) as unknown as McpSetServersResult;
  }

  async reloadPlugins(): Promise<SDKControlReloadPluginsResponse> {
    await this.#ready();
    return (await this.#sendControlRequest({
      subtype: "reload_plugins",
    })) as unknown as SDKControlReloadPluginsResponse;
  }

  async accountInfo(): Promise<AccountInfo> {
    return (await this.initializationResult()).account ?? {};
  }

  async rewindFiles(
    userMessageId: string,
    options?: RewindFilesOptions,
  ): Promise<RewindFilesResult> {
    await this.#ready();
    return (await this.#sendControlRequest({
      subtype: "rewind_files",
      user_message_id: userMessageId,
      ...(options?.dryRun != null ? { dry_run: options.dryRun } : {}),
    })) as unknown as RewindFilesResult;
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

  close(error?: unknown): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const abortController of this.#inflightControlRequests.values()) {
      abortController.abort();
    }
    for (const { reject, timer } of this.#pendingControls.values()) {
      clearTimeout(timer as number);
      if (error instanceof Error) {
        reject(error);
      } else {
        reject(new CLIConnectionError(typeof error === "string" ? error : "Query closed"));
      }
    }
    this.#pendingControls.clear();

    const closeError =
      error instanceof Error
        ? error
        : new CLIConnectionError(typeof error === "string" ? error : "Query closed");
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
    } catch (error) {
      this.#markFirstResult();
      this.#queue.fail(error);
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

  async #sendControlRequest(
    request: SDKControlRequestInner,
    timeoutMs = 30_000,
  ): Promise<Record<string, unknown>> {
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
    return responsePromise;
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
        const elicitationRequest: ElicitationRequest = {
          serverName: request.mcp_server_name,
          message: request.message,
          ...(request.mode ? { mode: request.mode } : {}),
          ...(request.url ? { url: request.url } : {}),
          ...(request.elicitation_id ? { elicitationId: request.elicitation_id } : {}),
          ...(request.requested_schema ? { requestedSchema: request.requested_schema } : {}),
        };

        if (this.#options.onElicitation) {
          return (await this.#options.onElicitation(elicitationRequest, {
            signal,
          })) as unknown as Record<string, unknown>;
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

  async #connectSdkMcpBridges(): Promise<void> {
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
        }
      }
    }
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
            const request = {
              serverName: name,
              message: String(params.message ?? ""),
              ...(params.mode ? { mode: params.mode as "form" | "url" } : {}),
              ...(params.url ? { url: String(params.url) } : {}),
              ...(params.elicitationId ? { elicitationId: String(params.elicitationId) } : {}),
              ...(params.requestedSchema
                ? { requestedSchema: params.requestedSchema as Record<string, unknown> }
                : {}),
            };
            return (await this.#options.onElicitation!(request, {
              signal: AbortSignal.timeout(30_000),
            })) as unknown as Record<string, unknown>;
          }
        : undefined,
    );
    this.#sdkMcpBridges.set(name, bridge);
    try {
      await mcpServer.connect(bridge);
    } catch {
      this.#sdkMcpBridges.delete(name);
      this.#sdkMcpServers.delete(name);
      throw new CLIConnectionError(`Failed to connect SDK MCP server: ${name}`);
    }
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

export function query(params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query {
  const options = params.options ?? {};
  const transport = new SubprocessCLITransport(options);
  const controller = new QueryController({ transport, options });

  const startupPromise = (async () => {
    await transport.connect();
    void controller.start();
    await controller.initialize();
  })();

  controller.setStartupPromise(startupPromise);

  const sendPrompt = async (): Promise<void> => {
    await startupPromise;

    if (typeof params.prompt === "string") {
      const message = createUserPromptMessage(params.prompt, options.sessionId ?? "");
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

export async function collectUntilResult(controller: Query): Promise<SDKResultMessage> {
  for await (const message of controller) {
    if (message.type === "result") {
      return message as SDKResultMessage;
    }
  }
  throw new CLIConnectionError("No result message was received");
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
