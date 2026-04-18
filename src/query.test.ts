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
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { QueryController, createUserPromptMessage, query, startup } from "./query.ts";
import { createSdkMcpServer, tool } from "./sdk-tools.ts";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { HookInput, SpawnedProcess, StdoutMessage, Transport } from "./types.ts";
import { z } from "zod";

function createPromptFailureProcess(): {
  process: SpawnedProcess;
  writes: string[];
  finish: () => void;
} {
  const emitter = new EventEmitter();
  const stdout = new Readable({ read() {} });
  const writes: string[] = [];
  let isInitialized = false;
  let exitCode: number | null = 0;

  const stdin = {
    write(chunk: string | Buffer, callback: (error?: Error | null) => void) {
      const payload = chunk.toString();
      writes.push(payload);
      try {
        const message = JSON.parse(payload);

        if (message.type === "control_request" && message.request?.subtype === "initialize") {
          const response = {
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
          };
          stdout.push(`${JSON.stringify(response)}\n`);
          isInitialized = true;
          callback();
          return;
        }

        if (isInitialized) {
          callback(new Error("prompt write failure"));
          return;
        }

        callback();
      } catch {
        callback();
      }
    },
    end() {},
  } as NodeJS.WritableStream;

  const proc: SpawnedProcess = {
    stdin,
    stdout,
    killed: false,
    get exitCode() {
      return exitCode;
    },
    kill() {
      exitCode = 0;
      (proc as { killed: boolean }).killed = true;
      emitter.emit("exit", exitCode, null);
      return true;
    },
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    off: emitter.off.bind(emitter),
  };

  return {
    process: proc,
    writes,
    finish() {
      stdout.push(null);
      exitCode = 0;
      emitter.emit("exit", exitCode, null);
    },
  };
}

function createWarmQueryProcess(): {
  process: SpawnedProcess;
  writes: string[];
} {
  const emitter = new EventEmitter();
  const stdout = new Readable({ read() {} });
  const writes: string[] = [];
  let exitCode: number | null = null;

  const finish = () => {
    if (exitCode != null) {
      return;
    }
    stdout.push(null);
    exitCode = 0;
    emitter.emit("exit", exitCode, null);
  };

  const stdin = {
    write(chunk: string | Buffer, callback: (error?: Error | null) => void) {
      const payload = chunk.toString();
      writes.push(payload);

      try {
        const message = JSON.parse(payload);
        if (message.type === "control_request" && message.request?.subtype === "initialize") {
          stdout.push(
            `${JSON.stringify({
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
            })}\n`,
          );
          callback();
          return;
        }

        if (message.type === "user") {
          stdout.push(
            `${JSON.stringify({
              type: "result",
              uuid: "result-1",
              session_id: "warm-session",
            })}\n`,
          );
          callback();
          queueMicrotask(finish);
          return;
        }
      } catch {
        // Ignore non-JSON writes in the fake process.
      }

      callback();
    },
    end() {
      finish();
    },
  } as NodeJS.WritableStream;

  const proc: SpawnedProcess = {
    stdin,
    stdout,
    killed: false,
    get exitCode() {
      return exitCode;
    },
    kill() {
      (proc as { killed: boolean }).killed = true;
      finish();
      return true;
    },
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    off: emitter.off.bind(emitter),
  };

  return { process: proc, writes };
}

class MockTransport implements Transport {
  writes: string[] = [];
  endInputCalls = 0;
  #messages: StdoutMessage[] = [];
  #waiters: Array<() => void> = [];
  #closed = false;

  onWrite?: (data: string) => void | Promise<void>;

  enqueue(message: StdoutMessage): void {
    this.#messages.push(message);
    this.#waiters.shift()?.();
  }

  finish(): void {
    this.#closed = true;
    this.#waiters.shift()?.();
  }

  async write(data: string): Promise<void> {
    this.writes.push(data);
    await this.onWrite?.(data);
  }

  close(): void {
    this.finish();
  }

  isReady(): boolean {
    return true;
  }

  endInput(): void {
    this.endInputCalls += 1;
  }

  async *readMessages(): AsyncGenerator<StdoutMessage, void, unknown> {
    while (!this.#closed || this.#messages.length > 0) {
      if (this.#messages.length === 0) {
        await new Promise<void>((resolve) => {
          this.#waiters.push(resolve);
        });
        continue;
      }
      yield this.#messages.shift() as StdoutMessage;
    }
  }
}

test("createUserPromptMessage defaults to an empty session id", () => {
  expect(createUserPromptMessage("hello")).toEqual({
    type: "user",
    message: {
      role: "user",
      content: "hello",
    },
    parent_tool_use_id: null,
    session_id: "",
  });

  expect(createUserPromptMessage("hello", "session-123").session_id).toBe("session-123");
});

test("query controller fulfills can_use_tool requests", async () => {
  const transport = new MockTransport();
  const seen: Record<string, unknown> = {};

  transport.enqueue({
    type: "control_request",
    request_id: "req-1",
    request: {
      subtype: "can_use_tool",
      tool_name: "Bash",
      input: {
        command: "touch /tmp/demo.txt",
      },
      permission_suggestions: [],
      tool_use_id: "tool-1",
      agent_id: "agent-1",
    },
  });
  transport.finish();

  const controller = new QueryController({
    transport,
    options: {
      canUseTool: async (toolName, input, options) => {
        seen.toolName = toolName;
        seen.input = input;
        seen.toolUseID = options.toolUseID;
        seen.agentID = options.agentID;
        return {
          behavior: "allow",
          updatedInput: {
            ...input,
            safe_mode: true,
          },
        };
      },
    },
  });

  await controller.start();

  expect(seen).toEqual({
    toolName: "Bash",
    input: {
      command: "touch /tmp/demo.txt",
    },
    toolUseID: "tool-1",
    agentID: "agent-1",
  });

  expect(JSON.parse(transport.writes[0] as string)).toEqual({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "req-1",
      response: {
        behavior: "allow",
        updatedInput: {
          command: "touch /tmp/demo.txt",
          safe_mode: true,
        },
      },
    },
  });
});

test("query controller fulfills hook callbacks after initialize", async () => {
  const transport = new MockTransport();
  let callbackId = "";
  let hookResponse: Record<string, unknown> | undefined;
  let resolveHookResponse: (() => void) | undefined;

  const hookResponsePromise = new Promise<void>((resolve) => {
    resolveHookResponse = resolve;
  });

  transport.onWrite = async (data) => {
    const message = JSON.parse(data) as {
      type?: string;
      request_id?: string;
      request?: {
        subtype?: string;
        hooks?: {
          Notification?: Array<{
            hookCallbackIds?: string[];
          }>;
        };
      };
      response?: {
        request_id?: string;
      };
    };

    if (message.type === "control_request" && message.request?.subtype === "initialize") {
      callbackId = message.request.hooks?.Notification?.[0]?.hookCallbackIds?.[0] ?? "";
      transport.enqueue({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: message.request_id ?? "",
          response: {
            commands: [],
            agents: [],
            output_style: "default",
            available_output_styles: [],
            models: [],
            account: {},
          },
        },
      });
      return;
    }

    if (message.type === "control_response" && message.response?.request_id === "hook-1") {
      hookResponse = message;
      resolveHookResponse?.();
    }
  };

  const controller = new QueryController({
    transport,
    options: {
      hooks: {
        Notification: [
          {
            hooks: [
              async (input: HookInput) => ({
                reason: `handled:${input.hook_event_name}`,
              }),
            ],
          },
        ],
      },
    },
  });

  const startPromise = controller.start();
  await controller.initialize();

  transport.enqueue({
    type: "control_request",
    request_id: "hook-1",
    request: {
      subtype: "hook_callback",
      callback_id: callbackId,
      input: {
        hook_event_name: "Notification",
        session_id: "session-1",
        transcript_path: "/tmp/transcript.jsonl",
        cwd: "/tmp",
        message: "Heads up",
        notification_type: "info",
      },
    },
  });

  await hookResponsePromise;
  transport.finish();
  await startPromise;

  expect(hookResponse).toEqual({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "hook-1",
      response: {
        reason: "handled:Notification",
      },
    },
  });
});

test("query controller delegates SDK MCP control requests and rejects unsupported inbound requests", async () => {
  const greet = tool(
    "greet",
    "Greet someone",
    {
      name: z.string(),
    },
    async (args) => ({
      content: [
        {
          type: "text",
          text: `hello ${args.name}`,
        },
      ],
    }),
  );

  const server = createSdkMcpServer({
    name: "test-tools",
    tools: [greet],
  });

  const transport = new MockTransport();
  transport.enqueue({
    type: "control_request",
    request_id: "mcp-1",
    request: {
      subtype: "mcp_message",
      server_name: "tools",
      message: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "greet",
          arguments: {
            name: "Ada",
          },
        },
      },
    },
  });
  transport.enqueue({
    type: "control_request",
    request_id: "bad-1",
    request: {
      subtype: "interrupt",
    },
  } as StdoutMessage);
  transport.finish();

  const controller = new QueryController({
    transport,
    options: {
      mcpServers: {
        tools: server,
      },
    },
  });

  await controller.start();

  expect(JSON.parse(transport.writes[0] as string)).toEqual({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "mcp-1",
      response: {
        mcp_response: {
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [
              {
                type: "text",
                text: "hello Ada",
              },
            ],
          },
        },
      },
    },
  });

  expect(JSON.parse(transport.writes[1] as string)).toEqual({
    type: "control_response",
    response: {
      subtype: "error",
      request_id: "bad-1",
      error: "Unsupported control request subtype: interrupt",
    },
  });
});

test("query controller returns empty success payload for bridged MCP notifications", async () => {
  const transport = new MockTransport();
  let bridgeTransport:
    | {
        onmessage?: (message: JSONRPCMessage) => void;
      }
    | undefined;

  transport.onWrite = async (data) => {
    const message = JSON.parse(data) as {
      type?: string;
      request_id?: string;
      request?: {
        subtype?: string;
      };
    };

    if (message.type === "control_request" && message.request?.subtype === "initialize") {
      transport.enqueue({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: message.request_id ?? "",
          response: {
            commands: [],
            agents: [],
            output_style: "default",
            available_output_styles: [],
            models: [],
            account: {},
          },
        },
      });
    }
  };

  const controller = new QueryController({
    transport,
    options: {
      mcpServers: {
        tools: {
          type: "sdk",
          name: "tools",
          instance: {
            name: "tools",
            tools: [],
            async connect(bridge: { onmessage?: (message: JSONRPCMessage) => void }) {
              bridgeTransport = bridge;
            },
          },
        } as never,
      },
    },
  });

  const startPromise = controller.start();
  await controller.initialize();
  expect(bridgeTransport).toBeDefined();

  transport.enqueue({
    type: "control_request",
    request_id: "notify-1",
    request: {
      subtype: "mcp_message",
      server_name: "tools",
      message: {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      },
    },
  });
  transport.finish();
  await startPromise;

  const responses = transport.writes
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((message) => message.type === "control_response");

  expect(responses as unknown[]).toContainEqual({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "notify-1",
      response: {},
    },
  });
});

test("query controller enriches bridged MCP initialize capabilities for elicitation", async () => {
  const transport = new MockTransport();
  let seenInitialize: JSONRPCMessage | undefined;

  transport.onWrite = async (data) => {
    const message = JSON.parse(data) as {
      type?: string;
      request_id?: string;
      request?: {
        subtype?: string;
      };
    };

    if (message.type === "control_request" && message.request?.subtype === "initialize") {
      transport.enqueue({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: message.request_id ?? "",
          response: {
            commands: [],
            agents: [],
            output_style: "default",
            available_output_styles: [],
            models: [],
            account: {},
          },
        },
      });
    }
  };

  const controller = new QueryController({
    transport,
    options: {
      mcpServers: {
        tools: {
          type: "sdk",
          name: "tools",
          instance: {
            name: "tools",
            tools: [],
            async connect(bridge: {
              send(message: JSONRPCMessage): Promise<void>;
              onmessage?: (message: JSONRPCMessage) => void;
            }) {
              bridge.onmessage = (message) => {
                seenInitialize = message;
                void bridge.send({
                  jsonrpc: "2.0",
                  id: 1,
                  result: { ok: true },
                } as JSONRPCMessage);
              };
            },
          },
        } as never,
      },
    },
  });

  const startPromise = controller.start();
  await controller.initialize();

  transport.enqueue({
    type: "control_request",
    request_id: "init-bridge-1",
    request: {
      subtype: "mcp_message",
      server_name: "tools",
      message: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          capabilities: {},
        },
      },
    },
  });
  transport.finish();
  await startPromise;

  expect(seenInitialize).toEqual({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      capabilities: {
        elicitation: {},
      },
    },
  });
});

test("query controller differentiates bridged MCP replies from internally correlated responses", async () => {
  const transport = new MockTransport();

  transport.onWrite = async (data) => {
    const message = JSON.parse(data) as {
      type?: string;
      request_id?: string;
      request?: {
        subtype?: string;
      };
    };

    if (message.type === "control_request" && message.request?.subtype === "initialize") {
      transport.enqueue({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: message.request_id ?? "",
          response: {
            commands: [],
            agents: [],
            output_style: "default",
            available_output_styles: [],
            models: [],
            account: {},
          },
        },
      });
    }
  };

  const controller = new QueryController({
    transport,
    options: {
      mcpServers: {
        tools: {
          type: "sdk",
          name: "tools",
          instance: {
            name: "tools",
            tools: [],
            async connect(_bridge: { onmessage?: (message: JSONRPCMessage) => void }) {},
          },
        } as never,
      },
    },
  });

  const startPromise = controller.start();
  await controller.initialize();

  transport.enqueue({
    type: "control_request",
    request_id: "mcp-request",
    request: {
      subtype: "mcp_message",
      server_name: "tools",
      message: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      },
    },
  });
  transport.enqueue({
    type: "control_request",
    request_id: "mcp-result",
    request: {
      subtype: "mcp_message",
      server_name: "tools",
      message: {
        jsonrpc: "2.0",
        id: 1,
        result: {
          tools: [],
        },
      },
    },
  });

  transport.finish();
  await startPromise;

  const responses = transport.writes
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((message) => message.type === "control_response");

  expect(responses as unknown[]).toContainEqual({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "mcp-request",
      response: {
        mcp_response: {
          jsonrpc: "2.0",
          id: 1,
          result: {
            tools: [],
          },
        },
      },
    },
  });

  expect(responses as unknown[]).toContainEqual({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "mcp-result",
      response: {},
    },
  });
});

test("query controller forwards bridged MCP outbound messages through control requests", async () => {
  const transport = new MockTransport();
  let bridgeTransport:
    | {
        send(message: JSONRPCMessage): Promise<void>;
        onmessage?: (message: JSONRPCMessage) => void;
      }
    | undefined;

  transport.onWrite = async (data) => {
    const message = JSON.parse(data) as {
      type?: string;
      request_id?: string;
      request?: {
        subtype?: string;
      };
    };

    if (message.type === "control_request" && message.request?.subtype === "initialize") {
      transport.enqueue({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: message.request_id ?? "",
          response: {
            commands: [],
            agents: [],
            output_style: "default",
            available_output_styles: [],
            models: [],
            account: {},
          },
        },
      });
    }
  };

  const controller = new QueryController({
    transport,
    options: {
      mcpServers: {
        tools: {
          type: "sdk",
          name: "tools",
          instance: {
            name: "tools",
            tools: [],
            async connect(bridge: {
              send(message: JSONRPCMessage): Promise<void>;
              onmessage?: (message: JSONRPCMessage) => void;
            }) {
              bridgeTransport = bridge;
            },
          },
        } as never,
      },
    },
  });

  const startPromise = controller.start();
  await controller.initialize();
  expect(bridgeTransport).toBeDefined();

  await bridgeTransport!.send({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/list",
  } as JSONRPCMessage);

  controller.close();
  transport.finish();
  await startPromise;

  const outbound = transport.writes
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find(
      (message) =>
        message.type === "control_request" &&
        (message.request as { subtype?: string } | undefined)?.subtype === "mcp_message",
    );

  expect(outbound).toEqual({
    type: "control_request",
    request_id: expect.any(String),
    request: {
      subtype: "mcp_message",
      server_name: "tools",
      message: {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/list",
      },
    },
  });
});

test("query controller yields known stream messages and skips unknown message types", async () => {
  const transport = new MockTransport();
  transport.enqueue({
    type: "stream_event",
    uuid: "evt-1",
    session_id: "session-1",
    event: {
      type: "content_block_delta",
    },
    parent_tool_use_id: null,
  } as StdoutMessage);
  transport.enqueue({
    type: "future_message_type",
    payload: true,
  } as unknown as StdoutMessage);
  transport.enqueue({
    type: "rate_limit_event",
    uuid: "evt-2",
    session_id: "session-1",
    rate_limit_info: {
      status: "allowed",
    },
  } as StdoutMessage);
  transport.finish();

  const controller = new QueryController({
    transport,
    options: {},
  });

  const startPromise = controller.start();
  const seen: string[] = [];

  for await (const message of controller) {
    seen.push(message.type);
  }

  await startPromise;

  expect(seen).toEqual(["stream_event", "rate_limit_event"]);
});

test("query controller mirrors transcript batches into a session store", async () => {
  const transport = new MockTransport();
  const root = "/tmp/claude-store-root";
  const entries = [
    {
      type: "user",
      uuid: "entry-1",
      message: { role: "user", content: "hello" },
    },
  ];
  const appended: Array<{ key: Record<string, string>; entries: unknown[] }> = [];

  transport.enqueue({
    type: "transcript_mirror",
    filePath: `${root}/projects/-tmp-project/session-1.jsonl`,
    entries,
  });
  transport.finish();

  const controller = new QueryController({
    transport,
    options: {
      env: { CLAUDE_CONFIG_DIR: root },
      sessionStore: {
        async append(key, batch) {
          appended.push({ key, entries: batch });
        },
        async load() {
          return null;
        },
      },
    },
  });

  await controller.start();

  expect(appended).toEqual([
    {
      key: {
        projectKey: "-tmp-project",
        sessionId: "session-1",
      },
      entries,
    },
  ]);
});

test("query controller yields mirror_error messages when session store append fails", async () => {
  const transport = new MockTransport();
  const root = "/tmp/claude-store-root";

  transport.enqueue({
    type: "transcript_mirror",
    filePath: `${root}/projects/-tmp-project/session-1.jsonl`,
    entries: [{ type: "user", uuid: "entry-1" }],
  });
  transport.finish();

  const controller = new QueryController({
    transport,
    options: {
      env: { CLAUDE_CONFIG_DIR: root },
      sessionStore: {
        async append() {
          throw new Error("store unavailable");
        },
        async load() {
          return null;
        },
      },
    },
  });

  await controller.start();
  const mirrored = await controller.next();

  expect(mirrored).toEqual({
    done: false,
    value: expect.objectContaining({
      type: "system",
      subtype: "mirror_error",
      error: "store unavailable",
      session_id: "session-1",
      key: {
        projectKey: "-tmp-project",
        sessionId: "session-1",
      },
    }),
  });
});

test("query controller sendControlRequest times out on unresponsive CLI", async () => {
  const transport = new MockTransport();
  let resolveInit: (() => void) | undefined;

  transport.onWrite = async (data) => {
    const message = JSON.parse(data) as { type?: string; request?: { subtype?: string } };
    if (message.type === "control_request" && message.request?.subtype === "initialize") {
      // Never respond — let it time out
      resolveInit?.();
    }
  };

  const controller = new QueryController({
    transport,
    options: {},
  });

  const startPromise = controller.start();

  const initPromise = new Promise<void>((resolve) => {
    resolveInit = resolve;
  });

  // Use a very short timeout to make the test fast
  const initializePromise = (
    controller as unknown as { initialize(): Promise<unknown> }
  ).initialize();

  await initPromise;

  // The initialize call uses 60s timeout by default, so close instead
  controller.close();
  await expect(initializePromise).rejects.toThrow("Query closed");

  await startPromise;
});

test("query controller close() rejects pending controls and closes transport", async () => {
  const transport = new MockTransport();
  let resolveInit: (() => void) | undefined;

  transport.onWrite = async (data) => {
    const message = JSON.parse(data) as { type?: string; request?: { subtype?: string } };
    if (message.type === "control_request" && message.request?.subtype === "initialize") {
      // Don't respond — leave the control request pending
      resolveInit?.();
    }
  };

  const controller = new QueryController({
    transport,
    options: {},
  });

  const startPromise = controller.start();

  const initPromise = new Promise<void>((resolve) => {
    resolveInit = resolve;
  });

  const initializePromise = controller.initialize();
  await initPromise;

  controller.close();

  await expect(initializePromise).rejects.toThrow("Query closed");

  await startPromise;
});

test("query() surfaces prompt write failures through iterator errors", async () => {
  const { process, finish } = createPromptFailureProcess();

  const controller = query({
    prompt: "test prompt",
    options: {
      spawnClaudeCodeProcess: () => process,
      maxTurns: 1,
    },
  });

  await controller.initializationResult();

  await expect(controller.next()).rejects.toThrow(
    "Failed to write to process stdin: prompt write failure",
  );

  finish();
});

test("startup prewarms the runtime and returns a one-shot query handle", async () => {
  const { process, writes } = createWarmQueryProcess();

  const warm = await startup({
    options: {
      pathToClaudeCodeExecutable: "/fake/claude",
      spawnClaudeCodeProcess: () => process,
    },
  });

  const controller = warm.query("hello");
  await expect(controller.next()).resolves.toEqual({
    done: false,
    value: expect.objectContaining({
      type: "result",
      session_id: "warm-session",
    }),
  });
  expect(() => warm.query("again")).toThrow("WarmQuery.query() can only be called once");

  const messageTypes = writes.map((line) => JSON.parse(line).type);
  expect(messageTypes).toEqual(["control_request", "user"]);
});

test("startup rejects string prompts when canUseTool is configured", async () => {
  const { process } = createWarmQueryProcess();
  const warm = await startup({
    options: {
      canUseTool: async () => ({ behavior: "allow" }),
      pathToClaudeCodeExecutable: "/fake/claude",
      spawnClaudeCodeProcess: () => process,
    },
  });

  expect(() => warm.query("hello")).toThrow(
    "canUseTool callback requires streaming mode. Please provide prompt as an AsyncIterable instead of a string.",
  );
  warm.close();
});
