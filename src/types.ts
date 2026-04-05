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

export type OutputFormatType = "json_schema";

export type BaseOutputFormat = {
  type: OutputFormatType;
};

export type ConfigScope = "local" | "user" | "project";

export type FastModeState = "off" | "cooldown" | "on";

export type SDKAssistantMessageError =
  | "authentication_failed"
  | "billing_error"
  | "rate_limit"
  | "invalid_request"
  | "server_error"
  | "unknown"
  | "max_output_tokens";

export type SDKStatus = "compacting" | null;

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

export type NonNullableUsage = {
  [K in keyof BetaUsage]: NonNullable<BetaUsage[K]>;
};

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

export type SDKPermissionDenial = {
  tool_name: string;
  tool_use_id: string;
  tool_input: Record<string, unknown>;
};

export type SDKDeferredToolUse = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type McpServerStatusConfig =
  | McpServerConfigForProcessTransport
  | McpClaudeAIProxyServerConfig;

export type ElicitationRequest = {
  serverName: string;
  message: string;
  mode?: "form" | "url";
  url?: string;
  elicitationId?: string;
  requestedSchema?: Record<string, unknown>;
};

export type ElicitationResult = ElicitResult;

export type OnElicitation = (
  request: ElicitationRequest,
  options: { signal: AbortSignal },
) => Promise<ElicitationResult>;

export type McpSetServersResult = {
  added: string[];
  removed: string[];
  errors: Record<string, string>;
};

export type PromptRequest = {
  prompt: string;
  message: string;
  options: PromptRequestOption[];
};

export type PromptRequestOption = {
  key: string;
  label: string;
  description?: string;
};

export type PromptResponse = {
  prompt_response: string;
  selected: string;
};

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

export type AnyZodRawShape = ZodRawShape;

export type ApiKeySource = "user" | "project" | "org" | "temporary" | "oauth";

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk"
  | "auto";

export type PermissionBehavior = "allow" | "deny" | "ask";

export type PermissionDecisionClassification = "user_temporary" | "user_permanent" | "user_reject";

export type PermissionUpdateDestination =
  | "userSettings"
  | "projectSettings"
  | "localSettings"
  | "session"
  | "cliArg";

export type SettingSource = "user" | "project" | "local";

export type SdkBeta = "context-1m-2025-08-07";

export type EffortLevel = "low" | "medium" | "high" | "max";

export type AccountInfo = {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  tokenSource?: string;
  apiKeySource?: string;
  apiProvider?: "firstParty" | "bedrock" | "vertex" | "foundry" | "anthropicAws";
};

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

export type AgentInfo = {
  name: string;
  description: string;
  model?: string;
};

export type AgentMcpServerSpec = string | Record<string, McpServerConfigForProcessTransport>;

export type PermissionRuleValue = {
  toolName: string;
  ruleContent?: string;
};

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

export type ExitReason =
  | "clear"
  | "resume"
  | "logout"
  | "prompt_input_exit"
  | "other"
  | "bypass_permissions_disabled";

export type BaseHookInput = {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode?: string;
  agent_id?: string;
  agent_type?: string;
};

export type ConfigChangeHookInput = BaseHookInput & {
  hook_event_name: "ConfigChange";
  source: "user_settings" | "project_settings" | "local_settings" | "policy_settings" | "skills";
  file_path?: string;
};

export type CwdChangedHookInput = BaseHookInput & {
  hook_event_name: "CwdChanged";
  old_cwd: string;
  new_cwd: string;
};

export type ElicitationHookInput = BaseHookInput & {
  hook_event_name: "Elicitation";
  mcp_server_name: string;
  message: string;
  mode?: "form" | "url";
  url?: string;
  elicitation_id?: string;
  requested_schema?: Record<string, unknown>;
};

export type ElicitationResultHookInput = BaseHookInput & {
  hook_event_name: "ElicitationResult";
  mcp_server_name: string;
  elicitation_id?: string;
  mode?: "form" | "url";
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
};

export type FileChangedHookInput = BaseHookInput & {
  hook_event_name: "FileChanged";
  file_path: string;
  event: "change" | "add" | "unlink";
};

export type PreToolUseHookInput = BaseHookInput & {
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
};

export type PostToolUseHookInput = BaseHookInput & {
  hook_event_name: "PostToolUse";
  tool_name: string;
  tool_input: unknown;
  tool_response: unknown;
  tool_use_id: string;
};

export type PostToolUseFailureHookInput = BaseHookInput & {
  hook_event_name: "PostToolUseFailure";
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
  error: string;
  is_interrupt?: boolean;
};

export type NotificationHookInput = BaseHookInput & {
  hook_event_name: "Notification";
  message: string;
  title?: string;
  notification_type: string;
};

export type PermissionDeniedHookInput = BaseHookInput & {
  hook_event_name: "PermissionDenied";
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
  reason: string;
};

export type PostCompactHookInput = BaseHookInput & {
  hook_event_name: "PostCompact";
  trigger: "manual" | "auto";
  compact_summary: string;
};

export type SessionEndHookInput = BaseHookInput & {
  hook_event_name: "SessionEnd";
  reason: ExitReason;
};

export type SessionStartHookInput = BaseHookInput & {
  hook_event_name: "SessionStart";
  source: "startup" | "resume" | "clear" | "compact";
  agent_type?: string;
  model?: string;
};

export type SetupHookInput = BaseHookInput & {
  hook_event_name: "Setup";
  trigger: "init" | "maintenance";
};

export type UserPromptSubmitHookInput = BaseHookInput & {
  hook_event_name: "UserPromptSubmit";
  prompt: string;
};

export type StopHookInput = BaseHookInput & {
  hook_event_name: "Stop";
  stop_hook_active: boolean;
  last_assistant_message?: string;
};

export type StopFailureHookInput = BaseHookInput & {
  hook_event_name: "StopFailure";
  error: unknown;
  error_details?: string;
  last_assistant_message?: string;
};

export type SubagentStartHookInput = BaseHookInput & {
  hook_event_name: "SubagentStart";
  agent_id: string;
  agent_type: string;
};

export type SubagentStopHookInput = BaseHookInput & {
  hook_event_name: "SubagentStop";
  stop_hook_active: boolean;
  agent_id: string;
  agent_transcript_path: string;
  agent_type: string;
  last_assistant_message?: string;
};

export type PreCompactHookInput = BaseHookInput & {
  hook_event_name: "PreCompact";
  trigger: "manual" | "auto";
  custom_instructions: string | null;
};

export type PermissionRequestHookInput = BaseHookInput & {
  hook_event_name: "PermissionRequest";
  tool_name: string;
  tool_input: unknown;
  permission_suggestions?: PermissionUpdate[];
};

export type TaskCreatedHookInput = BaseHookInput & {
  hook_event_name: "TaskCreated";
  task_id: string;
  task_subject: string;
  task_description?: string;
  teammate_name?: string;
  team_name?: string;
};

export type TaskCompletedHookInput = BaseHookInput & {
  hook_event_name: "TaskCompleted";
  task_id: string;
  task_subject: string;
  task_description?: string;
  teammate_name?: string;
  team_name?: string;
};

export type TeammateIdleHookInput = BaseHookInput & {
  hook_event_name: "TeammateIdle";
  teammate_name: string;
  team_name: string;
};

export type InstructionsLoadedHookInput = BaseHookInput & {
  hook_event_name: "InstructionsLoaded";
  file_path: string;
  memory_type: "User" | "Project" | "Local" | "Managed";
  load_reason: "session_start" | "nested_traversal" | "path_glob_match" | "include" | "compact";
  globs?: string[];
  trigger_file_path?: string;
  parent_file_path?: string;
};

export type WorktreeCreateHookInput = BaseHookInput & {
  hook_event_name: "WorktreeCreate";
  name: string;
};

export type WorktreeRemoveHookInput = BaseHookInput & {
  hook_event_name: "WorktreeRemove";
  worktree_path: string;
};

export type HookPermissionDecision = "allow" | "deny" | "ask" | "defer";

export type PreToolUseHookSpecificOutput = {
  hookEventName: "PreToolUse";
  permissionDecision?: HookPermissionDecision;
  permissionDecisionReason?: string;
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
};

export type UserPromptSubmitHookSpecificOutput = {
  hookEventName: "UserPromptSubmit";
  additionalContext?: string;
};

export type SessionStartHookSpecificOutput = {
  hookEventName: "SessionStart";
  additionalContext?: string;
  initialUserMessage?: string;
  watchPaths?: string[];
};

export type SetupHookSpecificOutput = {
  hookEventName: "Setup";
  additionalContext?: string;
};

export type SubagentStartHookSpecificOutput = {
  hookEventName: "SubagentStart";
  additionalContext?: string;
};

export type PostToolUseHookSpecificOutput = {
  hookEventName: "PostToolUse";
  additionalContext?: string;
  updatedMCPToolOutput?: unknown;
};

export type PostToolUseFailureHookSpecificOutput = {
  hookEventName: "PostToolUseFailure";
  additionalContext?: string;
};

export type PermissionDeniedHookSpecificOutput = {
  hookEventName: "PermissionDenied";
  retry?: boolean;
};

export type NotificationHookSpecificOutput = {
  hookEventName: "Notification";
  additionalContext?: string;
};

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

export type ElicitationHookSpecificOutput = {
  hookEventName: "Elicitation";
  action?: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
};

export type ElicitationResultHookSpecificOutput = {
  hookEventName: "ElicitationResult";
  action?: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
};

export type CwdChangedHookSpecificOutput = {
  hookEventName: "CwdChanged";
  watchPaths?: string[];
};

export type FileChangedHookSpecificOutput = {
  hookEventName: "FileChanged";
  watchPaths?: string[];
};

export type WorktreeCreateHookSpecificOutput = {
  hookEventName: "WorktreeCreate";
  worktreePath: string;
};

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

export type AsyncHookJSONOutput = {
  async: true;
  asyncTimeout?: number;
};

export type HookJSONOutput = SyncHookJSONOutput | AsyncHookJSONOutput;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export type HookCallback = (
  input: HookInput,
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<HookJSONOutput>;

export interface HookCallbackMatcher {
  matcher?: string;
  hooks: HookCallback[];
  timeout?: number;
}

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

export type SdkPluginConfig = {
  type: "local";
  path: string;
};

export type JsonSchemaOutputFormat = {
  type: "json_schema";
  schema: Record<string, unknown>;
};

export type OutputFormat = JsonSchemaOutputFormat;

export type ThinkingAdaptive = { type: "adaptive" };
export type ThinkingEnabled = { type: "enabled"; budgetTokens?: number };
export type ThinkingDisabled = { type: "disabled" };
export type ThinkingConfig = ThinkingAdaptive | ThinkingEnabled | ThinkingDisabled;

export type SandboxNetworkConfig = {
  allowedDomains?: string[];
  allowManagedDomainsOnly?: boolean;
  allowUnixSockets?: string[];
  allowAllUnixSockets?: boolean;
  allowLocalBinding?: boolean;
  httpProxyPort?: number;
  socksProxyPort?: number;
};

export type SandboxFilesystemConfig = {
  allowWrite?: string[];
  denyWrite?: string[];
  denyRead?: string[];
  allowRead?: string[];
  allowManagedReadPathsOnly?: boolean;
};

export type SandboxIgnoreViolations = Record<string, string[]>;

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

export type ToolConfig = {
  askUserQuestion?: {
    previewFormat?: "markdown" | "html";
  };
};

export type McpClaudeAIProxyServerConfig = {
  type: "claudeai-proxy";
  url: string;
  id: string;
};

export type McpHttpServerConfig = {
  type: "http";
  url: string;
  headers?: Record<string, string>;
};

export type McpSSEServerConfig = {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
};

export type McpStdioServerConfig = {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export interface SdkMcpServerInstance {
  name: string;
  version?: string;
  tools: Array<SdkMcpToolDefinition>;
}

export type McpSdkServerConfig = {
  type: "sdk";
  name: string;
};

export type McpSdkServerConfigWithInstance = McpSdkServerConfig & {
  instance: SdkMcpServerInstance;
};

export type McpServerConfig =
  | McpStdioServerConfig
  | McpSSEServerConfig
  | McpHttpServerConfig
  | McpSdkServerConfigWithInstance;

export type McpServerConfigForProcessTransport =
  | McpStdioServerConfig
  | McpSSEServerConfig
  | McpHttpServerConfig
  | McpSdkServerConfig;

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

export type SlashCommand = {
  name: string;
  description: string;
  argumentHint: string;
};

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

export type SdkMcpToolDefinition<Schema extends AnyZodRawShape = AnyZodRawShape> = {
  name: string;
  description: string;
  inputSchema: Schema;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
  handler: BivariantAsyncHandler<InferShape<Schema>, unknown, CallToolResult>;
};

export type InferShape<T extends AnyZodRawShape> = {
  [K in keyof T]: T[K] extends { _output: infer O } ? O : never;
};

export type BivariantAsyncHandler<Args, Extra, Result> = {
  bivarianceHack(args: Args, extra: Extra): Promise<Result>;
}["bivarianceHack"];

export type TaskBudget = {
  total: number;
};

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
    | {
        type: "preset";
        preset: "claude_code";
        append?: string;
      };
  spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess;
};

export type Settings = Record<string, unknown>;

export type SDKBaseMessage = {
  type: string;
  uuid?: UUID;
  session_id?: string;
};

export type SDKUserMessage = SDKBaseMessage & {
  type: "user";
  message: MessageParam;
  parent_tool_use_id: string | null;
  isSynthetic?: boolean;
  tool_use_result?: unknown;
  priority?: "now" | "next" | "later";
  timestamp?: string;
};

export type SDKAssistantMessage = SDKBaseMessage & {
  type: "assistant";
  message: Record<string, unknown>;
  parent_tool_use_id?: string | null;
  error?: SDKAssistantMessageError;
};

export type SDKResultMessage = SDKResultSuccess | SDKResultError;

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

export type SDKPartialAssistantMessage = SDKBaseMessage & {
  type: "stream_event";
  event: BetaRawMessageStreamEvent;
  parent_tool_use_id: string | null;
};

export type SDKRateLimitEvent = SDKBaseMessage & {
  type: "rate_limit_event";
  rate_limit_info: SDKRateLimitInfo;
};

export type SDKToolProgressMessage = SDKBaseMessage & {
  type: "tool_progress";
  tool_use_id: string;
  tool_name: string;
  parent_tool_use_id: string | null;
  elapsed_time_seconds: number;
  task_id?: string;
};

export type SDKToolUseSummaryMessage = SDKBaseMessage & {
  type: "tool_use_summary";
  summary: string;
  preceding_tool_use_ids: string[];
};

export type SDKPromptSuggestionMessage = SDKBaseMessage & {
  type: "prompt_suggestion";
  suggestion: string;
};

export type SDKUserMessageReplay = SDKBaseMessage & {
  type: "user";
  message: MessageParam;
  parent_tool_use_id: string | null;
  isSynthetic?: boolean;
  tool_use_result?: unknown;
  priority?: "now" | "next" | "later";
  timestamp?: string;
  uuid: UUID;
  session_id: string;
  isReplay: true;
  file_attachments?: unknown[];
};

export type SDKAuthStatusMessage = {
  type: "auth_status";
  isAuthenticating: boolean;
  output: string[];
  error?: string;
  uuid: UUID;
  session_id: string;
};

export type SDKResultSuccess = {
  type: "result";
  subtype: "success";
  duration_ms: number;
  duration_api_ms: number;
  is_error: boolean;
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

export type SDKElicitationCompleteMessage = {
  type: "system";
  subtype: "elicitation_complete";
  mcp_server_name: string;
  elicitation_id: string;
  uuid: UUID;
  session_id: string;
};

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

export type SDKHookStartedMessage = {
  type: "system";
  subtype: "hook_started";
  hook_id: string;
  hook_name: string;
  hook_event: string;
  uuid: UUID;
  session_id: string;
};

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

export type SDKLocalCommandOutputMessage = {
  type: "system";
  subtype: "local_command_output";
  content: string;
  uuid: UUID;
  session_id: string;
};

export type SDKSessionStateChangedMessage = {
  type: "system";
  subtype: "session_state_changed";
  state: "idle" | "running" | "requires_action";
  uuid: UUID;
  session_id: string;
};

export type SDKStatusMessage = {
  type: "system";
  subtype: "status";
  status: SDKStatus;
  permissionMode?: PermissionMode;
  uuid: UUID;
  session_id: string;
};

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
  uuid: UUID;
  session_id: string;
};

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

export type SDKTaskStartedMessage = {
  type: "system";
  subtype: "task_started";
  task_id: string;
  tool_use_id?: string;
  description: string;
  task_type?: string;
  workflow_name?: string;
  prompt?: string;
  uuid: UUID;
  session_id: string;
};

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
  | SDKTaskNotificationMessage
  | SDKTaskStartedMessage
  | SDKTaskProgressMessage
  | SDKSessionStateChangedMessage
  | SDKAuthStatusMessage
  | SDKFilesPersistedEvent
  | SDKElicitationCompleteMessage;

export type SDKControlInitializeResponse = {
  commands: SlashCommand[];
  agents: AgentInfo[];
  output_style: string;
  available_output_styles: string[];
  models: ModelInfo[];
  account: AccountInfo;
  fast_mode_state?: FastModeState;
};

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

export type RewindFilesResult = {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
};

export type ForkSessionResult = {
  sessionId: string;
};

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

export interface SDKSession {
  readonly sessionId: string;
  send(message: string | SDKUserMessage): Promise<void>;
  stream(): AsyncGenerator<SDKMessage, void>;
  close(): void;
  [Symbol.asyncDispose](): Promise<void>;
}

export type SDKSessionOptions = Options;

export type SessionMessage = {
  type: "user" | "assistant" | "system";
  uuid: string;
  session_id: string;
  message: unknown;
  parent_tool_use_id: null;
};

export type SessionMutationOptions = {
  dir?: string;
};

export type ListSessionsOptions = {
  dir?: string;
  limit?: number;
  offset?: number;
  includeWorktrees?: boolean;
};

export type GetSessionInfoOptions = {
  dir?: string;
};

export type GetSessionMessagesOptions = {
  dir?: string;
  limit?: number;
  offset?: number;
  includeSystemMessages?: boolean;
};

export type GetSubagentMessagesOptions = {
  dir?: string;
  limit?: number;
  offset?: number;
  includeSystemMessages?: boolean;
};

export type ListSubagentsOptions = {
  dir?: string;
  limit?: number;
  offset?: number;
};

export type ForkSessionOptions = SessionMutationOptions & {
  upToMessageId?: string;
  title?: string;
};

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
    };

export interface Transport {
  write(data: string): Promise<void>;
  close(): void;
  isReady(): boolean;
  readMessages(): AsyncGenerator<StdoutMessage, void, unknown>;
  endInput(): void;
}

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

export type SDKControlRequestInner =
  | {
      subtype: "initialize";
      hooks?: Partial<
        Record<HookEvent, Array<{ matcher?: string; hookCallbackIds: string[]; timeout?: number }>>
      >;
      sdkMcpServers?: string[];
      jsonSchema?: Record<string, unknown>;
      systemPrompt?: string;
      appendSystemPrompt?: string;
      agents?: Record<string, AgentDefinition>;
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

export type SDKControlRequest = {
  type: "control_request";
  request_id: string;
  request: SDKControlRequestInner;
};

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
