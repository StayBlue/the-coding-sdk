/*
 * This file incorporates material from claude-agent-sdk-python, licensed under
 * the MIT License:
 *
 * Copyright (c) 2025 Anthropic, PBC
 *
 * Modifications Copyright 2026 StayBlue, licensed under the Apache License,
 * Version 2.0. See the LICENSE file in the project root for details.
 */

import type {
  CallToolResult,
  ElicitResult,
  JSONRPCMessage,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import type { BetaUsage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { BetaRawMessageStreamEvent } from "@anthropic-ai/sdk/resources/beta/messages";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type { ZodRawShape } from "zod";
import type { HOOK_EVENTS } from "./public-constants.ts";

export type UUID = string;

/** Output format discriminator values understood by the SDK. */
export type OutputFormatType = "json_schema";

/** Shared base shape for structured output format declarations. */
export type BaseOutputFormat = {
  type: OutputFormatType;
};

/** Configuration scope used by Claude Code settings and hooks. */
export type ConfigScope = "local" | "user" | "project";

type RemoteControlHandle = {
  close(): void | Promise<void>;
  [Symbol.asyncDispose]?(): Promise<void>;
};

/** Structured failure returned by alpha remote-control connection helpers. */
export type ConnectRemoteControlError = {
  kind: "conflict" | "auth" | "network" | "unknown";
  detail: string;
};

/** Options for alpha remote-control connection helpers. */
export type ConnectRemoteControlOptions = {
  dir: string;
  registrationDir?: string;
  name?: string;
  workerType?: string;
  branch?: string;
  gitRepoUrl?: string | null;
  getAccessToken: () => string | undefined;
  baseUrl: string;
  orgUUID: string;
  model: string;
  perpetual?: boolean;
  initialSSESequenceNum?: number;
  onAuth401?: (staleAccessToken: string) => Promise<boolean>;
  onConflict?: (detail: { machineName: string; message: string }) => Promise<"takeover" | "abort">;
};

/** Discriminated result returned by alpha remote-control connection helpers. */
export type ConnectRemoteControlResult =
  | {
      ok: true;
      handle: RemoteControlHandle;
    }
  | {
      ok: false;
      error: ConnectRemoteControlError;
    };

/** Fast-mode status reported by the runtime. */
export type FastModeState = "off" | "cooldown" | "on";

/** Error categories that can be attached to assistant or retry messages. */
export type SDKAssistantMessageError =
  | "authentication_failed"
  | "billing_error"
  | "rate_limit"
  | "invalid_request"
  | "server_error"
  | "unknown"
  | "max_output_tokens";

/** High-level session status emitted by system status messages. */
export type SDKStatus = "compacting" | "requesting" | null;

/** Terminal reason attached to a completed result when available. */
export type TerminalReason =
  | "blocking_limit"
  | "rapid_refill_breaker"
  | "prompt_too_long"
  | "image_error"
  | "model_error"
  | "aborted_streaming"
  | "aborted_tools"
  | "stop_hook_prevented"
  | "hook_stopped"
  | "tool_deferred"
  | "max_turns"
  | "completed";

/** Token and cost usage for a single model during a run. */
export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number;
  maxOutputTokens: number;
};

/** Version of Anthropic usage data with nullable fields normalized away. */
export type NonNullableUsage = {
  [K in keyof BetaUsage]: NonNullable<BetaUsage[K]>;
};

/** Current rate-limit state reported by Claude Code. */
export type SDKRateLimitInfo = {
  status: "allowed" | "allowed_warning" | "rejected";
  resetsAt?: number;
  rateLimitType?: "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet" | "overage";
  utilization?: number;
  overageStatus?: "allowed" | "allowed_warning" | "rejected";
  overageResetsAt?: number;
  overageDisabledReason?:
    | "overage_not_provisioned"
    | "org_level_disabled"
    | "org_level_disabled_until"
    | "out_of_credits"
    | "seat_tier_level_disabled"
    | "member_level_disabled"
    | "seat_tier_zero_credit_limit"
    | "group_zero_credit_limit"
    | "member_zero_credit_limit"
    | "org_service_level_disabled"
    | "org_service_zero_credit_limit"
    | "no_limits_configured"
    | "unknown";
  isUsingOverage?: boolean;
  surpassedThreshold?: number;
};

/** A tool invocation that was denied by the permission system. */
export type SDKPermissionDenial = {
  tool_name: string;
  tool_use_id: string;
  tool_input: Record<string, unknown>;
};

/** A deferred tool call returned by the runtime for later execution. */
export type SDKDeferredToolUse = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

/** MCP server config variants returned by status APIs. */
export type McpServerStatusConfig =
  | McpServerConfigForProcessTransport
  | McpClaudeAIProxyServerConfig;

/** Request payload sent when the runtime asks the host to handle an elicitation. */
export type ElicitationRequest = {
  serverName: string;
  message: string;
  mode?: "form" | "url";
  url?: string;
  elicitationId?: string;
  requestedSchema?: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
};

/** Response shape returned from an elicitation handler. */
export type ElicitationResult = ElicitResult;

/** Callback invoked when the runtime emits an elicitation request. */
export type OnElicitation = (
  request: ElicitationRequest,
  options: { signal: AbortSignal },
) => Promise<ElicitationResult>;

/** Result of replacing the active MCP server configuration set. */
export type McpSetServersResult = {
  added: string[];
  removed: string[];
  errors: Record<string, string>;
  /** SDK MCP servers that failed to connect during this call. */
  failedServers?: string[];
};

/** Prompt request shown when the runtime asks the host to choose from options. */
export type PromptRequest = {
  prompt: string;
  message: string;
  options: PromptRequestOption[];
};

/** Single selectable option within a prompt request. */
export type PromptRequestOption = {
  key: string;
  label: string;
  description?: string;
};

/** Response submitted for a runtime prompt request. */
export type PromptResponse = {
  prompt_response: string;
  selected: string;
};

/** Payload returned when plugins are reloaded at runtime. */
export type SDKControlReloadPluginsResponse = {
  commands: SlashCommand[];
  agents: AgentInfo[];
  plugins: Array<{
    name: string;
    path: string;
    source?: string;
  }>;
  mcpServers: McpServerStatus[];
  error_count: number;
};

/** Convenience alias for arbitrary Zod object shapes used by SDK tools. */
export type AnyZodRawShape = ZodRawShape;

/** Source from which the active API key was resolved. */
export type ApiKeySource = "user" | "project" | "org" | "temporary" | "oauth";

/** Permission mode values accepted by the Claude Code runtime. */
export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk"
  | "auto";

/** High-level permission decision behavior. */
export type PermissionBehavior = "allow" | "deny" | "ask";

/** Classification attached to persisted permission decisions. */
export type PermissionDecisionClassification = "user_temporary" | "user_permanent" | "user_reject";

/** Destination that a permission update should be applied to. */
export type PermissionUpdateDestination =
  | "userSettings"
  | "projectSettings"
  | "localSettings"
  | "session"
  | "cliArg";

/** Settings files that should be loaded for a run. */
export type SettingSource = "user" | "project" | "local";

/** SDK beta flags currently exposed through the options surface. */
export type SdkBeta = "context-1m-2025-08-07";

/** Model effort levels accepted by Claude Code. */
export type EffortLevel = "low" | "medium" | "high" | "max";

/** Account information returned by runtime introspection APIs. */
export type AccountInfo = {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  tokenSource?: string;
  apiKeySource?: string;
  apiProvider?: "firstParty" | "bedrock" | "vertex" | "foundry" | "anthropicAws";
};

/** Definition for a custom agent supplied through SDK options. */
export type AgentDefinition = {
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  mcpServers?: AgentMcpServerSpec[];
  criticalSystemReminder_EXPERIMENTAL?: string;
  skills?: string[];
  initialPrompt?: string;
  maxTurns?: number;
  background?: boolean;
  memory?: "user" | "project" | "local";
  effort?: EffortLevel | number;
  permissionMode?: PermissionMode;
};

/** Metadata describing an available agent reported by the runtime. */
export type AgentInfo = {
  name: string;
  description: string;
  model?: string;
};

/** MCP server reference or inline config attached to an agent definition. */
export type AgentMcpServerSpec = string | Record<string, McpServerConfigForProcessTransport>;

/** A single permission rule referenced by permission update APIs. */
export type PermissionRuleValue = {
  toolName: string;
  ruleContent?: string;
};

/** Mutation applied to runtime or persisted permission state. */
export type PermissionUpdate =
  | {
      type: "addRules" | "replaceRules" | "removeRules";
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
      destination: PermissionUpdateDestination;
    }
  | {
      type: "setMode";
      mode: PermissionMode;
      destination: PermissionUpdateDestination;
    }
  | {
      type: "addDirectories" | "removeDirectories";
      directories: string[];
      destination: PermissionUpdateDestination;
    };

/** Result returned from permission callbacks and can-use-tool checks. */
export type PermissionResult =
  | {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: PermissionUpdate[];
      toolUseID?: string;
      decisionClassification?: PermissionDecisionClassification;
    }
  | {
      behavior: "deny";
      message: string;
      interrupt?: boolean;
      toolUseID?: string;
      decisionClassification?: PermissionDecisionClassification;
    };

/** Reason reported when a session ends. */
export type ExitReason =
  | "clear"
  | "resume"
  | "logout"
  | "prompt_input_exit"
  | "other"
  | "bypass_permissions_disabled";

/** Common fields included in every hook callback input payload. */
export type BaseHookInput = {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode?: PermissionMode;
  agent_id?: string;
  agent_type?: string;
};

/** Hook payload for configuration file changes. */
export type ConfigChangeHookInput = BaseHookInput & {
  hook_event_name: "ConfigChange";
  source: "user_settings" | "project_settings" | "local_settings" | "policy_settings" | "skills";
  file_path?: string;
};

/** Hook payload emitted when the working directory changes. */
export type CwdChangedHookInput = BaseHookInput & {
  hook_event_name: "CwdChanged";
  old_cwd: string;
  new_cwd: string;
};

/** Hook payload for a new elicitation request. */
export type ElicitationHookInput = BaseHookInput & {
  hook_event_name: "Elicitation";
  mcp_server_name: string;
  message: string;
  mode?: "form" | "url";
  url?: string;
  elicitation_id?: string;
  requested_schema?: Record<string, unknown>;
};

/** Hook payload for the completion of an elicitation flow. */
export type ElicitationResultHookInput = BaseHookInput & {
  hook_event_name: "ElicitationResult";
  mcp_server_name: string;
  elicitation_id?: string;
  mode?: "form" | "url";
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
};

/** Hook payload for a tracked file change. */
export type FileChangedHookInput = BaseHookInput & {
  hook_event_name: "FileChanged";
  file_path: string;
  event: "change" | "add" | "unlink";
};

/** Hook payload emitted immediately before a tool call runs. */
export type PreToolUseHookInput = BaseHookInput & {
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
};

/** Hook payload emitted after a tool call succeeds. */
export type PostToolUseHookInput = BaseHookInput & {
  hook_event_name: "PostToolUse";
  tool_name: string;
  tool_input: unknown;
  tool_response: unknown;
  tool_use_id: string;
};

/** Hook payload emitted after a tool call fails. */
export type PostToolUseFailureHookInput = BaseHookInput & {
  hook_event_name: "PostToolUseFailure";
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
  error: string;
  is_interrupt?: boolean;
};

/** Hook payload for a runtime notification. */
export type NotificationHookInput = BaseHookInput & {
  hook_event_name: "Notification";
  message: string;
  title?: string;
  notification_type: string;
};

/** Hook payload emitted when a tool call is denied. */
export type PermissionDeniedHookInput = BaseHookInput & {
  hook_event_name: "PermissionDenied";
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
  reason: string;
};

/** Hook payload emitted after compaction completes. */
export type PostCompactHookInput = BaseHookInput & {
  hook_event_name: "PostCompact";
  trigger: "manual" | "auto";
  compact_summary: string;
};

/** Hook payload for session shutdown. */
export type SessionEndHookInput = BaseHookInput & {
  hook_event_name: "SessionEnd";
  reason: ExitReason;
};

/** Hook payload for session startup or resume. */
export type SessionStartHookInput = BaseHookInput & {
  hook_event_name: "SessionStart";
  source: "startup" | "resume" | "clear" | "compact";
  agent_type?: string;
  model?: string;
};

/** Hook payload for SDK setup and maintenance phases. */
export type SetupHookInput = BaseHookInput & {
  hook_event_name: "Setup";
  trigger: "init" | "maintenance";
};

/** Hook payload emitted when the user submits a prompt. */
export type UserPromptSubmitHookInput = BaseHookInput & {
  hook_event_name: "UserPromptSubmit";
  prompt: string;
};

/** Hook payload for a stop-request check. */
export type StopHookInput = BaseHookInput & {
  hook_event_name: "Stop";
  stop_hook_active: boolean;
  last_assistant_message?: string;
};

/** Hook payload for a failure while processing a stop request. */
export type StopFailureHookInput = BaseHookInput & {
  hook_event_name: "StopFailure";
  error: unknown;
  error_details?: string;
  last_assistant_message?: string;
};

/** Hook payload emitted when a subagent begins work. */
export type SubagentStartHookInput = BaseHookInput & {
  hook_event_name: "SubagentStart";
  agent_id: string;
  agent_type: string;
};

/** Hook payload emitted when a subagent stops. */
export type SubagentStopHookInput = BaseHookInput & {
  hook_event_name: "SubagentStop";
  stop_hook_active: boolean;
  agent_id: string;
  agent_transcript_path: string;
  agent_type: string;
  last_assistant_message?: string;
};

/** Hook payload emitted immediately before compaction starts. */
export type PreCompactHookInput = BaseHookInput & {
  hook_event_name: "PreCompact";
  trigger: "manual" | "auto";
  custom_instructions: string | null;
};

/** Hook payload for an interactive permission request. */
export type PermissionRequestHookInput = BaseHookInput & {
  hook_event_name: "PermissionRequest";
  tool_name: string;
  tool_input: unknown;
  permission_suggestions?: PermissionUpdate[];
};

/** Hook payload for creation of a background or delegated task. */
export type TaskCreatedHookInput = BaseHookInput & {
  hook_event_name: "TaskCreated";
  task_id: string;
  task_subject: string;
  task_description?: string;
  teammate_name?: string;
  team_name?: string;
};

/** Hook payload for completion of a background or delegated task. */
export type TaskCompletedHookInput = BaseHookInput & {
  hook_event_name: "TaskCompleted";
  task_id: string;
  task_subject: string;
  task_description?: string;
  teammate_name?: string;
  team_name?: string;
};

/** Hook payload emitted when a teammate becomes idle. */
export type TeammateIdleHookInput = BaseHookInput & {
  hook_event_name: "TeammateIdle";
  teammate_name: string;
  team_name: string;
};

/** Hook payload describing memory or instructions loaded into context. */
export type InstructionsLoadedHookInput = BaseHookInput & {
  hook_event_name: "InstructionsLoaded";
  file_path: string;
  memory_type: "User" | "Project" | "Local" | "Managed";
  load_reason: "session_start" | "nested_traversal" | "path_glob_match" | "include" | "compact";
  globs?: string[];
  trigger_file_path?: string;
  parent_file_path?: string;
};

/** Hook payload emitted when a worktree is created. */
export type WorktreeCreateHookInput = BaseHookInput & {
  hook_event_name: "WorktreeCreate";
  name: string;
};

/** Hook payload emitted when a worktree is removed. */
export type WorktreeRemoveHookInput = BaseHookInput & {
  hook_event_name: "WorktreeRemove";
  worktree_path: string;
};

/** Permission decision values allowed in hook outputs. */
export type HookPermissionDecision = "allow" | "deny" | "ask" | "defer";

/** Hook-specific output shape for `PreToolUse`. */
export type PreToolUseHookSpecificOutput = {
  hookEventName: "PreToolUse";
  permissionDecision?: HookPermissionDecision;
  permissionDecisionReason?: string;
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
};

/** Hook-specific output shape for `UserPromptSubmit`. */
export type UserPromptSubmitHookSpecificOutput = {
  hookEventName: "UserPromptSubmit";
  additionalContext?: string;
  sessionTitle?: string;
};

/** Hook-specific output shape for `SessionStart`. */
export type SessionStartHookSpecificOutput = {
  hookEventName: "SessionStart";
  additionalContext?: string;
  initialUserMessage?: string;
  watchPaths?: string[];
};

/** Hook-specific output shape for `Setup`. */
export type SetupHookSpecificOutput = {
  hookEventName: "Setup";
  additionalContext?: string;
};

/** Hook-specific output shape for `SubagentStart`. */
export type SubagentStartHookSpecificOutput = {
  hookEventName: "SubagentStart";
  additionalContext?: string;
};

/** Hook-specific output shape for `PostToolUse`. */
export type PostToolUseHookSpecificOutput = {
  hookEventName: "PostToolUse";
  additionalContext?: string;
  updatedMCPToolOutput?: unknown;
};

/** Hook-specific output shape for `PostToolUseFailure`. */
export type PostToolUseFailureHookSpecificOutput = {
  hookEventName: "PostToolUseFailure";
  additionalContext?: string;
};

/** Hook-specific output shape for `PermissionDenied`. */
export type PermissionDeniedHookSpecificOutput = {
  hookEventName: "PermissionDenied";
  retry?: boolean;
};

/** Hook-specific output shape for `Notification`. */
export type NotificationHookSpecificOutput = {
  hookEventName: "Notification";
  additionalContext?: string;
};

/** Hook-specific output shape for `PermissionRequest`. */
export type PermissionRequestHookSpecificOutput = {
  hookEventName: "PermissionRequest";
  decision:
    | {
        behavior: "allow";
        updatedInput?: Record<string, unknown>;
        updatedPermissions?: PermissionUpdate[];
      }
    | {
        behavior: "deny";
        message?: string;
        interrupt?: boolean;
      };
};

/** Hook-specific output shape for `Elicitation`. */
export type ElicitationHookSpecificOutput = {
  hookEventName: "Elicitation";
  action?: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
};

/** Hook-specific output shape for `ElicitationResult`. */
export type ElicitationResultHookSpecificOutput = {
  hookEventName: "ElicitationResult";
  action?: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
};

/** Hook-specific output shape for `CwdChanged`. */
export type CwdChangedHookSpecificOutput = {
  hookEventName: "CwdChanged";
  watchPaths?: string[];
};

/** Hook-specific output shape for `FileChanged`. */
export type FileChangedHookSpecificOutput = {
  hookEventName: "FileChanged";
  watchPaths?: string[];
};

/** Hook-specific output shape for `WorktreeCreate`. */
export type WorktreeCreateHookSpecificOutput = {
  hookEventName: "WorktreeCreate";
  worktreePath: string;
};

/** Union of all hook callback input payloads. */
export type HookInput =
  | PreToolUseHookInput
  | PostToolUseHookInput
  | PostToolUseFailureHookInput
  | PermissionDeniedHookInput
  | ConfigChangeHookInput
  | CwdChangedHookInput
  | ElicitationHookInput
  | ElicitationResultHookInput
  | FileChangedHookInput
  | UserPromptSubmitHookInput
  | SessionStartHookInput
  | SessionEndHookInput
  | StopHookInput
  | StopFailureHookInput
  | SubagentStopHookInput
  | PreCompactHookInput
  | PostCompactHookInput
  | PermissionRequestHookInput
  | SetupHookInput
  | TeammateIdleHookInput
  | TaskCreatedHookInput
  | TaskCompletedHookInput
  | InstructionsLoadedHookInput
  | SubagentStartHookInput
  | NotificationHookInput
  | WorktreeCreateHookInput
  | WorktreeRemoveHookInput;

/** Synchronous hook callback response payload. */
export type SyncHookJSONOutput = {
  continue?: boolean;
  suppressOutput?: boolean;
  stopReason?: string;
  decision?: "approve" | "block";
  systemMessage?: string;
  reason?: string;
  hookSpecificOutput?:
    | PreToolUseHookSpecificOutput
    | UserPromptSubmitHookSpecificOutput
    | SessionStartHookSpecificOutput
    | SetupHookSpecificOutput
    | SubagentStartHookSpecificOutput
    | PostToolUseHookSpecificOutput
    | PostToolUseFailureHookSpecificOutput
    | PermissionDeniedHookSpecificOutput
    | NotificationHookSpecificOutput
    | PermissionRequestHookSpecificOutput
    | ElicitationHookSpecificOutput
    | ElicitationResultHookSpecificOutput
    | CwdChangedHookSpecificOutput
    | FileChangedHookSpecificOutput
    | WorktreeCreateHookSpecificOutput;
};

/** Asynchronous hook callback response payload. */
export type AsyncHookJSONOutput = {
  async: true;
  asyncTimeout?: number;
};

/** JSON payload returned from a hook callback. */
export type HookJSONOutput = SyncHookJSONOutput | AsyncHookJSONOutput;

/** Supported hook event names derived from the public constant list. */
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Hook callback signature used in runtime hook configuration. */
export type HookCallback = (
  input: HookInput,
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<HookJSONOutput>;

/** Matcher and callback bundle for a specific hook event registration. */
export interface HookCallbackMatcher {
  matcher?: string;
  hooks: HookCallback[];
  timeout?: number;
}

/** Callback used to decide whether a tool call should be allowed. */
export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    suggestions?: PermissionUpdate[];
    blockedPath?: string;
    decisionReason?: string;
    title?: string;
    displayName?: string;
    description?: string;
    toolUseID: string;
    agentID?: string;
  },
) => Promise<PermissionResult>;

/** Plugin configuration for loading a local Claude Code plugin. */
export type SdkPluginConfig = {
  type: "local";
  path: string;
};

/** Structured output request that supplies a JSON schema. */
export type JsonSchemaOutputFormat = {
  type: "json_schema";
  schema: Record<string, unknown>;
};

/** Structured output mode supported by the SDK. */
export type OutputFormat = JsonSchemaOutputFormat;

/** Thinking mode that lets the runtime choose the budget adaptively. */
export type ThinkingAdaptive = {
  type: "adaptive";
  display?: "summarized" | "omitted";
};
/** Thinking mode with an optional explicit budget. */
export type ThinkingEnabled = {
  type: "enabled";
  budgetTokens?: number;
  display?: "summarized" | "omitted";
};
/** Thinking mode that disables extended reasoning. */
export type ThinkingDisabled = { type: "disabled" };
/** Configures Claude Code thinking behavior for a query or session. */
export type ThinkingConfig = ThinkingAdaptive | ThinkingEnabled | ThinkingDisabled;

/** Network-related sandbox allowances for Claude Code. */
export type SandboxNetworkConfig = {
  allowedDomains?: string[];
  allowManagedDomainsOnly?: boolean;
  allowUnixSockets?: string[];
  allowAllUnixSockets?: boolean;
  allowLocalBinding?: boolean;
  httpProxyPort?: number;
  socksProxyPort?: number;
};

/** Filesystem-related sandbox allowances for Claude Code. */
export type SandboxFilesystemConfig = {
  allowWrite?: string[];
  denyWrite?: string[];
  denyRead?: string[];
  allowRead?: string[];
  allowManagedReadPathsOnly?: boolean;
};

/** Sandbox violations that should be ignored for specific commands or tools. */
export type SandboxIgnoreViolations = Record<string, string[]>;

/** Full sandbox configuration passed to Claude Code. */
export type SandboxSettings = {
  enabled?: boolean;
  failIfUnavailable?: boolean;
  autoAllowBashIfSandboxed?: boolean;
  allowUnsandboxedCommands?: boolean;
  network?: SandboxNetworkConfig;
  filesystem?: SandboxFilesystemConfig;
  ignoreViolations?: SandboxIgnoreViolations;
  enableWeakerNestedSandbox?: boolean;
  enableWeakerNetworkIsolation?: boolean;
  excludedCommands?: string[];
  ripgrep?: {
    command: string;
    args?: string[];
  };
};

/** Tool-specific runtime configuration. */
export type ToolConfig = {
  askUserQuestion?: {
    previewFormat?: "markdown" | "html";
  };
};

/** MCP server configuration for the Claude.ai proxy transport. */
export type McpClaudeAIProxyServerConfig = {
  type: "claudeai-proxy";
  url: string;
  id: string;
};

/** Per-tool permission policy for remote MCP servers. */
export type McpServerToolPolicy = {
  name: string;
  permission_policy: "always_allow" | "always_ask" | "always_deny";
};

/** MCP server configuration for HTTP transport. */
export type McpHttpServerConfig = {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  tools?: McpServerToolPolicy[];
};

/** MCP server configuration for Server-Sent Events transport. */
export type McpSSEServerConfig = {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
  tools?: McpServerToolPolicy[];
};

/** MCP server configuration for a stdio-spawned server process. */
export type McpStdioServerConfig = {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

/** In-memory SDK representation of an MCP server and its registered tools. */
export interface SdkMcpServerInstance {
  name: string;
  version?: string;
  tools: Array<SdkMcpToolDefinition>;
}

/** Identifier-only SDK MCP server reference used in transport-facing config. */
export type McpSdkServerConfig = {
  type: "sdk";
  name: string;
};

/** SDK MCP server config paired with the concrete in-memory server instance. */
export type McpSdkServerConfigWithInstance = McpSdkServerConfig & {
  instance: SdkMcpServerInstance;
};

/** Supported MCP server configuration variants accepted by the SDK. */
export type McpServerConfig =
  | McpStdioServerConfig
  | McpSSEServerConfig
  | McpHttpServerConfig
  | McpSdkServerConfigWithInstance;

/** MCP config variants that can be forwarded directly to the Claude Code process. */
export type McpServerConfigForProcessTransport =
  | McpStdioServerConfig
  | McpSSEServerConfig
  | McpHttpServerConfig
  | McpSdkServerConfig;

/** Live connection status for a configured MCP server. */
export type McpServerStatus = {
  name: string;
  status: "connected" | "failed" | "needs-auth" | "pending" | "disabled";
  serverInfo?: {
    name: string;
    version: string;
  };
  error?: string;
  config?: McpServerConfigForProcessTransport | McpClaudeAIProxyServerConfig;
  scope?: string;
  tools?: Array<{
    name: string;
    description?: string;
    annotations?: ToolAnnotations;
  }>;
};

/** Slash command metadata returned by the runtime. */
export type SlashCommand = {
  name: string;
  description: string;
  argumentHint: string;
};

/** Model capability metadata returned by the runtime. */
export type ModelInfo = {
  value: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: ("low" | "medium" | "high" | "max")[];
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
};

/** Definition of a tool exposed through an SDK-managed MCP server. */
export type SdkMcpToolDefinition<Schema extends AnyZodRawShape = AnyZodRawShape> = {
  name: string;
  description: string;
  inputSchema: Schema;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
  handler: BivariantAsyncHandler<InferShape<Schema>, unknown, CallToolResult>;
};

/** Infers the output object type from a Zod raw shape. */
export type InferShape<T extends AnyZodRawShape> = {
  [K in keyof T]: T[K] extends { _output: infer O } ? O : never;
};

export type BivariantAsyncHandler<Args, Extra, Result> = {
  bivarianceHack(args: Args, extra: Extra): Promise<Result>;
}["bivarianceHack"];

export type TaskBudget = {
  total: number;
};

/** Identifies a main session transcript or subagent transcript in a session store. */
export type SessionKey = {
  projectKey: string;
  sessionId: string;
  subpath?: string;
};

/** Opaque JSON transcript entry stored by `SessionStore` adapters. */
export type SessionStoreEntry = {
  type: string;
  uuid?: string;
  timestamp?: string;
  [k: string]: unknown;
};

/** Adapter for mirroring or loading Claude Code transcripts from external storage. */
export type SessionStore = {
  append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void>;
  load(key: SessionKey): Promise<SessionStoreEntry[] | null>;
  listSessions?(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>>;
  delete?(key: SessionKey): Promise<void>;
  listSubkeys?(key: { projectKey: string; sessionId: string }): Promise<string[]>;
};

/** Common runtime options for queries, sessions, and transport startup. */
export type Options = {
  abortController?: AbortController;
  additionalDirectories?: string[];
  agent?: string;
  agents?: Record<string, AgentDefinition>;
  allowedTools?: string[];
  canUseTool?: CanUseTool;
  continue?: boolean;
  cwd?: string;
  disallowedTools?: string[];
  tools?: string[] | { type: "preset"; preset: "claude_code" };
  env?: Record<string, string | undefined>;
  executable?: "bun" | "deno" | "node";
  executableArgs?: string[];
  extraArgs?: Record<string, string | null>;
  fallbackModel?: string;
  enableFileCheckpointing?: boolean;
  toolConfig?: ToolConfig;
  forkSession?: boolean;
  betas?: SdkBeta[];
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  onElicitation?: OnElicitation;
  persistSession?: boolean;
  sessionStore?: SessionStore;
  loadTimeoutMs?: number;
  includeHookEvents?: boolean;
  includePartialMessages?: boolean;
  thinking?: ThinkingConfig;
  effort?: EffortLevel;
  /**
   * @deprecated Use `thinking` instead. `0` is treated as disabled.
   */
  maxThinkingTokens?: number;
  maxTurns?: number;
  maxBudgetUsd?: number;
  taskBudget?: TaskBudget;
  mcpServers?: Record<string, McpServerConfig>;
  model?: string;
  outputFormat?: OutputFormat;
  pathToClaudeCodeExecutable?: string;
  permissionMode?: PermissionMode;
  allowDangerouslySkipPermissions?: boolean;
  permissionPromptToolName?: string;
  plugins?: SdkPluginConfig[];
  promptSuggestions?: boolean;
  agentProgressSummaries?: boolean;
  resume?: string;
  sessionId?: string;
  resumeSessionAt?: string;
  sandbox?: SandboxSettings;
  settings?: string | Settings;
  settingSources?: SettingSource[];
  debug?: boolean;
  debugFile?: string;
  stderr?: (data: string) => void;
  strictMcpConfig?: boolean;
  systemPrompt?:
    | string
    | string[]
    | {
        type: "preset";
        preset: "claude_code";
        append?: string;
        excludeDynamicSections?: boolean;
      };
  title?: string;
  spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess;
};

/** Parsed Claude Code settings payload. */
export type Settings = Record<string, unknown>;

/** Settings file parse or validation error reported by the runtime. */
export type SDKSettingsParseError = {
  file?: string;
  path: string;
  message: string;
};

/** User message received from a browser or bridge transport. */
export type InboundPrompt = {
  content: string | unknown[];
  uuid?: string;
};

export type SDKBaseMessage = {
  type: string;
  uuid?: UUID;
  session_id?: string;
};

/** User-authored input message sent to Claude Code. */
export type SDKUserMessage = SDKBaseMessage & {
  type: "user";
  message: MessageParam;
  parent_tool_use_id: string | null;
  isSynthetic?: boolean;
  tool_use_result?: unknown;
  priority?: "now" | "next" | "later";
  origin?: SDKMessageOrigin;
  shouldQuery?: boolean;
  timestamp?: string;
};

/** Assistant message emitted by Claude Code during a query or session. */
export type SDKAssistantMessage = SDKBaseMessage & {
  type: "assistant";
  message: Record<string, unknown>;
  parent_tool_use_id?: string | null;
  error?: SDKAssistantMessageError;
};

/** Terminal result message emitted when a query finishes. */
export type SDKResultMessage = SDKResultSuccess | SDKResultError;

/** Initial system message describing the active session environment and capabilities. */
export type SDKSystemMessage = {
  type: "system";
  subtype: "init";
  agents?: string[];
  apiKeySource: ApiKeySource;
  betas?: string[];
  claude_code_version: string;
  cwd: string;
  tools: string[];
  mcp_servers: {
    name: string;
    status: string;
  }[];
  model: string;
  permissionMode: PermissionMode;
  slash_commands: string[];
  output_style: string;
  skills: string[];
  plugins: {
    name: string;
    path: string;
  }[];
  fast_mode_state?: FastModeState;
  uuid: UUID;
  session_id: string;
};

/** Raw streaming event emitted while an assistant message is still in progress. */
export type SDKPartialAssistantMessage = SDKBaseMessage & {
  type: "stream_event";
  event: BetaRawMessageStreamEvent;
  parent_tool_use_id: string | null;
};

/** Streaming message carrying updated rate-limit information. */
export type SDKRateLimitEvent = SDKBaseMessage & {
  type: "rate_limit_event";
  rate_limit_info: SDKRateLimitInfo;
};

/** Progress update for a running tool call. */
export type SDKToolProgressMessage = SDKBaseMessage & {
  type: "tool_progress";
  tool_use_id: string;
  tool_name: string;
  parent_tool_use_id: string | null;
  elapsed_time_seconds: number;
  task_id?: string;
};

/** Summary emitted after one or more tool calls complete. */
export type SDKToolUseSummaryMessage = SDKBaseMessage & {
  type: "tool_use_summary";
  summary: string;
  preceding_tool_use_ids: string[];
};

/** Suggested follow-up prompt emitted by the runtime. */
export type SDKPromptSuggestionMessage = SDKBaseMessage & {
  type: "prompt_suggestion";
  suggestion: string;
};

/** Provenance for user-role messages received from non-keyboard sources. */
export type SDKMessageOrigin =
  | { kind: "human" }
  | { kind: "channel"; server: string }
  | { kind: "peer"; from: string; name?: string }
  | { kind: "task-notification" }
  | { kind: "coordinator" };

/** Replayed user message emitted when restoring existing transcript history. */
export type SDKUserMessageReplay = SDKBaseMessage & {
  type: "user";
  message: MessageParam;
  parent_tool_use_id: string | null;
  isSynthetic?: boolean;
  tool_use_result?: unknown;
  priority?: "now" | "next" | "later";
  origin?: SDKMessageOrigin;
  shouldQuery?: boolean;
  timestamp?: string;
  uuid: UUID;
  session_id: string;
  isReplay: true;
  file_attachments?: unknown[];
};

/** Authentication status update emitted while login is in progress. */
export type SDKAuthStatusMessage = {
  type: "auth_status";
  isAuthenticating: boolean;
  output: string[];
  error?: string;
  uuid: UUID;
  session_id: string;
};

/** Successful terminal result returned at the end of a query. */
export type SDKResultSuccess = {
  type: "result";
  subtype: "success";
  duration_ms: number;
  duration_api_ms: number;
  is_error: boolean;
  api_error_status?: number | null;
  num_turns: number;
  result: string;
  stop_reason: string | null;
  total_cost_usd: number;
  usage: NonNullableUsage;
  modelUsage: Record<string, ModelUsage>;
  permission_denials: SDKPermissionDenial[];
  structured_output?: unknown;
  deferred_tool_use?: SDKDeferredToolUse;
  terminal_reason?: TerminalReason;
  fast_mode_state?: FastModeState;
  uuid: UUID;
  session_id: string;
};

/** Error terminal result returned when a query ends unsuccessfully. */
export type SDKResultError = {
  type: "result";
  subtype:
    | "error_during_execution"
    | "error_max_turns"
    | "error_max_budget_usd"
    | "error_max_structured_output_retries";
  duration_ms: number;
  duration_api_ms: number;
  is_error: boolean;
  num_turns: number;
  stop_reason: string | null;
  total_cost_usd: number;
  usage: NonNullableUsage;
  modelUsage: Record<string, ModelUsage>;
  permission_denials: SDKPermissionDenial[];
  errors: string[];
  terminal_reason?: TerminalReason;
  fast_mode_state?: FastModeState;
  uuid: UUID;
  session_id: string;
};

/** System message indicating an upstream API retry attempt. */
export type SDKAPIRetryMessage = {
  type: "system";
  subtype: "api_retry";
  attempt: number;
  max_retries: number;
  retry_delay_ms: number;
  error_status: number | null;
  error: SDKAssistantMessageError;
  uuid: UUID;
  session_id: string;
};

/** Boundary marker emitted when the transcript is compacted. */
export type SDKCompactBoundaryMessage = {
  type: "system";
  subtype: "compact_boundary";
  compact_metadata: {
    summary: string;
    turn_count: number;
  };
  uuid: UUID;
  session_id: string;
};

/** System message emitted when an elicitation flow completes. */
export type SDKElicitationCompleteMessage = {
  type: "system";
  subtype: "elicitation_complete";
  mcp_server_name: string;
  elicitation_id: string;
  uuid: UUID;
  session_id: string;
};

/** System message describing files persisted by the runtime. */
export type SDKFilesPersistedEvent = {
  type: "system";
  subtype: "files_persisted";
  files: Array<{
    filename: string;
    file_id: string;
  }>;
  failed: Array<{
    filename: string;
    error: string;
  }>;
  processed_at: string;
  uuid: UUID;
  session_id: string;
};

/** System message emitted when a hook starts running. */
export type SDKHookStartedMessage = {
  type: "system";
  subtype: "hook_started";
  hook_id: string;
  hook_name: string;
  hook_event: string;
  uuid: UUID;
  session_id: string;
};

/** System message carrying stdout or stderr from a running hook. */
export type SDKHookProgressMessage = {
  type: "system";
  subtype: "hook_progress";
  hook_id: string;
  hook_name: string;
  hook_event: string;
  stdout: string;
  stderr: string;
  output: string;
  uuid: UUID;
  session_id: string;
};

/** Final system message for a completed hook execution. */
export type SDKHookResponseMessage = {
  type: "system";
  subtype: "hook_response";
  hook_id: string;
  hook_name: string;
  hook_event: string;
  output: string;
  stdout: string;
  stderr: string;
  exit_code?: number;
  outcome: "success" | "error" | "cancelled";
  uuid: UUID;
  session_id: string;
};

/** System message carrying output from a local command. */
export type SDKLocalCommandOutputMessage = {
  type: "system";
  subtype: "local_command_output";
  content: string;
  uuid: UUID;
  session_id: string;
};

/** System message indicating a change in session execution state. */
export type SDKSessionStateChangedMessage = {
  type: "system";
  subtype: "session_state_changed";
  state: "idle" | "running" | "requires_action";
  uuid: UUID;
  session_id: string;
};

/** System status message for compaction and permission mode updates. */
export type SDKStatusMessage = {
  type: "system";
  subtype: "status";
  status: SDKStatus;
  permissionMode?: PermissionMode;
  compact_result?: "success" | "failed";
  compact_error?: string;
  uuid: UUID;
  session_id: string;
};

/** Notification emitted when a background task finishes or stops. */
export type SDKTaskNotificationMessage = {
  type: "system";
  subtype: "task_notification";
  task_id: string;
  tool_use_id?: string;
  status: "completed" | "failed" | "stopped";
  output_file: string;
  summary: string;
  usage?: {
    total_tokens: number;
    tool_uses: number;
    duration_ms: number;
  };
  skip_transcript?: boolean;
  uuid: UUID;
  session_id: string;
};

/** Progress update for a background task. */
export type SDKTaskProgressMessage = {
  type: "system";
  subtype: "task_progress";
  task_id: string;
  tool_use_id?: string;
  description: string;
  usage: {
    total_tokens: number;
    tool_uses: number;
    duration_ms: number;
  };
  last_tool_name?: string;
  summary?: string;
  uuid: UUID;
  session_id: string;
};

/** Notification emitted when a background task starts. */
export type SDKTaskStartedMessage = {
  type: "system";
  subtype: "task_started";
  task_id: string;
  tool_use_id?: string;
  description: string;
  task_type?: string;
  workflow_name?: string;
  prompt?: string;
  skip_transcript?: boolean;
  uuid: UUID;
  session_id: string;
};

/** Patch-style update for a background task. */
export type SDKTaskUpdatedMessage = {
  type: "system";
  subtype: "task_updated";
  task_id: string;
  patch: {
    status?: "pending" | "running" | "completed" | "failed" | "killed";
    description?: string;
    end_time?: number;
    total_paused_ms?: number;
    error?: string;
    is_backgrounded?: boolean;
  };
  uuid: UUID;
  session_id: string;
};

/** Notification emitted by the runtime notification queue. */
export type SDKNotificationMessage = {
  type: "system";
  subtype: "notification";
  key: string;
  text: string;
  priority: "low" | "medium" | "high" | "immediate";
  color?: string;
  timeout_ms?: number;
  uuid: UUID;
  session_id: string;
};

/** Progress emitted while headless plugins are installed. */
export type SDKPluginInstallMessage = {
  type: "system";
  subtype: "plugin_install";
  status: "started" | "installed" | "failed" | "completed";
  name?: string;
  error?: string;
  uuid: UUID;
  session_id: string;
};

/** Message emitted when memory recall adds memories to a turn. */
export type SDKMemoryRecallMessage = {
  type: "system";
  subtype: "memory_recall";
  mode: "select" | "synthesize";
  memories: Array<{
    path: string;
    scope: "personal" | "team";
    content?: string;
  }>;
  uuid: UUID;
  session_id: string;
};

/** Message emitted when a `SessionStore.append()` mirror batch fails. */
export type SDKMirrorErrorMessage = {
  type: "system";
  subtype: "mirror_error";
  error: string;
  key: {
    projectKey: string;
    sessionId: string;
    subpath?: string;
  };
  uuid: UUID;
  session_id: string;
};

/** Union of streamed messages emitted by queries and sessions. */
export type SDKMessage =
  | SDKUserMessage
  | SDKUserMessageReplay
  | SDKAssistantMessage
  | SDKResultMessage
  | SDKSystemMessage
  | SDKPartialAssistantMessage
  | SDKCompactBoundaryMessage
  | SDKStatusMessage
  | SDKAPIRetryMessage
  | SDKLocalCommandOutputMessage
  | SDKHookStartedMessage
  | SDKHookProgressMessage
  | SDKHookResponseMessage
  | SDKRateLimitEvent
  | SDKToolProgressMessage
  | SDKToolUseSummaryMessage
  | SDKPromptSuggestionMessage
  | SDKPluginInstallMessage
  | SDKTaskNotificationMessage
  | SDKTaskStartedMessage
  | SDKTaskUpdatedMessage
  | SDKTaskProgressMessage
  | SDKSessionStateChangedMessage
  | SDKNotificationMessage
  | SDKMemoryRecallMessage
  | SDKMirrorErrorMessage
  | SDKAuthStatusMessage
  | SDKFilesPersistedEvent
  | SDKElicitationCompleteMessage;

/** Response payload returned by the runtime initialize control request. */
export type SDKControlInitializeResponse = {
  commands: SlashCommand[];
  agents: AgentInfo[];
  output_style: string;
  available_output_styles: string[];
  models: ModelInfo[];
  account: AccountInfo;
  fast_mode_state?: FastModeState;
  /** SDK MCP servers that failed to connect during initialization. */
  failedSdkServers?: string[];
};

/** Detailed token breakdown returned by the context-usage control request. */
export type SDKControlGetContextUsageResponse = {
  categories: Array<{
    name: string;
    tokens: number;
    color: string;
    isDeferred?: boolean;
  }>;
  totalTokens: number;
  maxTokens: number;
  rawMaxTokens: number;
  percentage: number;
  gridRows: Array<
    Array<{
      color: string;
      isFilled: boolean;
      categoryName: string;
      tokens: number;
      percentage: number;
      squareFullness: number;
    }>
  >;
  model: string;
  memoryFiles: Array<{
    path: string;
    type: string;
    tokens: number;
  }>;
  mcpTools: Array<{
    name: string;
    serverName: string;
    tokens: number;
    isLoaded?: boolean;
  }>;
  deferredBuiltinTools?: Array<{
    name: string;
    tokens: number;
    isLoaded: boolean;
  }>;
  systemTools?: Array<{
    name: string;
    tokens: number;
  }>;
  systemPromptSections?: Array<{
    name: string;
    tokens: number;
  }>;
  agents: Array<{
    agentType: string;
    source: string;
    tokens: number;
  }>;
  slashCommands?: {
    totalCommands: number;
    includedCommands: number;
    tokens: number;
  };
  skills?: {
    totalSkills: number;
    includedSkills: number;
    tokens: number;
    skillFrontmatter: Array<{
      name: string;
      source: string;
      tokens: number;
    }>;
  };
  autoCompactThreshold?: number;
  isAutoCompactEnabled: boolean;
  messageBreakdown?: {
    toolCallTokens: number;
    toolResultTokens: number;
    attachmentTokens: number;
    assistantMessageTokens: number;
    userMessageTokens: number;
    toolCallsByType: Array<{
      name: string;
      callTokens: number;
      resultTokens: number;
    }>;
    attachmentsByType: Array<{
      name: string;
      tokens: number;
    }>;
  };
  apiUsage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  } | null;
};

export type RewindFilesOptions = {
  dryRun?: boolean;
};

/** Result of attempting to rewind file edits to a prior user message. */
export type RewindFilesResult = {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
};

/** Result returned after creating a forked session transcript. */
export type ForkSessionResult = {
  sessionId: string;
};

/** Summary metadata for a persisted Claude Code session transcript. */
export type SDKSessionInfo = {
  sessionId: string;
  summary: string;
  lastModified: number;
  fileSize?: number;
  customTitle?: string;
  firstPrompt?: string;
  gitBranch?: string;
  cwd?: string;
  tag?: string;
  createdAt?: number;
};

/** Long-lived session interface for sending prompts and streaming follow-up messages. */
export interface SDKSession {
  readonly sessionId: string;
  send(message: string | SDKUserMessage): Promise<void>;
  stream(): AsyncGenerator<SDKMessage, void>;
  close(): void;
  [Symbol.asyncDispose](): Promise<void>;
}

/** Options accepted when creating or resuming a session. */
export type SDKSessionOptions = Options;

/** Transcript entry returned by session history helpers. */
export type SessionMessage = {
  type: "user" | "assistant" | "system";
  uuid: string;
  session_id: string;
  message: unknown;
  parent_tool_use_id: null;
};

/** Common options for local session mutation helpers. */
export type SessionMutationOptions = {
  dir?: string;
  sessionStore?: SessionStore;
};

/** Options for listing persisted sessions. */
export type ListSessionsOptions = {
  dir?: string;
  limit?: number;
  offset?: number;
  includeWorktrees?: boolean;
  sessionStore?: SessionStore;
};

/** Options for looking up a single persisted session. */
export type GetSessionInfoOptions = {
  dir?: string;
  sessionStore?: SessionStore;
};

/** Options for reading messages from a persisted session transcript. */
export type GetSessionMessagesOptions = {
  dir?: string;
  limit?: number;
  offset?: number;
  includeSystemMessages?: boolean;
  sessionStore?: SessionStore;
};

/** Options for reading messages from a subagent transcript. */
export type GetSubagentMessagesOptions = {
  dir?: string;
  limit?: number;
  offset?: number;
  includeSystemMessages?: boolean;
  sessionStore?: SessionStore;
};

/** Options for listing subagent transcripts beneath a session. */
export type ListSubagentsOptions = {
  dir?: string;
  limit?: number;
  offset?: number;
  sessionStore?: SessionStore;
};

/** Options for copying a local transcript into a `SessionStore`. */
export type ImportSessionToStoreOptions = {
  dir?: string;
  includeSubagents?: boolean;
  batchSize?: number;
};

/** Options controlling how a session transcript is forked. */
export type ForkSessionOptions = SessionMutationOptions & {
  upToMessageId?: string;
  title?: string;
};

/** Minimal child-process shape required by the subprocess transport. */
export interface SpawnedProcess {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  readonly killed: boolean;
  readonly exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  off(event: "error", listener: (error: Error) => void): void;
}

/** Arguments provided when overriding process spawning. */
export interface SpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}

export type StdoutMessage =
  | SDKMessage
  | {
      type: "control_response";
      response: {
        subtype: "success" | "error";
        request_id: string;
        response?: Record<string, unknown>;
        error?: string;
      };
    }
  | {
      type: "control_request";
      request_id: string;
      request: Record<string, unknown>;
    }
  | {
      type: "control_cancel_request";
      request_id: string;
    }
  | {
      type: "keep_alive";
    }
  | {
      type: "transcript_mirror";
      filePath: string;
      entries: SessionStoreEntry[];
    };

/** Low-level transport used by the query controller to talk to Claude Code. */
export interface Transport {
  write(data: string): Promise<void>;
  close(): void;
  isReady(): boolean;
  readMessages(): AsyncGenerator<StdoutMessage, void, unknown>;
  endInput(): void;
}

/** Streaming query handle with control methods for the active Claude Code run. */
export interface Query extends AsyncGenerator<SDKMessage, void> {
  interrupt(): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  /**
   * @deprecated Use the `thinking` option in `query()` instead.
   */
  setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void>;
  applyFlagSettings(settings: Settings): Promise<void>;
  initializationResult(): Promise<SDKControlInitializeResponse>;
  supportedCommands(): Promise<SlashCommand[]>;
  supportedModels(): Promise<ModelInfo[]>;
  supportedAgents(): Promise<AgentInfo[]>;
  mcpServerStatus(): Promise<McpServerStatus[]>;
  getContextUsage(): Promise<SDKControlGetContextUsageResponse>;
  accountInfo(): Promise<AccountInfo>;
  rewindFiles(userMessageId: string, options?: RewindFilesOptions): Promise<RewindFilesResult>;
  reconnectMcpServer(serverName: string): Promise<void>;
  toggleMcpServer(serverName: string, enabled: boolean): Promise<void>;
  setMcpServers(servers: Record<string, McpServerConfig>): Promise<McpSetServersResult>;
  reloadPlugins(): Promise<SDKControlReloadPluginsResponse>;
  streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>;
  stopTask(taskId: string): Promise<void>;
  seedReadState(path: string, mtime: number): Promise<void>;
  close(): void;
}

/** Pre-warmed query handle returned by `startup()`. */
export interface WarmQuery extends AsyncDisposable {
  query(prompt: string | AsyncIterable<SDKUserMessage>): Query;
  close(): void;
}

/** Control request payloads that can be exchanged with the Claude Code process. */
export type SDKControlRequestInner =
  | {
      subtype: "initialize";
      hooks?: Partial<
        Record<HookEvent, Array<{ matcher?: string; hookCallbackIds: string[]; timeout?: number }>>
      >;
      sdkMcpServers?: string[];
      jsonSchema?: Record<string, unknown>;
      systemPrompt?: string | string[];
      appendSystemPrompt?: string;
      excludeDynamicSections?: boolean;
      agents?: Record<string, AgentDefinition>;
      title?: string;
      promptSuggestions?: boolean;
      agentProgressSummaries?: boolean;
    }
  | {
      subtype: "interrupt";
    }
  | {
      subtype: "mcp_message";
      server_name: string;
      message: JSONRPCMessage;
    }
  | {
      subtype: "mcp_reconnect";
      serverName: string;
    }
  | {
      subtype: "mcp_status";
    }
  | {
      subtype: "mcp_toggle";
      serverName: string;
      enabled: boolean;
    }
  | {
      subtype: "can_use_tool";
      tool_name: string;
      input: Record<string, unknown>;
      permission_suggestions?: PermissionUpdate[];
      blocked_path?: string;
      decision_reason?: string;
      title?: string;
      display_name?: string;
      description?: string;
      tool_use_id: string;
      agent_id?: string;
    }
  | {
      subtype: "rewind_files";
      user_message_id: string;
      dry_run?: boolean;
    }
  | {
      subtype: "set_model";
      model?: string;
    }
  | {
      subtype: "set_max_thinking_tokens";
      max_thinking_tokens: number | null;
    }
  | {
      subtype: "apply_flag_settings";
      settings: Settings;
    }
  | {
      subtype: "set_permission_mode";
      mode: PermissionMode;
    }
  | {
      subtype: "seed_read_state";
      path: string;
      mtime: number;
    }
  | {
      subtype: "stop_task";
      task_id: string;
    }
  | {
      subtype: "hook_callback";
      callback_id: string;
      input: HookInput;
      tool_use_id?: string;
    }
  | {
      subtype: "get_context_usage";
    }
  | {
      subtype: "elicitation";
      mcp_server_name: string;
      message: string;
      mode?: "form" | "url";
      url?: string;
      elicitation_id?: string;
      requested_schema?: Record<string, unknown>;
    }
  | {
      subtype: "mcp_set_servers";
      servers: Record<string, McpServerConfigForProcessTransport>;
    }
  | {
      subtype: "reload_plugins";
    };

/** Envelope for a single control request sent to the runtime. */
export type SDKControlRequest = {
  type: "control_request";
  request_id: string;
  request: SDKControlRequestInner;
};

/** Envelope for a single control response returned by the runtime. */
export type SDKControlResponse = {
  type: "control_response";
  response:
    | {
        subtype: "success";
        request_id: string;
        response?: Record<string, unknown>;
      }
    | {
        subtype: "error";
        request_id: string;
        error: string;
        pending_permission_requests?: SDKControlRequest[];
      };
};
