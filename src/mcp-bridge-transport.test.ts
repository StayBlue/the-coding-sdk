/*
 * Copyright 2026 StayBlue
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { expect, test } from "bun:test";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { McpBridgeTransport } from "./mcp-bridge-transport.ts";

function makeElicitationRequest(
  id: string | number = 1,
  params?: Record<string, unknown>,
): JSONRPCMessage {
  return {
    jsonrpc: "2.0",
    id,
    method: "elicitation/create",
    ...(params !== undefined ? { params } : {}),
  } as JSONRPCMessage;
}

test("no handler → elicitation/create responds with decline", async () => {
  const transport = new McpBridgeTransport(() => {});
  const received: JSONRPCMessage[] = [];
  transport.onmessage = (msg) => received.push(msg);

  await transport.send(makeElicitationRequest(42));

  // Give the microtask queue a chance to flush
  await Promise.resolve();

  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({ jsonrpc: "2.0", id: 42, result: { action: "decline" } });
});

test("handler success → result forwarded as JSON-RPC response", async () => {
  const handlerResult = { action: "accept", content: { name: "Alice" } };
  const transport = new McpBridgeTransport(
    () => {},
    async (_params) => handlerResult,
  );
  const received: JSONRPCMessage[] = [];
  transport.onmessage = (msg) => received.push(msg);

  await transport.send(makeElicitationRequest("req-1", { schema: {} }));
  await Promise.resolve();

  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({ jsonrpc: "2.0", id: "req-1", result: handlerResult });
});

test("handler throws → responds with cancel", async () => {
  const transport = new McpBridgeTransport(
    () => {},
    async () => {
      throw new Error("handler exploded");
    },
  );
  const received: JSONRPCMessage[] = [];
  transport.onmessage = (msg) => received.push(msg);

  await transport.send(makeElicitationRequest(7));
  await Promise.resolve();

  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({ jsonrpc: "2.0", id: 7, result: { action: "cancel" } });
});

test("normal messages are forwarded via sendToCli", async () => {
  const sent: JSONRPCMessage[] = [];
  const transport = new McpBridgeTransport((msg) => sent.push(msg));

  const normalMsg = { jsonrpc: "2.0", id: 1, method: "tools/list" } as JSONRPCMessage;
  await transport.send(normalMsg);

  expect(sent).toHaveLength(1);
  expect(sent[0]).toBe(normalMsg);
});

test("send() throws after close()", async () => {
  const transport = new McpBridgeTransport(() => {});
  await transport.close();

  await expect(
    transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list" } as JSONRPCMessage),
  ).rejects.toThrow("Transport is closed");
});

test("handleInbound() triggers onmessage", () => {
  const transport = new McpBridgeTransport(() => {});
  const received: JSONRPCMessage[] = [];
  transport.onmessage = (msg) => received.push(msg);

  const inbound = { jsonrpc: "2.0", id: 99, result: { ok: true } } as JSONRPCMessage;
  transport.handleInbound(inbound);

  expect(received).toHaveLength(1);
  expect(received[0]).toBe(inbound);
});
