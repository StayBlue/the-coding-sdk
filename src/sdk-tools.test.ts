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
import { z } from "zod";
import { createSdkMcpServer, dispatchSdkMcpRequest, tool } from "./sdk-tools.ts";

test("sdk MCP server lists tools and handles calls", async () => {
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
    {
      searchHint: "greeting",
    },
  );

  const server = createSdkMcpServer({
    name: "test-tools",
    version: "1.0.0",
    tools: [greet],
    alwaysLoad: true,
  });

  const listed = await dispatchSdkMcpRequest(server.instance, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  });

  expect(listed).toEqual({
    jsonrpc: "2.0",
    id: 1,
    result: {
      tools: [
        expect.objectContaining({
          name: "greet",
          description: "Greet someone",
          _meta: {
            "anthropic/alwaysLoad": true,
            "anthropic/searchHint": "greeting",
          },
        }),
      ],
    },
  });

  const called = await dispatchSdkMcpRequest(server.instance, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "greet",
      arguments: {
        name: "Ada",
      },
    },
  });

  expect(called).toEqual({
    jsonrpc: "2.0",
    id: 2,
    result: {
      content: [
        {
          type: "text",
          text: "hello Ada",
        },
      ],
    },
  });
});

test("sdk MCP server handles initialize, initialized notification, and unknown methods", async () => {
  const server = createSdkMcpServer({
    name: "test-tools",
    version: "1.2.3",
  });

  const initialized = await dispatchSdkMcpRequest(server.instance, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
  });

  expect(initialized).toEqual({
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: "test-tools",
        version: "1.2.3",
      },
    },
  });

  const notification = await dispatchSdkMcpRequest(server.instance, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });

  expect(notification).toEqual({
    jsonrpc: "2.0",
    result: {},
  });

  const unknown = await dispatchSdkMcpRequest(server.instance, {
    jsonrpc: "2.0",
    id: 2,
    method: "resources/list",
  });

  expect(unknown).toEqual({
    jsonrpc: "2.0",
    id: 2,
    error: {
      code: -32601,
      message: "Method 'resources/list' not found",
    },
  });
});
