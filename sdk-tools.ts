/*
 * This file incorporates material from claude-agent-sdk-python, licensed under
 * the MIT License:
 *
 * Copyright (c) 2025 Anthropic, PBC
 *
 * Modifications Copyright 2026 StayBlue, licensed under the Apache License,
 * Version 2.0. See the LICENSE file in the project root for details.
 */

/**
 * Entry point for building MCP tools and servers that integrate with the SDK.
 *
 * @module
 */
export { createSdkMcpServer, tool } from "./src/sdk-tools.ts";
export type {
  McpSdkServerConfig,
  McpSdkServerConfigWithInstance,
  SdkMcpToolDefinition,
} from "./src/types.ts";
