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
import {
  parseJsonLine,
  parseMcpElicitationCreateRequest,
  parseRecordUnknown,
  parseSDKControlRequestInner,
  parseStdoutMessage,
} from "./schemas.ts";

// ── parseJsonLine ──────────────────────────────────────────────────────────

test("parseJsonLine returns parsed value when JSON matches schema", () => {
  const schema = z.object({ type: z.string(), value: z.number() });
  const result = parseJsonLine(schema, '{"type":"ping","value":42}');
  expect(result).toEqual({ type: "ping", value: 42 });
});

test("parseJsonLine returns undefined for malformed JSON", () => {
  const schema = z.object({ type: z.string() });
  expect(parseJsonLine(schema, "not json at all")).toBeUndefined();
  expect(parseJsonLine(schema, "{broken")).toBeUndefined();
});

test("parseJsonLine returns undefined when JSON does not match schema", () => {
  const schema = z.object({ type: z.string(), count: z.number() });
  // count is missing
  expect(parseJsonLine(schema, '{"type":"ping"}')).toBeUndefined();
  // count is wrong type
  expect(parseJsonLine(schema, '{"type":"ping","count":"oops"}')).toBeUndefined();
});

// ── parseSDKControlRequestInner ────────────────────────────────────────────

test("parseSDKControlRequestInner parses initialize subtype", () => {
  const result = parseSDKControlRequestInner({
    subtype: "initialize",
    systemPrompt: ["Static prompt", "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__", "Dynamic prompt"],
    excludeDynamicSections: true,
    title: "Warm thread",
  });
  expect(result?.subtype).toBe("initialize");
  expect((result as { systemPrompt?: string[] }).systemPrompt).toEqual([
    "Static prompt",
    "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__",
    "Dynamic prompt",
  ]);
  expect((result as { excludeDynamicSections?: boolean }).excludeDynamicSections).toBe(true);
  expect((result as { title?: string }).title).toBe("Warm thread");
});

test("parseSDKControlRequestInner parses can_use_tool subtype", () => {
  const result = parseSDKControlRequestInner({
    subtype: "can_use_tool",
    tool_name: "Bash",
    input: { command: "ls" },
    tool_use_id: "tool-abc",
  });
  expect(result?.subtype).toBe("can_use_tool");
});

test("parseSDKControlRequestInner parses mcp_message subtype", () => {
  const result = parseSDKControlRequestInner({
    subtype: "mcp_message",
    server_name: "my-server",
    message: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });
  expect(result?.subtype).toBe("mcp_message");
});

test("parseSDKControlRequestInner parses hook_callback subtype", () => {
  const result = parseSDKControlRequestInner({
    subtype: "hook_callback",
    callback_id: "cb-1",
    input: { hook_event_name: "Notification" },
  });
  expect(result?.subtype).toBe("hook_callback");
});

test("parseSDKControlRequestInner parses elicitation metadata fields", () => {
  const result = parseSDKControlRequestInner({
    subtype: "elicitation",
    mcp_server_name: "forms",
    message: "Please fill in the form.",
    title: "Contact details",
    display_name: "Contact form",
    description: "Used for follow-up.",
  });

  expect(result).toEqual(
    expect.objectContaining({
      subtype: "elicitation",
      title: "Contact details",
      display_name: "Contact form",
      description: "Used for follow-up.",
    }),
  );
});

test("parseSDKControlRequestInner parses set_permission_mode subtype", () => {
  const result = parseSDKControlRequestInner({
    subtype: "set_permission_mode",
    mode: "bypassPermissions",
  });
  expect(result?.subtype).toBe("set_permission_mode");
});

test("parseSDKControlRequestInner returns undefined for unknown subtype", () => {
  expect(parseSDKControlRequestInner({ subtype: "unknown_type" })).toBeUndefined();
  expect(parseSDKControlRequestInner(null)).toBeUndefined();
  expect(parseSDKControlRequestInner("not an object")).toBeUndefined();
});

// ── parseStdoutMessage ─────────────────────────────────────────────────────

test("parseStdoutMessage parses an assistant message", () => {
  const raw = JSON.stringify({
    type: "assistant",
    uuid: "uuid-1",
    session_id: "sess-1",
    message: { role: "assistant", content: [] },
    parent_tool_use_id: null,
  });
  const result = parseStdoutMessage(raw);
  expect(result?.type).toBe("assistant");
});

test("parseStdoutMessage parses a control_response (result-like) message", () => {
  const raw = JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "req-1",
      response: {},
    },
  });
  const result = parseStdoutMessage(raw);
  expect(result?.type).toBe("control_response");
});

test("parseStdoutMessage returns undefined for non-JSON input", () => {
  expect(parseStdoutMessage("not json")).toBeUndefined();
});

test("parseStdoutMessage returns undefined when type field is missing", () => {
  expect(parseStdoutMessage('{"no_type_field":true}')).toBeUndefined();
});

// ── parseMcpElicitationCreateRequest ──────────────────────────────────────

test("parseMcpElicitationCreateRequest parses a valid elicitation/create request", () => {
  const raw = {
    method: "elicitation/create" as const,
    id: "req-42",
    params: { message: "Please fill in the form." },
  };
  const result = parseMcpElicitationCreateRequest(raw);
  expect(result).toEqual(raw);
  expect(result?.method).toBe("elicitation/create");
  expect(result?.id).toBe("req-42");
});

test("parseMcpElicitationCreateRequest works with numeric id", () => {
  const result = parseMcpElicitationCreateRequest({ method: "elicitation/create", id: 7 });
  expect(result?.id).toBe(7);
});

test("parseMcpElicitationCreateRequest returns undefined for non-elicitation method", () => {
  expect(parseMcpElicitationCreateRequest({ method: "tools/list", id: 1 })).toBeUndefined();
});

test("parseMcpElicitationCreateRequest returns undefined when id is missing", () => {
  expect(parseMcpElicitationCreateRequest({ method: "elicitation/create" })).toBeUndefined();
});

// ── parseRecordUnknown ─────────────────────────────────────────────────────

test("parseRecordUnknown accepts a plain object", () => {
  const input = { foo: "bar", count: 42, nested: { ok: true } };
  expect(parseRecordUnknown(input)).toEqual(input);
});

test("parseRecordUnknown accepts an empty object", () => {
  expect(parseRecordUnknown({})).toEqual({});
});

test("parseRecordUnknown returns undefined for non-objects", () => {
  expect(parseRecordUnknown(null)).toBeUndefined();
  expect(parseRecordUnknown(42)).toBeUndefined();
  expect(parseRecordUnknown("string")).toBeUndefined();
  expect(parseRecordUnknown([1, 2, 3])).toBeUndefined();
});
