/*
 * This file incorporates material from claude-agent-sdk-python, licensed under
 * the MIT License:
 *
 * Copyright (c) 2025 Anthropic, PBC
 *
 * Modifications Copyright 2026 StayBlue, licensed under the Apache License,
 * Version 2.0. See the LICENSE file in the project root for details.
 */

import { z } from "zod";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type {
  AnyZodRawShape,
  InferShape,
  McpSdkServerConfigWithInstance,
  SdkMcpServerInstance,
  SdkMcpToolDefinition,
} from "./types.ts";
import {
  parseJSONRPCMessage,
  parseJSONRPCMessageId,
  type ParsedJSONRPCMessage,
  zToolsCallParamsSchema,
} from "./schemas.ts";

/** Defines an SDK-native MCP tool from a Zod schema and async handler. */
export function tool<Schema extends AnyZodRawShape>(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>,
  extras?: {
    annotations?: ToolAnnotations;
    searchHint?: string;
    alwaysLoad?: boolean;
  },
): SdkMcpToolDefinition<Schema> {
  const meta: Record<string, unknown> = {};
  if (extras?.searchHint != null) {
    meta.searchHint = extras.searchHint;
  }
  if (extras?.alwaysLoad != null) {
    meta.alwaysLoad = extras.alwaysLoad;
  }

  return {
    name,
    description,
    inputSchema,
    handler,
    ...(extras?.annotations ? { annotations: extras.annotations } : {}),
    ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
  };
}

/** Creates an in-memory MCP server config that can be passed through SDK options. */
export function createSdkMcpServer(options: {
  name: string;
  version?: string;
  tools?: Array<SdkMcpToolDefinition>;
}): McpSdkServerConfigWithInstance {
  const instance: SdkMcpServerInstance = {
    name: options.name,
    tools: [...(options.tools ?? [])],
    ...(options.version ? { version: options.version } : {}),
  };

  return {
    type: "sdk",
    name: options.name,
    instance,
  };
}

export async function dispatchSdkMcpRequest(
  server: SdkMcpServerInstance,
  message: ParsedJSONRPCMessage | Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const parsedMessage = parseJSONRPCMessage(message);
  if (!parsedMessage) {
    return methodNotFound(null, "Invalid JSON-RPC message");
  }

  const method = parsedMessage.method;
  const id = parseJSONRPCMessageId(parsedMessage.id) ?? null;
  const params = parsedMessage.params ?? {};

  try {
    if (method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: {
            name: server.name,
            version: server.version ?? "1.0.0",
          },
        },
      };
    }

    if (method === "notifications/initialized") {
      return {
        jsonrpc: "2.0",
        result: {},
      };
    }

    if (method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: server.tools.map((toolDef) => ({
            name: toolDef.name,
            description: toolDef.description,
            inputSchema: shapeToJsonSchema(toolDef.inputSchema),
            annotations: toolDef.annotations,
            _meta: toolDef._meta,
          })),
        },
      };
    }

    if (method === "tools/call") {
      const parsed = zToolsCallParamsSchema.safeParse(params);
      if (!parsed.success) {
        return methodNotFound(id, "Invalid tools/call params");
      }

      const { name, arguments: callArgs } = parsed.data;
      const toolDef = server.tools.find((candidate) => candidate.name === name);
      if (!toolDef) {
        return methodNotFound(id, `Tool '${name}' not found`);
      }

      const result = await toolDef.handler(
        (callArgs ?? {}) as InferShape<typeof toolDef.inputSchema>,
        {
          serverName: server.name,
        },
      );

      return {
        jsonrpc: "2.0",
        id,
        result: normalizeCallToolResult(result),
      };
    }

    return methodNotFound(id, `Method '${method ?? ""}' not found`);
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function methodNotFound(id: string | number | null, message: string) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32601,
      message,
    },
  };
}

function normalizeCallToolResult(result: CallToolResult): Record<string, unknown> {
  const normalizedContent = (result.content ?? []).flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }

    const record = item as Record<string, unknown>;
    if (record.type === "resource_link") {
      const parts = [record.name, record.uri, record.description].filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      );
      return [
        {
          type: "text",
          text: parts.length > 0 ? parts.join("\n") : "Resource link",
        },
      ];
    }

    if (record.type === "resource") {
      const resource =
        record.resource && typeof record.resource === "object"
          ? (record.resource as Record<string, unknown>)
          : undefined;
      if (typeof resource?.text === "string") {
        return [
          {
            type: "text",
            text: resource.text,
          },
        ];
      }
      return [];
    }

    return [record];
  });

  return {
    content: normalizedContent,
    ...(result.isError ? { isError: true } : {}),
  };
}

function shapeToJsonSchema(shape: AnyZodRawShape): Record<string, unknown> {
  const objectSchema = z.object(shape);
  const withHelper = z as typeof z & {
    toJSONSchema?: (schema: z.ZodTypeAny) => unknown;
  };

  if (typeof withHelper.toJSONSchema === "function") {
    const schema = withHelper.toJSONSchema(objectSchema);
    if (schema && typeof schema === "object") {
      return schema as Record<string, unknown>;
    }
  }

  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const schema = value as z.ZodTypeAny & {
      isOptional?: () => boolean;
      unwrap?: () => z.ZodTypeAny;
    };
    const optional = typeof schema.isOptional === "function" ? schema.isOptional() : false;
    const unwrapped = optional && typeof schema.unwrap === "function" ? schema.unwrap() : schema;
    properties[key] = zodTypeToJsonSchema(unwrapped);
    if (!optional) {
      required.push(key);
    }
  }

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

// Zod v3/v4 compatibility accessors — each version uses different internal layouts
type ZodAny = z.ZodTypeAny & { _def?: Record<string, unknown> };

function zodTypeName(schema: z.ZodTypeAny): string | undefined {
  const s = schema as ZodAny;
  return (s._def?.typeName as string | undefined) ?? (s._def?.type as string | undefined);
}

function zodArrayElement(schema: z.ZodTypeAny): z.ZodTypeAny | undefined {
  return (
    (schema as z.ZodArray<z.ZodTypeAny>).element ??
    ((schema as ZodAny)._def?.type as unknown as z.ZodTypeAny | undefined)
  );
}

function zodEnumValues(schema: z.ZodTypeAny): readonly string[] {
  return (
    ((schema as ZodAny & { options?: readonly string[] }).options as
      | readonly string[]
      | undefined) ??
    ((schema as ZodAny)._def?.values as readonly string[] | undefined) ??
    []
  );
}

function zodObjectShape(schema: z.ZodTypeAny): AnyZodRawShape {
  return (
    ((schema as z.ZodObject<AnyZodRawShape>).shape as AnyZodRawShape | undefined) ??
    ((schema as ZodAny)._def?.shape as (() => AnyZodRawShape) | undefined)?.() ??
    {}
  );
}

function zodTypeToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  switch (zodTypeName(schema)) {
    case "ZodString":
    case "string":
      return { type: "string" };
    case "ZodNumber":
    case "number":
      return { type: "number" };
    case "ZodBoolean":
    case "boolean":
      return { type: "boolean" };
    case "ZodArray":
    case "array": {
      const item = zodArrayElement(schema);
      return {
        type: "array",
        items: item ? zodTypeToJsonSchema(item) : {},
      };
    }
    case "ZodEnum":
    case "enum":
      return {
        type: "string",
        enum: [...zodEnumValues(schema)],
      };
    case "ZodObject":
    case "object":
      return shapeToJsonSchema(zodObjectShape(schema));
    default:
      return {};
  }
}
