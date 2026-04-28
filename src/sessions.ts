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
  rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { ClaudeSDKError } from "./errors.ts";
import { QueryController, createUserPromptMessage } from "./query.ts";
import { SubprocessCLITransport } from "./subprocess-transport.ts";
import { tryCatchSync } from "./try-catch.ts";
import { parseRecordUnknown, parseTranscriptEntry, type TranscriptEntry } from "./schemas.ts";
import type {
  ForkSessionOptions,
  ForkSessionResult,
  GetSessionInfoOptions,
  GetSessionMessagesOptions,
  GetSubagentMessagesOptions as _GetSubagentMessagesOptions,
  ImportSessionToStoreOptions,
  ListSubagentsOptions,
  ListSessionsOptions,
  SDKMessage,
  SDKResultMessage,
  SDKSession,
  SDKSessionOptions,
  SDKSessionInfo,
  SDKUserMessage,
  SessionKey,
  SessionMessage,
  SessionMutationOptions,
  SessionStore,
  SessionStoreEntry,
  SessionSummaryEntry,
} from "./types.ts";

const LITE_READ_BUF_SIZE = 65_536;
const DEFAULT_IMPORT_BATCH_SIZE = 500;
const MAX_SANITIZED_LENGTH = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKIP_FIRST_PROMPT_RE =
  /^(?:<local-command-stdout>|<session-start-hook>|<tick>|<goal>|\[Request interrupted by user[^\]]*\]|\s*<ide_opened_file>[\s\S]*<\/ide_opened_file>\s*$|\s*<ide_selection>[\s\S]*<\/ide_selection>\s*$)/;
const SUMMARY_SKIP_PROMPT_RE = /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/;
const COMMAND_NAME_RE = /<command-name>(.*?)<\/command-name>/;
const BASH_INPUT_RE = /<bash-input>([\s\S]*?)<\/bash-input>/;
const SANITIZE_RE = /[^a-zA-Z0-9]/g;
const SUMMARY_LAST_WRITE_FIELDS = {
  customTitle: "customTitle",
  aiTitle: "aiTitle",
  lastPrompt: "lastPrompt",
  summary: "summaryHint",
  gitBranch: "gitBranch",
} as const;

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
      await this.#controller.sendUserMessage(createUserPromptMessage(message));
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

/** Creates a session that can send prompts incrementally and stream responses over time. */
export function unstable_v2_createSession(options: SDKSessionOptions): SDKSession {
  return new RuntimeSDKSession({ ...options });
}

/** Sends a single prompt in a temporary session and resolves with the terminal result message. */
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

/** Resumes an existing Claude Code session by session ID. */
export function unstable_v2_resumeSession(
  sessionId: string,
  options: SDKSessionOptions,
): SDKSession {
  return new RuntimeSDKSession({
    ...options,
    resume: sessionId,
    sessionId,
  });
}

type LiteSessionFile = {
  mtime: number;
  size: number;
  head: string;
  tail: string;
};

/** In-memory `SessionStore` implementation for tests and development. */
export class InMemorySessionStore implements SessionStore {
  private store = new Map<string, SessionStoreEntry[]>();
  private mtimes = new Map<string, number>();
  private summaries = new Map<string, SessionSummaryEntry>();
  private lastMtime = 0;

  private keyToString(key: SessionKey): string {
    return `${key.projectKey}\0${key.sessionId}\0${key.subpath ?? ""}`;
  }

  private summaryKey(key: { projectKey: string; sessionId: string }): string {
    return `${key.projectKey}\0${key.sessionId}`;
  }

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    const storeKey = this.keyToString(key);
    const current = this.store.get(storeKey) ?? [];
    current.push(...cloneEntries(entries));
    this.store.set(storeKey, current);
    const mtime = Math.max(Date.now(), this.lastMtime + 1);
    this.lastMtime = mtime;
    this.mtimes.set(storeKey, mtime);

    if (!key.subpath) {
      this.summaries.set(
        this.summaryKey(key),
        foldSessionSummary(this.summaries.get(this.summaryKey(key)), key, entries, { mtime }),
      );
    }
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const entries = this.store.get(this.keyToString(key));
    return entries ? cloneEntries(entries) : null;
  }

  async listSessions(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>> {
    const sessions: Array<{ sessionId: string; mtime: number }> = [];
    for (const [storeKey, entries] of this.store) {
      const parsed = parseStoreKey(storeKey);
      if (!parsed || parsed.projectKey !== projectKey || parsed.subpath) {
        continue;
      }
      if (entries.length === 0) {
        continue;
      }
      sessions.push({
        sessionId: parsed.sessionId,
        mtime: this.mtimes.get(storeKey) ?? Date.now(),
      });
    }
    return sessions;
  }

  async listSessionSummaries(projectKey: string): Promise<SessionSummaryEntry[]> {
    const prefix = `${projectKey}\0`;
    const summaries: SessionSummaryEntry[] = [];
    for (const [summaryKey, summary] of this.summaries) {
      if (summaryKey.startsWith(prefix)) {
        summaries.push({ ...summary, data: { ...summary.data } });
      }
    }
    return summaries;
  }

  async delete(key: SessionKey): Promise<void> {
    if (key.subpath) {
      const storeKey = this.keyToString(key);
      this.store.delete(storeKey);
      this.mtimes.delete(storeKey);
      return;
    }

    const prefix = `${key.projectKey}\0${key.sessionId}\0`;
    this.summaries.delete(this.summaryKey(key));
    for (const storeKey of this.store.keys()) {
      if (storeKey.startsWith(prefix)) {
        this.store.delete(storeKey);
        this.mtimes.delete(storeKey);
      }
    }
  }

  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    const prefix = `${key.projectKey}\0${key.sessionId}\0`;
    const subkeys: string[] = [];
    for (const storeKey of this.store.keys()) {
      if (!storeKey.startsWith(prefix)) {
        continue;
      }
      const parsed = parseStoreKey(storeKey);
      if (parsed?.subpath) {
        subkeys.push(parsed.subpath);
      }
    }
    return subkeys.sort((a, b) => a.localeCompare(b));
  }

  /** Test helper that returns all entries for a key. */
  getEntries(key: SessionKey): SessionStoreEntry[] {
    return cloneEntries(this.store.get(this.keyToString(key)) ?? []);
  }

  /** Number of main transcripts stored in memory. */
  get size(): number {
    let count = 0;
    for (const [storeKey, entries] of this.store) {
      const parsed = parseStoreKey(storeKey);
      if (parsed && !parsed.subpath && entries.length > 0) {
        count += 1;
      }
    }
    return count;
  }

  /** Clears all stored transcripts. */
  clear(): void {
    this.store.clear();
    this.mtimes.clear();
    this.summaries.clear();
    this.lastMtime = 0;
  }
}

/** Lists locally persisted Claude Code sessions visible from the configured session directories. */
export async function listSessions(options: ListSessionsOptions = {}): Promise<SDKSessionInfo[]> {
  if (options.sessionStore) {
    return listSessionsFromStore(options.sessionStore, options);
  }

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

/** Looks up summary metadata for a persisted session by session ID. */
export async function getSessionInfo(
  sessionId: string,
  options: GetSessionInfoOptions = {},
): Promise<SDKSessionInfo | undefined> {
  if (options.sessionStore) {
    return getSessionInfoFromStore(options.sessionStore, sessionId, options.dir);
  }

  const located = findSessionFile(sessionId, options.dir);
  if (!located) {
    return undefined;
  }
  return readSessionInfo(located.filePath, sessionId);
}

/** Returns transcript messages for a session, optionally including system messages. */
export async function getSessionMessages(
  sessionId: string,
  options: GetSessionMessagesOptions = {},
): Promise<SessionMessage[]> {
  if (options.sessionStore) {
    return getSessionMessagesFromStore(options.sessionStore, sessionId, options);
  }

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

/** Lists subagent transcript IDs recorded beneath a parent session. */
export async function listSubagents(
  sessionId: string,
  options: ListSubagentsOptions = {},
): Promise<string[]> {
  if (options.sessionStore) {
    return listSubagentsFromStore(options.sessionStore, sessionId, options);
  }

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
  return agents;
}

/** Returns transcript messages for a specific subagent session. */
export async function getSubagentMessages(
  sessionId: string,
  agentId: string,
  options: _GetSubagentMessagesOptions = {},
): Promise<SessionMessage[]> {
  if (options.sessionStore) {
    return getSubagentMessagesFromStore(options.sessionStore, sessionId, agentId, options);
  }

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
    chain.filter((entry) => isVisibleMessage(entry, false)).map(toSessionMessage),
    options.limit,
    options.offset,
  );
}

/** Sets or updates the custom title shown for a session. */
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

  if (options.sessionStore) {
    await appendStoreEntry(options.sessionStore, sessionId, options.dir, {
      type: "custom-title",
      customTitle: trimmed,
      sessionId,
    });
    return;
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

/** Applies or clears a human-readable tag on a session. */
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

  if (options.sessionStore) {
    await appendStoreEntry(options.sessionStore, sessionId, options.dir, {
      type: "tag",
      tag: normalized,
      sessionId,
    });
    return;
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

/** Deletes the persisted transcript file for a session. */
export async function deleteSession(
  sessionId: string,
  options: SessionMutationOptions = {},
): Promise<void> {
  assertUuid(sessionId, "sessionId");

  if (options.sessionStore) {
    await options.sessionStore.delete?.(storeKey(sessionId, options.dir));
    return;
  }

  const located = findSessionFile(sessionId, options.dir);
  if (!located) {
    throw new ClaudeSDKError(`Session ${sessionId} not found`);
  }
  const { error } = tryCatchSync(() => unlinkSync(located.filePath));
  if (error) {
    throw new ClaudeSDKError(`Failed to delete session file: ${error.message}`);
  }
  tryCatchSync(() => rmSync(join(located.projectDir, sessionId), { recursive: true, force: true }));
}

/** Creates a new session transcript by copying messages from an existing session. */
export async function forkSession(
  sessionId: string,
  options: ForkSessionOptions = {},
): Promise<ForkSessionResult> {
  assertUuid(sessionId, "sessionId");
  if (options.upToMessageId) {
    assertUuid(options.upToMessageId, "upToMessageId");
  }

  if (options.sessionStore) {
    return forkSessionInStore(sessionId, options.sessionStore, options);
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

/** Copies a local JSONL session transcript into a `SessionStore`. */
export async function importSessionToStore(
  sessionId: string,
  store: SessionStore,
  options: ImportSessionToStoreOptions = {},
): Promise<void> {
  assertUuid(sessionId, "sessionId");
  const located = findSessionFile(sessionId, options.dir);
  if (!located) {
    throw new ClaudeSDKError(`Session ${sessionId} not found`);
  }

  const batchSize =
    options.batchSize && options.batchSize > 0 ? options.batchSize : DEFAULT_IMPORT_BATCH_SIZE;
  await appendFileToStore(located.filePath, storeKey(sessionId, options.dir), store, batchSize);

  if (options.includeSubagents === false) {
    return;
  }

  const subagentsDir = join(located.projectDir, sessionId, "subagents");
  for (const filePath of collectJsonlFiles(subagentsDir)) {
    const subpath = filePath
      .slice(join(located.projectDir, sessionId).length + 1)
      .replace(/\\/g, "/")
      .replace(/\.jsonl$/, "");
    await appendFileToStore(
      filePath,
      { ...storeKey(sessionId, options.dir), subpath },
      store,
      batchSize,
    );
  }
}

function readSessionFileContent(filePath: string): string {
  const { data, error } = tryCatchSync(() => readFileSync(filePath, "utf8"));
  if (error) {
    throw new ClaudeSDKError(`Failed to read session file: ${error.message}`);
  }
  return data;
}

function storeKey(sessionId: string, dir?: string, subpath?: string): SessionKey {
  return {
    projectKey: sanitizePath(canonicalizePath(dir ?? ".")),
    sessionId,
    ...(subpath ? { subpath } : {}),
  };
}

function parseStoreKey(value: string): SessionKey | undefined {
  const [projectKey, sessionId, subpath] = value.split("\0");
  if (!projectKey || !sessionId) {
    return undefined;
  }
  return {
    projectKey,
    sessionId,
    ...(subpath ? { subpath } : {}),
  };
}

function cloneEntries(entries: SessionStoreEntry[]): SessionStoreEntry[] {
  return entries.map((entry) => ({ ...entry }));
}

function entriesToContent(entries: SessionStoreEntry[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

type SessionSummaryData = Record<string, unknown>;

type SessionSummaryScratch = {
  commandFallback: string;
};

/**
 * Fold a batch of appended transcript entries into a session summary sidecar.
 */
export function foldSessionSummary(
  prev: SessionSummaryEntry | undefined,
  key: SessionKey,
  entries: SessionStoreEntry[],
  options?: { mtime?: number },
): SessionSummaryEntry {
  const mtime = options?.mtime ?? prev?.mtime ?? 0;
  const next: SessionSummaryEntry = prev
    ? {
        sessionId: prev.sessionId,
        mtime,
        data: { ...prev.data },
      }
    : {
        sessionId: key.sessionId,
        mtime,
        data: {},
      };

  const data = next.data;
  for (const entry of entries) {
    const createdAt = parseTimestampToEpoch(entry.timestamp);
    if (data.isSidechain === undefined) {
      data.isSidechain = entry.isSidechain === true;
    }
    if (data.createdAt === undefined && createdAt != null) {
      data.createdAt = createdAt;
    }
    if (data.cwd === undefined) {
      const cwd = entry.cwd;
      if (typeof cwd === "string" && cwd.length > 0) {
        data.cwd = cwd;
      }
    }

    maybeCaptureFirstPrompt(data, entry);
    for (const [source, target] of Object.entries(SUMMARY_LAST_WRITE_FIELDS)) {
      const value = entry[source];
      if (typeof value === "string") {
        data[target] = value;
      }
    }

    if (entry.type === "tag") {
      const tag = entry.tag;
      if (typeof tag === "string" && tag.length > 0) {
        data.tag = tag;
      } else {
        delete data.tag;
      }
    }
  }

  return next;
}

function readSessionInfoFromEntries(
  sessionId: string,
  entries: SessionStoreEntry[],
  mtime = Date.now(),
): SDKSessionInfo | undefined {
  if (entries.length === 0) {
    return undefined;
  }

  const content = entriesToContent(entries);
  const bytes = Buffer.byteLength(content, "utf8");
  const lite = {
    mtime,
    size: bytes,
    head: content.slice(0, LITE_READ_BUF_SIZE),
    tail: content.slice(Math.max(0, content.length - LITE_READ_BUF_SIZE)),
  };
  return buildSessionInfo(lite, sessionId, `${sessionId}.jsonl`);
}

function sessionInfoFromSummary(
  summary: SessionSummaryEntry,
  fallbackCwd?: string,
): SDKSessionInfo | undefined {
  const data = summary.data;
  if (data.isSidechain === true) {
    return undefined;
  }

  const firstPromptValue =
    data.firstPromptLocked === true ? data.firstPrompt : data.commandFallback;
  const firstPrompt = typeof firstPromptValue === "string" ? firstPromptValue : undefined;
  const customTitle =
    typeof data.customTitle === "string"
      ? data.customTitle
      : typeof data.aiTitle === "string"
        ? data.aiTitle
        : undefined;
  const summaryText =
    customTitle ||
    (typeof data.lastPrompt === "string" ? data.lastPrompt : undefined) ||
    (typeof data.summaryHint === "string" ? data.summaryHint : undefined) ||
    firstPrompt;

  if (!summaryText) {
    return undefined;
  }

  return {
    sessionId: summary.sessionId,
    summary: summaryText,
    lastModified: summary.mtime,
    ...optionalProperty("customTitle", customTitle),
    ...optionalProperty("firstPrompt", firstPrompt),
    ...optionalProperty("gitBranch", asOptionalString(data.gitBranch)),
    ...optionalProperty("cwd", asOptionalString(data.cwd) ?? fallbackCwd),
    ...optionalProperty("tag", normalizeOptionalTag(asOptionalString(data.tag))),
    ...optionalProperty("createdAt", asOptionalNumber(data.createdAt)),
  };
}

async function listSessionsFromStore(
  store: SessionStore,
  options: ListSessionsOptions,
): Promise<SDKSessionInfo[]> {
  const projectKey = storeKey("", options.dir).projectKey;
  if (store.listSessionSummaries) {
    const summaries = await store.listSessionSummaries(projectKey);
    const listed = store.listSessions
      ? new Map((await store.listSessions(projectKey)).map((entry) => [entry.sessionId, entry]))
      : undefined;
    const combined: Array<{ sessionId: string; mtime: number; info?: SDKSessionInfo | null }> = [];

    for (const summary of summaries) {
      const listedEntry = listed?.get(summary.sessionId);
      if (listed && !listedEntry) {
        continue;
      }
      const effectiveMtime =
        listedEntry && listedEntry.mtime > summary.mtime ? listedEntry.mtime : summary.mtime;
      const info =
        listedEntry && listedEntry.mtime > summary.mtime
          ? undefined
          : sessionInfoFromSummary(summary, options.dir);
      combined.push({
        sessionId: summary.sessionId,
        mtime: effectiveMtime,
        ...(info !== undefined ? { info } : {}),
      });
    }

    if (listed) {
      const seen = new Set(summaries.map((summary) => summary.sessionId));
      for (const [sessionId, entry] of listed) {
        if (!seen.has(sessionId)) {
          combined.push({ sessionId, mtime: entry.mtime });
        }
      }
    } else if (summaries.length === 0) {
      return [];
    }

    combined.sort((left, right) => right.mtime - left.mtime);
    const page = paginate(combined, options.limit, options.offset);
    const sessions: SDKSessionInfo[] = [];

    for (const entry of page) {
      if (entry.info !== undefined) {
        if (entry.info) {
          sessions.push(entry.info);
        }
        continue;
      }

      const loaded = await store.load({ projectKey, sessionId: entry.sessionId });
      if (!loaded || loaded.length === 0) {
        continue;
      }
      const info = readSessionInfoFromEntries(entry.sessionId, loaded, entry.mtime);
      if (info) {
        sessions.push(info);
      }
    }

    return sessions;
  }

  if (!store.listSessions) {
    throw new ClaudeSDKError(
      "sessionStore.listSessions is not implemented -- cannot list sessions. Provide a store with a listSessions() method.",
    );
  }

  const listed = await store.listSessions(projectKey);
  const sorted = listed.slice().sort((left, right) => right.mtime - left.mtime);
  const page = paginate(sorted, options.limit, options.offset);
  const sessions: SDKSessionInfo[] = [];

  for (const entry of page) {
    const entries = await store.load({ projectKey, sessionId: entry.sessionId });
    if (!entries || entries.length === 0) {
      continue;
    }
    const info = readSessionInfoFromEntries(entry.sessionId, entries, entry.mtime);
    if (info) {
      sessions.push(info);
    }
  }
  return sessions;
}

async function getSessionInfoFromStore(
  store: SessionStore,
  sessionId: string,
  dir?: string,
): Promise<SDKSessionInfo | undefined> {
  if (!isUuid(sessionId)) {
    return undefined;
  }
  const entries = await store.load(storeKey(sessionId, dir));
  return entries ? readSessionInfoFromEntries(sessionId, entries) : undefined;
}

async function getSessionMessagesFromStore(
  store: SessionStore,
  sessionId: string,
  options: GetSessionMessagesOptions,
): Promise<SessionMessage[]> {
  if (!isUuid(sessionId)) {
    return [];
  }
  const entries = await store.load(storeKey(sessionId, options.dir));
  if (!entries || entries.length === 0) {
    return [];
  }
  const chain = buildConversationChain(parseTranscript(entriesToContent(entries)));
  return paginate(
    chain
      .filter((entry) => isVisibleMessage(entry, Boolean(options.includeSystemMessages)))
      .map(toSessionMessage),
    options.limit,
    options.offset,
  );
}

async function listSubagentsFromStore(
  store: SessionStore,
  sessionId: string,
  options: ListSubagentsOptions,
): Promise<string[]> {
  if (!isUuid(sessionId)) {
    return [];
  }
  if (!store.listSubkeys) {
    throw new ClaudeSDKError(
      "sessionStore.listSubkeys is not implemented -- cannot list subagents. Provide a store with a listSubkeys() method.",
    );
  }

  const key = storeKey(sessionId, options.dir);
  const subkeys = await store.listSubkeys({ projectKey: key.projectKey, sessionId });
  const agents = [
    ...new Set(
      subkeys.flatMap((subkey) => {
        if (!subkey.startsWith("subagents/")) {
          return [];
        }
        const name = subkey.split("/").at(-1);
        return name?.startsWith("agent-") ? [name.slice("agent-".length)] : [];
      }),
    ),
  ].sort((a, b) => a.localeCompare(b));
  return agents;
}

async function getSubagentMessagesFromStore(
  store: SessionStore,
  sessionId: string,
  agentId: string,
  options: _GetSubagentMessagesOptions,
): Promise<SessionMessage[]> {
  if (!isUuid(sessionId)) {
    return [];
  }

  let subpath = `subagents/agent-${agentId}`;
  const key = storeKey(sessionId, options.dir);
  if (store.listSubkeys) {
    const subkeys = await store.listSubkeys({ projectKey: key.projectKey, sessionId });
    const match = subkeys.find((candidate) => {
      const name = candidate.split("/").at(-1);
      return candidate.startsWith("subagents/") && name === `agent-${agentId}`;
    });
    if (!match) {
      return [];
    }
    subpath = match;
  }

  const entries = await store.load({ ...key, subpath });
  if (!entries || entries.length === 0) {
    return [];
  }
  const chain = buildConversationChain(parseTranscript(entriesToContent(entries)));
  return paginate(
    chain.filter((entry) => isVisibleMessage(entry, false)).map(toSessionMessage),
    options.limit,
    options.offset,
  );
}

async function appendStoreEntry(
  store: SessionStore,
  sessionId: string,
  dir: string | undefined,
  entry: SessionStoreEntry,
): Promise<void> {
  await store.append(storeKey(sessionId, dir), [entry]);
}

async function forkSessionInStore(
  sessionId: string,
  store: SessionStore,
  options: ForkSessionOptions,
): Promise<ForkSessionResult> {
  const key = storeKey(sessionId, options.dir);
  const loaded = await store.load(key);
  if (!loaded || loaded.length === 0) {
    throw new ClaudeSDKError(`Session ${sessionId} not found`);
  }

  const entries = parseTranscript(entriesToContent(loaded)).filter(
    (entry) => entry.isSidechain !== true,
  );
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
  const existingInfo = readSessionInfoFromEntries(sessionId, loaded);
  const baseTitle =
    options.title?.trim() || existingInfo?.customTitle || existingInfo?.summary || "Forked session";

  lines.push(
    JSON.stringify({
      type: "custom-title",
      sessionId: forkedSessionId,
      customTitle: options.title?.trim() || `${baseTitle} (fork)`,
    }),
  );

  await store.append(
    { projectKey: key.projectKey, sessionId: forkedSessionId },
    lines.map((line) => JSON.parse(line) as SessionStoreEntry),
  );
  return { sessionId: forkedSessionId };
}

async function appendFileToStore(
  filePath: string,
  key: SessionKey,
  store: SessionStore,
  batchSize: number,
): Promise<void> {
  let batch: SessionStoreEntry[] = [];
  for (const line of readSessionFileContent(filePath).split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    batch.push(JSON.parse(line) as SessionStoreEntry);
    if (batch.length >= batchSize) {
      await store.append(key, batch);
      batch = [];
    }
  }
  if (batch.length > 0) {
    await store.append(key, batch);
  }
}

function collectJsonlFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }

  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJsonlFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(path);
    }
  }
  return files;
}

function remapEntryUuids(
  entries: TranscriptEntry[],
  forkedSessionId: string,
  sourceSessionId: string,
): string[] {
  const uuidMap = new Map<string, string>();
  for (const entry of entries) {
    uuidMap.set(entry.uuid, randomUUID());
  }

  const now = new Date().toISOString();
  return entries.map((entry) => {
    const oldUuid = entry.uuid;
    const oldParent = entry.parentUuid;

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
  return buildSessionInfo(lite, sessionId, filePath);
}

function buildSessionInfo(
  lite: LiteSessionFile,
  sessionId: string,
  filePath: string,
): SDKSessionInfo | undefined {
  const lastField = (key: string) =>
    extractLastJsonStringField(lite.tail, key) || extractLastJsonStringField(lite.head, key);

  const firstPrompt = extractFirstPromptFromHead(lite.head);
  const summary =
    lastField("customTitle") || lastField("aiTitle") || firstPrompt || basename(filePath, ".jsonl");

  if (!summary) {
    return undefined;
  }

  return {
    sessionId,
    summary,
    lastModified: lite.mtime,
    fileSize: lite.size,
    ...optionalProperty("customTitle", lastField("customTitle")),
    ...optionalProperty("firstPrompt", firstPrompt),
    ...optionalProperty("gitBranch", lastField("gitBranch")),
    ...optionalProperty("cwd", lastField("cwd")),
    ...optionalProperty("tag", normalizeOptionalTag(lastField("tag"))),
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
        const entry = parseTranscriptEntry(line);
        return entry ? [entry] : [];
      } catch {
        return [];
      }
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
    byUuid.set(entry.uuid, entry);
    order.set(entry.uuid, index);
    if (entry.parentUuid) {
      parentUuids.add(entry.parentUuid);
    }
  });

  const leaves = entries.filter((entry) => {
    return !parentUuids.has(entry.uuid);
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
  while (current && !seen.has(current.uuid)) {
    seen.add(current.uuid);
    chain.push(current);
    current = current.parentUuid ? byUuid.get(current.parentUuid) : undefined;
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

function maybeCaptureFirstPrompt(summary: SessionSummaryData, entry: SessionStoreEntry): void {
  if (summary.firstPromptLocked === true) {
    return;
  }

  const scratch: SessionSummaryScratch = {
    commandFallback: typeof summary.commandFallback === "string" ? summary.commandFallback : "",
  };
  const firstPrompt = extractFirstPromptFromEntry(entry, scratch);

  if (scratch.commandFallback && typeof summary.commandFallback !== "string") {
    summary.commandFallback = scratch.commandFallback;
  }
  if (firstPrompt !== undefined) {
    summary.firstPrompt = firstPrompt;
    summary.firstPromptLocked = true;
  }
}

function extractFirstPromptFromEntry(
  entry: SessionStoreEntry,
  scratch: SessionSummaryScratch,
): string | undefined {
  if (entry.type !== "user" || entry.isMeta === true || entry.isCompactSummary === true) {
    return undefined;
  }

  const message = parseRecordUnknown(entry.message);
  const content = message?.content;
  const texts: string[] = [];
  if (typeof content === "string") {
    texts.push(content);
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const record = item as Record<string, unknown>;
      if (record.type === "tool_result") {
        return undefined;
      }
      if (record.type === "text" && typeof record.text === "string") {
        texts.push(record.text);
      }
    }
  }

  for (const text of texts) {
    const normalized = text.replace(/\n/g, " ").trim();
    if (!normalized) {
      continue;
    }

    const commandMatch = COMMAND_NAME_RE.exec(normalized);
    if (commandMatch?.[1]) {
      scratch.commandFallback ||= commandMatch[1];
      continue;
    }

    const bashMatch = BASH_INPUT_RE.exec(normalized);
    if (bashMatch?.[1]) {
      return `! ${bashMatch[1].trim()}`;
    }

    if (SUMMARY_SKIP_PROMPT_RE.test(normalized)) {
      continue;
    }

    return normalized.length > 200 ? `${normalized.slice(0, 200).trimEnd()}…` : normalized;
  }

  return undefined;
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
      const entry = parseTranscriptEntry(line);
      if (!entry || entry.type !== "user") {
        continue;
      }
      const message = parseRecordUnknown(entry.message);
      const content = message?.content;
      const texts =
        typeof content === "string"
          ? [content]
          : Array.isArray(content)
            ? content
                .map((item) => parseRecordUnknown(item))
                .filter((item): item is Record<string, unknown> => Boolean(item))
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

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
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
