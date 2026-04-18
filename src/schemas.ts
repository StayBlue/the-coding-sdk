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

import { z } from "zod";

import type { SDKControlRequestInner, StdoutMessage } from "./types.ts";

const zRecordUnknown = z.record(z.string(), z.unknown());
const zJsonRpcMessageId = z.union([z.string(), z.number()]);
const zJsonRpcMessageIdOrNull = z.union([z.string(), z.number(), z.null()]);

function parseWithSchema<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  const result = schema.safeParse(value);
  return result.success ? result.data : undefined;
}

export function parseJsonLine<T>(schema: z.ZodType<T>, raw: string): T | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return parseWithSchema(schema, parsed);
}

export const TranscriptEntrySchema = z
  .object({
    uuid: z.string(),
    type: z.unknown().optional(),
    parentUuid: z.string().optional(),
    sessionId: z.string().optional(),
    message: z.unknown().optional(),
    isMeta: z.unknown().optional(),
    isSidechain: z.unknown().optional(),
    teamName: z.unknown().optional(),
  })
  .passthrough();

export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;

export function parseTranscriptEntry(raw: string): TranscriptEntry | undefined {
  return parseJsonLine(TranscriptEntrySchema, raw);
}

const zStdoutMessage = z.object({ type: z.string() }).passthrough();

export function parseStdoutMessage(raw: string): StdoutMessage | undefined {
  return parseJsonLine(zStdoutMessage as z.ZodType<StdoutMessage>, raw);
}

const zJsonRpcMessage = z
  .object({
    jsonrpc: z.string().optional(),
    id: zJsonRpcMessageIdOrNull.optional(),
    method: z.string().optional(),
    params: z.unknown().optional(),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();

export type ParsedJSONRPCMessage = z.infer<typeof zJsonRpcMessage>;

export function parseJSONRPCMessage(raw: unknown): ParsedJSONRPCMessage | undefined {
  return parseWithSchema(zJsonRpcMessage, raw);
}

export function parseJSONRPCMessageId(raw: unknown): string | number | undefined {
  return parseWithSchema(zJsonRpcMessageId, raw);
}

export function parseRecordUnknown(raw: unknown): Record<string, unknown> | undefined {
  return parseWithSchema(zRecordUnknown, raw);
}

const zHookConfig = z.object({
  matcher: z.string().optional(),
  hookCallbackIds: z.array(z.string()),
  timeout: z.number().optional(),
});

const zInitializeControlRequest = z.object({
  subtype: z.literal("initialize"),
  hooks: z.record(z.string(), z.array(zHookConfig)).optional(),
  sdkMcpServers: z.array(z.string()).optional(),
  jsonSchema: zRecordUnknown.optional(),
  systemPrompt: z.union([z.string(), z.array(z.string())]).optional(),
  appendSystemPrompt: z.string().optional(),
  excludeDynamicSections: z.boolean().optional(),
  agents: z.record(z.string(), z.unknown()).optional(),
  title: z.string().optional(),
  promptSuggestions: z.boolean().optional(),
  agentProgressSummaries: z.boolean().optional(),
});

const zCanUseToolRequest = z.object({
  subtype: z.literal("can_use_tool"),
  tool_name: z.string(),
  input: zRecordUnknown,
  permission_suggestions: z.array(z.unknown()).optional(),
  blocked_path: z.string().optional(),
  decision_reason: z.string().optional(),
  title: z.string().optional(),
  display_name: z.string().optional(),
  description: z.string().optional(),
  tool_use_id: z.string(),
  agent_id: z.string().optional(),
});

const zHookCallbackRequest = z.object({
  subtype: z.literal("hook_callback"),
  callback_id: z.string(),
  input: zRecordUnknown,
  tool_use_id: z.string().optional(),
});

const zMcpMessageRequest = z.object({
  subtype: z.literal("mcp_message"),
  server_name: z.string(),
  message: zJsonRpcMessage,
});

const zElicitationRequest = z.object({
  subtype: z.literal("elicitation"),
  mcp_server_name: z.string(),
  message: z.string(),
  mode: z.union([z.literal("form"), z.literal("url")]).optional(),
  url: z.string().optional(),
  elicitation_id: z.string().optional(),
  requested_schema: zRecordUnknown.optional(),
  title: z.string().optional(),
  display_name: z.string().optional(),
  description: z.string().optional(),
});

const zPermissionMode = z.union([
  z.literal("default"),
  z.literal("acceptEdits"),
  z.literal("bypassPermissions"),
  z.literal("plan"),
  z.literal("dontAsk"),
  z.literal("auto"),
]);

const zControlRequestInnerSchema = z.discriminatedUnion("subtype", [
  zInitializeControlRequest,
  z.object({ subtype: z.literal("interrupt") }),
  zMcpMessageRequest,
  z.object({ subtype: z.literal("mcp_reconnect"), serverName: z.string() }),
  z.object({ subtype: z.literal("mcp_status") }),
  z.object({ subtype: z.literal("mcp_toggle"), serverName: z.string(), enabled: z.boolean() }),
  zCanUseToolRequest,
  z.object({
    subtype: z.literal("rewind_files"),
    user_message_id: z.string(),
    dry_run: z.boolean().optional(),
  }),
  z.object({ subtype: z.literal("set_model"), model: z.string().optional() }),
  z.object({ subtype: z.literal("set_permission_mode"), mode: zPermissionMode }),
  z.object({ subtype: z.literal("stop_task"), task_id: z.string() }),
  zHookCallbackRequest,
  z.object({ subtype: z.literal("get_context_usage") }),
  zElicitationRequest,
  z.object({
    subtype: z.literal("mcp_set_servers"),
    servers: z.record(z.string(), z.unknown()),
  }),
  z.object({ subtype: z.literal("reload_plugins") }),
]);

export function parseSDKControlRequestInner(raw: unknown): SDKControlRequestInner | undefined {
  return parseWithSchema(zControlRequestInnerSchema, raw) as SDKControlRequestInner | undefined;
}

export const zToolsCallParamsSchema = z
  .object({
    name: z.string(),
    arguments: zRecordUnknown.optional(),
  })
  .passthrough();

const zMcpElicitationCreateRequest = z.object({
  method: z.literal("elicitation/create"),
  id: zJsonRpcMessageId,
  params: z.unknown().optional(),
});

export type McpElicitationCreateRequest = z.infer<typeof zMcpElicitationCreateRequest>;

export function parseMcpElicitationCreateRequest(
  raw: unknown,
): McpElicitationCreateRequest | undefined {
  return parseWithSchema(zMcpElicitationCreateRequest, raw);
}
