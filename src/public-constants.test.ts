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
import { EXIT_REASONS, HOOK_EVENTS } from "./public-constants.ts";

test("EXIT_REASONS contains expected values", () => {
  expect(EXIT_REASONS).toContain("clear");
  expect(EXIT_REASONS).toContain("resume");
  expect(EXIT_REASONS).toContain("logout");
  expect(EXIT_REASONS.length).toBeGreaterThanOrEqual(5);
});

test("HOOK_EVENTS contains expected values", () => {
  expect(HOOK_EVENTS).toContain("PreToolUse");
  expect(HOOK_EVENTS).toContain("PostToolUse");
  expect(HOOK_EVENTS).toContain("Stop");
  expect(HOOK_EVENTS).toContain("Notification");
  expect(HOOK_EVENTS.length).toBeGreaterThanOrEqual(10);
});
