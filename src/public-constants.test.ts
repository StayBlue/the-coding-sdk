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

import { expect, test } from "bun:test";
import { EXIT_REASONS, HOOK_EVENTS, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "./public-constants.ts";

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

test("SYSTEM_PROMPT_DYNAMIC_BOUNDARY matches upstream sentinel", () => {
  expect(SYSTEM_PROMPT_DYNAMIC_BOUNDARY).toBe("__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__");
});
