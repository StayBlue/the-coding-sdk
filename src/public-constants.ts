/*
 * This file incorporates material from claude-agent-sdk-python, licensed under
 * the MIT License:
 *
 * Copyright (c) 2025 Anthropic, PBC
 *
 * Modifications Copyright 2026 StayBlue, licensed under the Apache License,
 * Version 2.0. See the LICENSE file in the project root for details.
 */

export const EXIT_REASONS = [
  "clear",
  "resume",
  "logout",
  "prompt_input_exit",
  "other",
  "bypass_permissions_disabled",
] as const;

export const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "PreCompact",
  "Notification",
  "SubagentStart",
  "PermissionRequest",
] as const;
