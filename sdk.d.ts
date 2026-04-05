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
  JSONRPCMessage,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape } from "zod";
export declare class AbortError extends Error {
  constructor(message?: string);
}
export declare const EXIT_REASONS: readonly [
  "clear",
  "resume",
  "logout",
  "prompt_input_exit",
  "other",
  "bypass_permissions_disabled",
];
export declare const HOOK_EVENTS: readonly [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "PermissionRequest",
  "PermissionDenied",
  "Setup",
  "TeammateIdle",
  "TaskCreated",
  "TaskCompleted",
  "Elicitation",
  "ElicitationResult",
  "ConfigChange",
  "WorktreeCreate",
  "WorktreeRemove",
  "InstructionsLoaded",
  "CwdChanged",
  "FileChanged",
];
export type UUID = string;
export type AnyZodRawShape = ZodRawShape;
export type ApiKeySource = "user" | "project" | "org" | "temporary" | "oauth";
export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk";
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
export type UserPromptSubmitHookInput = BaseHookInput & {
  hook_event_name: "UserPromptSubmit";
  prompt: string;
};
export type SessionStartHookInput = BaseHookInput & {
  hook_event_name: "SessionStart";
  source: "startup" | "resume" | "clear" | "compact";
  agent_type?: string;
  model?: string;
};
export type SessionEndHookInput = BaseHookInput & {
  hook_event_name: "SessionEnd";
  reason: ExitReason;
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
export type PostCompactHookInput = BaseHookInput & {
  hook_event_name: "PostCompact";
  trigger: "manual" | "auto";
  compact_summary: string;
};
export type PermissionRequestHookInput = BaseHookInput & {
  hook_event_name: "PermissionRequest";
  tool_name: string;
  tool_input: unknown;
  permission_suggestions?: PermissionUpdate[];
};
export type SetupHookInput = BaseHookInput & {
  hook_event_name: "Setup";
  trigger: "init" | "maintenance";
};
export type TeammateIdleHookInput = BaseHookInput & {
  hook_event_name: "TeammateIdle";
  teammate_name: string;
  team_name: string;
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
  options: {
    signal: AbortSignal;
  },
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
export type ThinkingAdaptive = {
  type: "adaptive";
};
export type ThinkingEnabled = {
  type: "enabled";
  budgetTokens?: number;
};
export type ThinkingDisabled = {
  type: "disabled";
};
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
  id?: string;
  name?: string;
  display_name?: string;
  description?: string;
  supports_thinking?: boolean;
  [key: string]: unknown;
};
export type SdkMcpToolDefinition<Schema extends AnyZodRawShape = AnyZodRawShape> = {
  name: string;
  description: string;
  inputSchema: Schema;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
  handler: BivariantAsyncHandler<InferShape<Schema>, unknown, CallToolResult>;
};
export type SdkMcpToolExtras = {
  annotations?: ToolAnnotations;
  searchHint?: string;
  alwaysLoad?: boolean;
};
export type CreateSdkMcpServerOptions = {
  name: string;
  version?: string;
  tools?: Array<SdkMcpToolDefinition>;
};
export type InferShape<T extends AnyZodRawShape> = {
  [K in keyof T]: T[K] extends {
    _output: infer O;
  }
    ? O
    : never;
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
  tools?:
    | string[]
    | {
        type: "preset";
        preset: "claude_code";
      };
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
  persistSession?: boolean;
  includeHookEvents?: boolean;
  includePartialMessages?: boolean;
  thinking?: ThinkingConfig;
  effort?: EffortLevel;
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
  [key: string]: unknown;
};
export type SDKUserMessage = SDKBaseMessage & {
  type: "user";
  message: Record<string, unknown>;
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
  error?: unknown;
};
export type SDKResultMessage = SDKBaseMessage & {
  type: "result";
  subtype:
    | "success"
    | "error_during_execution"
    | "error_max_turns"
    | "error_max_budget_usd"
    | "error_max_structured_output_retries";
  duration_ms: number;
  duration_api_ms: number;
  is_error: boolean;
  num_turns: number;
  stop_reason?: string | null;
  total_cost_usd?: number;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, unknown>;
  permission_denials?: Array<Record<string, unknown>>;
  errors?: string[];
  result?: string;
  structured_output?: unknown;
};
export type SDKSystemMessage = SDKBaseMessage & {
  type: "system";
  subtype: string;
};
export type SDKPartialAssistantMessage = SDKBaseMessage & {
  type: "stream_event";
  event: unknown;
  parent_tool_use_id: string | null;
};
export type SDKRateLimitEvent = SDKBaseMessage & {
  type: "rate_limit_event";
  rate_limit_info: Record<string, unknown>;
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
export type SDKMessage =
  | SDKUserMessage
  | SDKAssistantMessage
  | SDKResultMessage
  | SDKSystemMessage
  | SDKPartialAssistantMessage
  | SDKRateLimitEvent
  | SDKToolProgressMessage
  | SDKToolUseSummaryMessage
  | SDKPromptSuggestionMessage;
export type SDKControlInitializeResponse = {
  commands: SlashCommand[];
  agents: AgentInfo[];
  output_style: string;
  available_output_styles: string[];
  models: ModelInfo[];
  account: AccountInfo;
  fast_mode_state?: "off" | "cooldown" | "on";
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
  [key: string]: unknown;
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
export type SDKSessionOptions = {
  model: string;
  pathToClaudeCodeExecutable?: string;
  executable?: "node" | "bun";
  executableArgs?: string[];
  env?: {
    [envVar: string]: string | undefined;
  };
  allowedTools?: string[];
  disallowedTools?: string[];
  canUseTool?: CanUseTool;
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  permissionMode?: PermissionMode;
};
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
  streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>;
  stopTask(taskId: string): Promise<void>;
  close(): void;
}
export type SDKControlRequestInner =
  | {
      subtype: "initialize";
      hooks?: Partial<
        Record<
          HookEvent,
          Array<{
            matcher?: string;
            hookCallbackIds: string[];
            timeout?: number;
          }>
        >
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
      subtype: "set_permission_mode";
      mode: PermissionMode;
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
export declare function query(params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query;
export declare function tool<Schema extends AnyZodRawShape>(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>,
  extras?: SdkMcpToolExtras,
): SdkMcpToolDefinition<Schema>;
export declare function createSdkMcpServer(
  options: CreateSdkMcpServerOptions,
): McpSdkServerConfigWithInstance;
export declare function listSessions(options?: ListSessionsOptions): Promise<SDKSessionInfo[]>;
export declare function getSessionInfo(
  sessionId: string,
  options?: GetSessionInfoOptions,
): Promise<SDKSessionInfo | undefined>;
export declare function getSessionMessages(
  sessionId: string,
  options?: GetSessionMessagesOptions,
): Promise<SessionMessage[]>;
export declare function listSubagents(
  sessionId: string,
  options?: ListSubagentsOptions,
): Promise<string[]>;
export declare function getSubagentMessages(
  sessionId: string,
  agentId: string,
  options?: GetSubagentMessagesOptions,
): Promise<SessionMessage[]>;
export declare function renameSession(
  sessionId: string,
  title: string,
  options?: SessionMutationOptions,
): Promise<void>;
export declare function tagSession(
  sessionId: string,
  tag: string | null,
  options?: SessionMutationOptions,
): Promise<void>;
export declare function deleteSession(
  sessionId: string,
  options?: SessionMutationOptions,
): Promise<void>;
export declare function forkSession(
  sessionId: string,
  options?: ForkSessionOptions,
): Promise<ForkSessionResult>;
export declare function unstable_v2_createSession(_options: SDKSessionOptions): SDKSession;
export declare function unstable_v2_prompt(
  _message: string,
  _options: SDKSessionOptions,
): Promise<SDKResultMessage>;
export declare function unstable_v2_resumeSession(
  _sessionId: string,
  _options: SDKSessionOptions,
): SDKSession;
