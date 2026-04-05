/*
 * This file incorporates material from claude-agent-sdk-python, licensed under
 * the MIT License:
 *
 * Copyright (c) 2025 Anthropic, PBC
 *
 * Modifications Copyright 2026 StayBlue, licensed under the Apache License,
 * Version 2.0. See the LICENSE file in the project root for details.
 */

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  statSync,
  unlinkSync,
  writeSync,
  closeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { ClaudeSDKError } from "./errors.ts";
import { QueryController, createUserPromptMessage } from "./query.ts";
import { SubprocessCLITransport } from "./subprocess-transport.ts";
import { tryCatchSync } from "./try-catch.ts";
import type {
  ForkSessionOptions,
  ForkSessionResult,
  GetSessionInfoOptions,
  GetSessionMessagesOptions,
  GetSubagentMessagesOptions as _GetSubagentMessagesOptions,
  ListSubagentsOptions,
  ListSessionsOptions,
  SDKMessage,
  SDKResultMessage,
  SDKSession,
  SDKSessionOptions,
  SDKSessionInfo,
  SDKUserMessage,
  SessionMessage,
  SessionMutationOptions,
} from "./types.ts";

const LITE_READ_BUF_SIZE = 65_536;
const MAX_SANITIZED_LENGTH = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKIP_FIRST_PROMPT_RE =
  /^(?:<local-command-stdout>|<session-start-hook>|<tick>|<goal>|\[Request interrupted by user[^\]]*\]|\s*<ide_opened_file>[\s\S]*<\/ide_opened_file>\s*$|\s*<ide_selection>[\s\S]*<\/ide_selection>\s*$)/;
const COMMAND_NAME_RE = /<command-name>(.*?)<\/command-name>/;
const SANITIZE_RE = /[^a-zA-Z0-9]/g;

type TranscriptEntry = Record<string, unknown>;

type SessionClassOptions = SDKSessionOptions & {
  sessionId?: string;
};

class RuntimeSDKSession implements SDKSession {
  #controller: QueryController;
  #sessionId: string | undefined;
  #closed = false;

  constructor(options: SessionClassOptions) {
    const transport = new SubprocessCLITransport(options);
    const controller = new QueryController({ transport, options });
    this.#controller = controller;
    this.#sessionId = options.sessionId;

    const startup = (async () => {
      await transport.connect();
      controller.start().catch(() => {});
      await controller.initialize();
    })();
    controller.setStartupPromise(startup);
  }

  get sessionId(): string {
    if (this.#sessionId === undefined) {
      throw new ClaudeSDKError("Session has not been initialized yet");
    }
    return this.#sessionId;
  }

  async send(message: string | SDKUserMessage): Promise<void> {
    await this.#controller.initializationResult();
    if (this.#closed) {
      throw new ClaudeSDKError("Session is closed");
    }

    if (typeof message === "string") {
      await this.#controller.sendUserMessage(
        createUserPromptMessage(message, this.#sessionId ?? ""),
      );
      return;
    }

    await this.#controller.sendUserMessage({
      ...message,
      session_id: (message as { session_id?: string }).session_id ?? this.#sessionId ?? "",
    });
  }

  async *stream(): AsyncGenerator<SDKMessage, void> {
    await this.#controller.initializationResult();

    for await (const message of this.#controller) {
      if (this.#sessionId === undefined) {
        const candidate = message as { session_id?: string };
        if (typeof candidate.session_id === "string" && candidate.session_id.length > 0) {
          this.#sessionId = candidate.session_id;
        }
      }
      yield message;
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#controller.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.close();
  }
}

function toQuerySessionOptions(options: SDKSessionOptions): SessionClassOptions {
  const mapped: SessionClassOptions = {
    model: options.model,
  };

  if (options.pathToClaudeCodeExecutable != null) {
    mapped.pathToClaudeCodeExecutable = options.pathToClaudeCodeExecutable;
  }
  if (options.executable != null) {
    mapped.executable = options.executable;
  }
  if (options.executableArgs != null) {
    mapped.executableArgs = options.executableArgs;
  }
  if (options.env != null) {
    mapped.env = options.env;
  }
  if (options.allowedTools != null) {
    mapped.allowedTools = options.allowedTools;
  }
  if (options.disallowedTools != null) {
    mapped.disallowedTools = options.disallowedTools;
  }
  if (options.canUseTool != null) {
    mapped.canUseTool = options.canUseTool;
  }
  if (options.hooks != null) {
    mapped.hooks = options.hooks;
  }
  if (options.permissionMode != null) {
    mapped.permissionMode = options.permissionMode;
  }

  return mapped;
}

export function unstable_v2_createSession(_options: SDKSessionOptions): SDKSession {
  return new RuntimeSDKSession(toQuerySessionOptions(_options));
}

export async function unstable_v2_prompt(
  message: string,
  options: SDKSessionOptions,
): Promise<SDKResultMessage> {
  const session = unstable_v2_createSession(options);

  try {
    await session.send(message);
    for await (const event of session.stream()) {
      if (event.type === "result") {
        return event as SDKResultMessage;
      }
    }
    throw new Error("Session ended without result message");
  } finally {
    session.close();
  }
}

export function unstable_v2_resumeSession(
  _sessionId: string,
  _options: SDKSessionOptions,
): SDKSession {
  return new RuntimeSDKSession({
    ...toQuerySessionOptions(_options),
    sessionId: _sessionId,
  });
}

type LiteSessionFile = {
  mtime: number;
  size: number;
  head: string;
  tail: string;
};

export async function listSessions(options: ListSessionsOptions = {}): Promise<SDKSessionInfo[]> {
  const directories = collectProjectDirectories(options.dir, options.includeWorktrees !== false);
  const sessions: SDKSessionInfo[] = [];
  const seen = new Set<string>();

  for (const directory of directories) {
    if (!existsSync(directory)) {
      continue;
    }

    const { data: dirContents } = tryCatchSync(
      () => readdirSync(directory, { withFileTypes: true }) as import("node:fs").Dirent[],
    );
    if (!dirContents) {
      continue;
    }

    for (const entry of dirContents) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      const sessionId = entry.name.slice(0, -".jsonl".length);
      if (!isUuid(sessionId) || seen.has(sessionId)) {
        continue;
      }
      seen.add(sessionId);

      const info = readSessionInfo(join(directory, entry.name), sessionId);
      if (info) {
        sessions.push(info);
      }
    }
  }

  sessions.sort((left, right) => right.lastModified - left.lastModified);
  return paginate(sessions, options.limit, options.offset);
}

export async function getSessionInfo(
  sessionId: string,
  options: GetSessionInfoOptions = {},
): Promise<SDKSessionInfo | undefined> {
  const located = findSessionFile(sessionId, options.dir);
  if (!located) {
    return undefined;
  }
  return readSessionInfo(located.filePath, sessionId);
}

export async function getSessionMessages(
  sessionId: string,
  options: GetSessionMessagesOptions = {},
): Promise<SessionMessage[]> {
  const located = findSessionFile(sessionId, options.dir);
  if (!located) {
    return [];
  }

  const content = readSessionFileContent(located.filePath);
  const entries = parseTranscript(content);
  const chain = buildConversationChain(entries);
  const filtered = chain.filter((entry) =>
    isVisibleMessage(entry, Boolean(options.includeSystemMessages)),
  );

  return paginate(filtered.map(toSessionMessage), options.limit, options.offset);
}

export async function listSubagents(
  sessionId: string,
  options: ListSubagentsOptions = {},
): Promise<string[]> {
  const located = findSessionFile(sessionId, options.dir);
  if (!located) {
    return [];
  }

  const subagentsDir = join(located.projectDir, sessionId, "subagents");
  if (!existsSync(subagentsDir)) {
    return [];
  }

  const { data: dirEntries } = tryCatchSync(() => readdirSync(subagentsDir));
  if (!dirEntries) {
    return [];
  }

  const agents = dirEntries
    .filter((name) => name.startsWith("agent-") && name.endsWith(".jsonl"))
    .map((name) => name.slice("agent-".length, -".jsonl".length))
    .sort((a, b) => a.localeCompare(b));
  return paginate(agents, options.limit, options.offset);
}

export async function getSubagentMessages(
  sessionId: string,
  agentId: string,
  options: _GetSubagentMessagesOptions = {},
): Promise<SessionMessage[]> {
  const located = findSessionFile(sessionId, options.dir);
  if (!located) {
    return [];
  }

  const transcriptPath = join(located.projectDir, sessionId, "subagents", `agent-${agentId}.jsonl`);
  if (!existsSync(transcriptPath)) {
    return [];
  }

  const entries = parseTranscript(readSessionFileContent(transcriptPath));
  const chain = buildConversationChain(entries);
  return paginate(
    chain
      .filter((entry) => isVisibleMessage(entry, Boolean(options.includeSystemMessages)))
      .map(toSessionMessage),
    options.limit,
    options.offset,
  );
}

export async function renameSession(
  sessionId: string,
  title: string,
  options: SessionMutationOptions = {},
): Promise<void> {
  assertUuid(sessionId, "sessionId");
  const trimmed = title.trim();
  if (!trimmed) {
    throw new ClaudeSDKError("title must be non-empty");
  }
  appendToSession(
    sessionId,
    JSON.stringify(
      {
        type: "custom-title",
        customTitle: trimmed,
        sessionId,
      },
      null,
      0,
    ) + "\n",
    options.dir,
  );
}

export async function tagSession(
  sessionId: string,
  tag: string | null,
  options: SessionMutationOptions = {},
): Promise<void> {
  assertUuid(sessionId, "sessionId");
  const normalized = tag == null ? "" : sanitizeUnicode(tag).trim();
  if (tag != null && !normalized) {
    throw new ClaudeSDKError("tag must be non-empty");
  }

  appendToSession(
    sessionId,
    JSON.stringify(
      {
        type: "tag",
        tag: normalized,
        sessionId,
      },
      null,
      0,
    ) + "\n",
    options.dir,
  );
}

export async function deleteSession(
  sessionId: string,
  options: SessionMutationOptions = {},
): Promise<void> {
  assertUuid(sessionId, "sessionId");
  const located = findSessionFile(sessionId, options.dir);
  if (!located) {
    throw new ClaudeSDKError(`Session ${sessionId} not found`);
  }
  const { error } = tryCatchSync(() => unlinkSync(located.filePath));
  if (error) {
    throw new ClaudeSDKError(`Failed to delete session file: ${error.message}`);
  }
}

export async function forkSession(
  sessionId: string,
  options: ForkSessionOptions = {},
): Promise<ForkSessionResult> {
  assertUuid(sessionId, "sessionId");
  if (options.upToMessageId) {
    assertUuid(options.upToMessageId, "upToMessageId");
  }

  const located = findSessionFile(sessionId, options.dir);
  if (!located) {
    throw new ClaudeSDKError(`Session ${sessionId} not found`);
  }

  const content = readSessionFileContent(located.filePath);
  const entries = parseTranscript(content).filter((entry) => entry.isSidechain !== true);
  if (entries.length === 0) {
    throw new ClaudeSDKError(`Session ${sessionId} has no transcript entries`);
  }

  const writable = entries.filter((entry) => entry.type !== "progress");
  let truncated = writable;
  if (options.upToMessageId) {
    const index = writable.findIndex((entry) => entry.uuid === options.upToMessageId);
    if (index === -1) {
      throw new ClaudeSDKError(
        `Message ${options.upToMessageId} not found in session ${sessionId}`,
      );
    }
    truncated = writable.slice(0, index + 1);
  }

  const forkedSessionId = randomUUID();
  const lines = remapEntryUuids(truncated, forkedSessionId, sessionId);

  const existingInfo = readSessionInfo(located.filePath, sessionId);
  const baseTitle =
    options.title?.trim() || existingInfo?.customTitle || existingInfo?.summary || "Forked session";

  lines.push(
    JSON.stringify({
      type: "custom-title",
      sessionId: forkedSessionId,
      customTitle: options.title?.trim() || `${baseTitle} (fork)`,
    }),
  );

  const targetPath = join(located.projectDir, `${forkedSessionId}.jsonl`);
  writeFileAtomic(targetPath, `${lines.join("\n")}\n`);

  return {
    sessionId: forkedSessionId,
  };
}

function readSessionFileContent(filePath: string): string {
  const { data, error } = tryCatchSync(() => readFileSync(filePath, "utf8"));
  if (error) {
    throw new ClaudeSDKError(`Failed to read session file: ${error.message}`);
  }
  return data;
}

function remapEntryUuids(
  entries: TranscriptEntry[],
  forkedSessionId: string,
  sourceSessionId: string,
): string[] {
  const uuidMap = new Map<string, string>();
  for (const entry of entries) {
    if (typeof entry.uuid === "string") {
      uuidMap.set(entry.uuid, randomUUID());
    }
  }

  const now = new Date().toISOString();
  return entries.map((entry) => {
    const oldUuid = typeof entry.uuid === "string" ? entry.uuid : randomUUID();
    const oldParent = typeof entry.parentUuid === "string" ? entry.parentUuid : undefined;

    const cloned: TranscriptEntry = {
      ...entry,
      uuid: uuidMap.get(oldUuid) ?? randomUUID(),
      sessionId: forkedSessionId,
      timestamp: now,
      isSidechain: false,
      forkedFrom: {
        sessionId: sourceSessionId,
        messageUuid: oldUuid,
      },
    };

    if (oldParent) {
      cloned.parentUuid = uuidMap.get(oldParent);
    } else {
      delete cloned.parentUuid;
    }

    delete cloned.teamName;
    delete cloned.agentName;
    delete cloned.slug;
    delete cloned.sourceToolAssistantUUID;

    return JSON.stringify(cloned);
  });
}

function readSessionInfo(filePath: string, sessionId: string): SDKSessionInfo | undefined {
  const lite = readSessionLite(filePath);
  if (!lite) {
    return undefined;
  }

  const firstPrompt = extractFirstPromptFromHead(lite.head);
  const summary =
    extractLastJsonStringField(lite.tail, "customTitle") ||
    extractLastJsonStringField(lite.tail, "aiTitle") ||
    extractLastJsonStringField(lite.head, "customTitle") ||
    extractLastJsonStringField(lite.head, "aiTitle") ||
    firstPrompt ||
    basename(filePath, ".jsonl");

  if (!summary) {
    return undefined;
  }

  return {
    sessionId,
    summary,
    lastModified: lite.mtime,
    fileSize: lite.size,
    ...optionalProperty(
      "customTitle",
      extractLastJsonStringField(lite.tail, "customTitle") ||
        extractLastJsonStringField(lite.head, "customTitle"),
    ),
    ...optionalProperty("firstPrompt", firstPrompt),
    ...optionalProperty(
      "gitBranch",
      extractLastJsonStringField(lite.tail, "gitBranch") ||
        extractLastJsonStringField(lite.head, "gitBranch"),
    ),
    ...optionalProperty(
      "cwd",
      extractLastJsonStringField(lite.tail, "cwd") || extractLastJsonStringField(lite.head, "cwd"),
    ),
    ...optionalProperty(
      "tag",
      normalizeOptionalTag(
        extractLastJsonStringField(lite.tail, "tag") ||
          extractLastJsonStringField(lite.head, "tag"),
      ),
    ),
    ...optionalProperty(
      "createdAt",
      parseTimestampToEpoch(extractJsonStringField(lite.head, "timestamp")),
    ),
  };
}

function optionalProperty<Key extends string, Value>(
  key: Key,
  value: Value | null | undefined,
): Partial<Record<Key, Value>> {
  return value == null ? {} : ({ [key]: value } as Record<Key, Value>);
}

function readSessionLite(filePath: string): LiteSessionFile | undefined {
  const { data: fd, error: openError } = tryCatchSync(() => openSync(filePath, "r"));
  if (openError) {
    if ((openError as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new ClaudeSDKError(`Failed to read session file: ${openError.message}`);
  }

  try {
    const stats = statSync(filePath);
    if (stats.size <= 0) {
      return undefined;
    }

    const bufSize = Math.min(stats.size, LITE_READ_BUF_SIZE);
    const headBuffer = Buffer.alloc(bufSize);
    readSync(fd, headBuffer, 0, bufSize, 0);

    const tailBuffer = Buffer.alloc(bufSize);
    readSync(fd, tailBuffer, 0, bufSize, Math.max(0, stats.size - bufSize));

    return {
      mtime: Math.trunc(stats.mtimeMs),
      size: stats.size,
      head: headBuffer.toString("utf8"),
      tail: tailBuffer.toString("utf8"),
    };
  } finally {
    closeSync(fd);
  }
}

function parseTranscript(content: string): TranscriptEntry[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const entry = JSON.parse(line) as TranscriptEntry;
        if (entry && typeof entry === "object" && typeof entry.uuid === "string") {
          return [entry];
        }
      } catch {
        return [];
      }
      return [];
    });
}

function buildConversationChain(entries: TranscriptEntry[]): TranscriptEntry[] {
  if (entries.length === 0) {
    return [];
  }

  const byUuid = new Map<string, TranscriptEntry>();
  const parentUuids = new Set<string>();
  const order = new Map<string, number>();

  entries.forEach((entry, index) => {
    if (typeof entry.uuid === "string") {
      byUuid.set(entry.uuid, entry);
      order.set(entry.uuid, index);
    }
    if (typeof entry.parentUuid === "string") {
      parentUuids.add(entry.parentUuid);
    }
  });

  const leaves = entries.filter((entry) => {
    const uuid = typeof entry.uuid === "string" ? entry.uuid : "";
    return uuid && !parentUuids.has(uuid);
  });

  if (leaves.length === 0) {
    return [];
  }

  const bestLeaf = [...leaves].sort((left, right) => {
    const leftMeta = Boolean(left.isSidechain || left.teamName || left.isMeta);
    const rightMeta = Boolean(right.isSidechain || right.teamName || right.isMeta);
    if (leftMeta !== rightMeta) {
      return leftMeta ? 1 : -1;
    }
    const leftIndex = order.get(String(left.uuid)) ?? -1;
    const rightIndex = order.get(String(right.uuid)) ?? -1;
    return rightIndex - leftIndex;
  })[0];

  const chain: TranscriptEntry[] = [];
  const seen = new Set<string>();
  let current: TranscriptEntry | undefined = bestLeaf;
  while (current && typeof current.uuid === "string" && !seen.has(current.uuid)) {
    seen.add(current.uuid);
    chain.push(current);
    current = typeof current.parentUuid === "string" ? byUuid.get(current.parentUuid) : undefined;
  }

  chain.reverse();
  return chain;
}

function isVisibleMessage(entry: TranscriptEntry, includeSystemMessages: boolean): boolean {
  const type = entry.type;
  if (entry.isMeta || entry.isSidechain || entry.teamName) {
    return false;
  }
  if (type === "user" || type === "assistant") {
    return true;
  }
  return includeSystemMessages && type === "system";
}

function toSessionMessage(entry: TranscriptEntry): SessionMessage {
  return {
    type: entry.type === "assistant" ? "assistant" : entry.type === "system" ? "system" : "user",
    uuid: String(entry.uuid ?? ""),
    session_id: String(entry.sessionId ?? ""),
    message: entry.message,
    parent_tool_use_id: null,
  };
}

function appendToSession(sessionId: string, data: string, dir?: string): void {
  const located = findSessionFile(sessionId, dir);
  if (!located) {
    throw new ClaudeSDKError(`Session ${sessionId} not found`);
  }

  const { error } = tryCatchSync(() => {
    const fd = openSync(located.filePath, "a");
    try {
      writeSync(fd, data);
    } finally {
      closeSync(fd);
    }
  });
  if (error) {
    throw new ClaudeSDKError(`Failed to write to session file: ${error.message}`);
  }
}

function findSessionFile(
  sessionId: string,
  dir?: string,
): { filePath: string; projectDir: string } | undefined {
  if (!isUuid(sessionId)) {
    return undefined;
  }

  const targetName = `${sessionId}.jsonl`;
  for (const projectDir of collectProjectDirectories(dir, true)) {
    const filePath = join(projectDir, targetName);
    if (existsSync(filePath) && statSync(filePath).size > 0) {
      return { filePath, projectDir };
    }
  }
  return undefined;
}

function collectProjectDirectories(dir?: string, includeWorktrees = true): string[] {
  if (!dir) {
    const projectsDir = getProjectsDir();
    if (!existsSync(projectsDir)) {
      return [];
    }
    const { data: entries } = tryCatchSync(
      () => readdirSync(projectsDir, { withFileTypes: true }) as import("node:fs").Dirent[],
    );
    return entries
      ? entries.filter((entry) => entry.isDirectory()).map((entry) => join(projectsDir, entry.name))
      : [];
  }

  const canonical = canonicalizePath(dir);
  const discovered: string[] = [];
  const direct = findProjectDir(canonical);
  if (direct) {
    discovered.push(direct);
  }

  if (includeWorktrees) {
    for (const worktree of getWorktreePaths(canonical)) {
      if (worktree === canonical) {
        continue;
      }
      const projectDir = findProjectDir(worktree);
      if (projectDir && !discovered.includes(projectDir)) {
        discovered.push(projectDir);
      }
    }
  }

  return discovered;
}

function getProjectsDir(): string {
  return join(getClaudeConfigHomeDir(), "projects");
}

function getClaudeConfigHomeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR
    ? resolve(process.env.CLAUDE_CONFIG_DIR)
    : join(homedir(), ".claude");
}

function getProjectDir(projectPath: string): string {
  return join(getProjectsDir(), sanitizePath(projectPath));
}

function findProjectDir(projectPath: string): string | undefined {
  const exact = getProjectDir(projectPath);
  if (existsSync(exact)) {
    return exact;
  }

  const sanitized = sanitizePath(projectPath);
  if (sanitized.length <= MAX_SANITIZED_LENGTH) {
    return undefined;
  }

  const prefix = sanitized.slice(0, MAX_SANITIZED_LENGTH);
  const projectsDir = getProjectsDir();
  if (!existsSync(projectsDir)) {
    return undefined;
  }

  const { data: entries } = tryCatchSync(
    () => readdirSync(projectsDir, { withFileTypes: true }) as import("node:fs").Dirent[],
  );
  if (!entries) {
    return undefined;
  }

  const match = entries.find((entry) => entry.isDirectory() && entry.name.startsWith(`${prefix}-`));
  return match ? join(projectsDir, match.name) : undefined;
}

function getWorktreePaths(cwd: string): string[] {
  const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0 || !result.stdout) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => canonicalizePath(line.slice("worktree ".length).trim()));
}

function sanitizePath(value: string): string {
  const sanitized = value.replace(SANITIZE_RE, "-");
  if (sanitized.length <= MAX_SANITIZED_LENGTH) {
    return sanitized;
  }
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${simpleHash(value)}`;
}

function simpleHash(value: string): string {
  let hash = 0;
  for (const char of value) {
    hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  }
  const positive = hash >>> 0;
  return positive.toString(36);
}

function canonicalizePath(value: string): string {
  const { data } = tryCatchSync(() => resolve(value).normalize("NFC"));
  return data ?? value.normalize("NFC");
}

function extractJsonStringField(text: string, key: string): string | undefined {
  const regex = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"])*)"`);
  const match = regex.exec(text);
  if (!match) {
    return undefined;
  }
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return undefined;
  }
}

function extractLastJsonStringField(text: string, key: string): string | undefined {
  const regex = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"])*)"`, "g");
  let match: RegExpExecArray | null = null;
  let last: string | undefined;
  while ((match = regex.exec(text))) {
    try {
      last = JSON.parse(`"${match[1]}"`) as string;
    } catch {
      // skip malformed escape sequences
    }
  }
  return last;
}

function extractFirstPromptFromHead(head: string): string | undefined {
  let commandFallback = "";

  for (const line of head.split(/\r?\n/)) {
    if (!line.includes('"type":"user"') && !line.includes('"type": "user"')) {
      continue;
    }
    if (
      line.includes('"tool_result"') ||
      line.includes('"isMeta":true') ||
      line.includes('"isCompactSummary":true')
    ) {
      continue;
    }

    try {
      const entry = JSON.parse(line) as TranscriptEntry;
      const message =
        entry.message && typeof entry.message === "object"
          ? (entry.message as Record<string, unknown>)
          : undefined;
      const content = message?.content;
      const texts =
        typeof content === "string"
          ? [content]
          : Array.isArray(content)
            ? content
                .filter((item): item is Record<string, unknown> =>
                  Boolean(item && typeof item === "object"),
                )
                .filter((item) => item.type === "text" && typeof item.text === "string")
                .map((item) => String(item.text))
            : [];

      for (const text of texts) {
        const normalized = text.replace(/\n/g, " ").trim();
        if (!normalized) {
          continue;
        }

        const commandMatch = COMMAND_NAME_RE.exec(normalized);
        if (commandMatch?.[1]) {
          commandFallback ||= commandMatch[1];
          continue;
        }

        if (SKIP_FIRST_PROMPT_RE.test(normalized)) {
          continue;
        }

        return normalized.length > 200 ? `${normalized.slice(0, 200).trimEnd()}…` : normalized;
      }
    } catch {
      continue;
    }
  }

  return commandFallback || undefined;
}

function normalizeOptionalTag(value: string | undefined): string | null {
  if (value == null || value === "") {
    return null;
  }
  return value;
}

function parseTimestampToEpoch(value?: string): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sanitizeUnicode(value: string): string {
  return value.normalize("NFKC").replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "");
}

function writeFileAtomic(path: string, data: string): void {
  const { error } = tryCatchSync(() => {
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, "wx", 0o600);
    try {
      writeSync(fd, data);
    } finally {
      closeSync(fd);
    }
  });
  if (error) {
    throw new ClaudeSDKError(`Failed to write session file: ${error.message}`);
  }
}

// limit=0 or undefined means no limit (return all items from offset)
function paginate<T>(items: T[], limit?: number, offset = 0): T[] {
  if (limit != null && limit > 0) {
    return items.slice(offset, offset + limit);
  }
  if (offset > 0) {
    return items.slice(offset);
  }
  return items;
}

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function assertUuid(value: string, label: string): void {
  if (!isUuid(value)) {
    throw new ClaudeSDKError(`Invalid ${label}: ${value}`);
  }
}
