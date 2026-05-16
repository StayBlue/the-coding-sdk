/*
 * This file incorporates material from claude-agent-sdk-typescript, licensed under
 * the MIT License:
 *
 * Copyright (c) 2026 Anthropic, PBC
 *
 * Modifications Copyright 2026 StayBlue, licensed under the Apache License,
 * Version 2.0. See the LICENSE file in the project root for details.
 */

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import type {
  PolicySettingsOrigin,
  ProvenanceEntry,
  ResolveSettingsOptions,
  ResolvedSettingSource,
  ResolvedSettings,
  Settings,
  SettingSource,
} from "./types.ts";

const DEFAULT_SETTING_SOURCES: SettingSource[] = ["user", "project", "local"];
const ESCALATING_DEFAULT_MODES = new Set(["bypassPermissions", "auto", "acceptEdits"]);
const MACOS_POLICY_DOMAIN = "com.anthropic.claudecode";
const WINDOWS_POLICY_HKLM = "HKLM\\SOFTWARE\\Policies\\ClaudeCode";
const WINDOWS_POLICY_HKCU = "HKCU\\SOFTWARE\\Policies\\ClaudeCode";
const WINDOWS_POLICY_VALUE = "Settings";

type InternalSource = {
  source: ResolvedSettingSource;
  settings: Settings;
  path?: string;
  policyOrigin?: PolicySettingsOrigin;
};

/** Applies the CLI trust filter for escalating default permission modes from project settings. */
export function filterEscalatingDefaultMode(resolved: ResolvedSettings): Settings {
  const permissions = asRecord(resolved.effective.permissions);
  const defaultMode = permissions?.defaultMode;
  if (typeof defaultMode !== "string" || !ESCALATING_DEFAULT_MODES.has(defaultMode)) {
    return resolved.effective;
  }

  for (let index = resolved.sources.length - 1; index >= 0; index -= 1) {
    const source = resolved.sources[index];
    if (!source) {
      continue;
    }
    const sourcePermissions = asRecord(source?.settings.permissions);
    if (sourcePermissions?.defaultMode === undefined) {
      continue;
    }

    if (source.source !== "project") {
      return resolved.effective;
    }

    const filteredPermissions = { ...permissions };
    delete filteredPermissions.defaultMode;
    return {
      ...resolved.effective,
      permissions: filteredPermissions,
    };
  }

  return resolved.effective;
}

/** Resolves the effective Claude Code settings cascade without spawning the CLI. */
export async function resolveSettings(
  opts: ResolveSettingsOptions = {},
): Promise<ResolvedSettings> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const enabledSources = opts.settingSources ?? DEFAULT_SETTING_SOURCES;
  const sources: InternalSource[] = [];

  for (const source of enabledSources) {
    const path = settingsPath(source, cwd);
    const settings = readSettingsFile(path);
    if (settings && Object.keys(settings).length > 0) {
      sources.push({ source, settings, path });
    }
  }

  const managed = resolveManagedSettings(opts);
  if (managed && Object.keys(managed.settings).length > 0) {
    sources.push(managed);
  }

  const effective = mergeSettings(...sources.map((source) => source.settings));
  const provenance: Partial<Record<keyof Settings, ProvenanceEntry>> = {};

  for (const key of Object.keys(effective)) {
    for (let index = sources.length - 1; index >= 0; index -= 1) {
      const source = sources[index];
      if (!source || source.settings[key] === undefined) {
        continue;
      }
      provenance[key] = provenanceEntry(source);
      break;
    }
  }

  return {
    effective,
    provenance,
    sources: sources.map((source) => ({
      source: source.source,
      settings: source.settings,
      ...(source.path !== undefined ? { path: source.path } : {}),
      ...(source.policyOrigin !== undefined ? { policyOrigin: source.policyOrigin } : {}),
    })),
  };
}

function settingsPath(source: SettingSource, cwd: string): string {
  switch (source) {
    case "user":
      return join(claudeConfigDir(), settingsFileName());
    case "project":
      return join(cwd, ".claude", "settings.json");
    case "local":
      return join(cwd, ".claude", "settings.local.json");
  }
}

function settingsFileName(): string {
  return process.env.CLAUDE_CODE_USE_COWORK_PLUGINS ? "cowork_settings.json" : "settings.json";
}

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR
    ? resolve(process.env.CLAUDE_CONFIG_DIR)
    : join(homedir(), ".claude");
}

function managedSettingsDir(): string {
  switch (process.platform) {
    case "darwin":
      return "/Library/Application Support/ClaudeCode";
    case "win32":
      return "C:\\Program Files\\ClaudeCode";
    default:
      return "/etc/claude-code";
  }
}

function resolveManagedSettings(opts: ResolveSettingsOptions): InternalSource | undefined {
  const adminTiers: Array<{ origin: PolicySettingsOrigin; settings: Settings }> = [];

  if (opts.serverManagedSettings && Object.keys(opts.serverManagedSettings).length > 0) {
    adminTiers.push({ origin: "remote", settings: cloneSettings(opts.serverManagedSettings) });
  }

  const mdm = readMdmSettings();
  if (mdm.admin && Object.keys(mdm.admin.settings).length > 0) {
    adminTiers.push(mdm.admin);
  }

  const fileSettings = readManagedSettingsDir(managedSettingsDir());
  if (fileSettings && Object.keys(fileSettings).length > 0) {
    adminTiers.push({ origin: "file", settings: fileSettings });
  }

  const adminSettings = mergeSettings(...adminTiers.map((tier) => tier.settings));
  const parentSlice =
    opts.managedSettings && Object.keys(opts.managedSettings).length > 0
      ? filterParentManagedSettings(opts.managedSettings, adminSettings)
      : undefined;
  const settings = mergeSettings(parentSlice ?? {}, adminSettings);

  if (Object.keys(settings).length === 0) {
    if (mdm.hkcu && Object.keys(mdm.hkcu.settings).length > 0) {
      return {
        source: "managed",
        settings: mdm.hkcu.settings,
        policyOrigin: "hkcu",
      };
    }
    return undefined;
  }

  return {
    source: "managed",
    settings,
    policyOrigin: adminTiers[0]?.origin ?? "parent",
  };
}

function readMdmSettings(): {
  admin?: { origin: PolicySettingsOrigin; settings: Settings };
  hkcu?: { settings: Settings };
} {
  if (process.platform === "darwin") {
    const plistSettings = readMacosManagedPlist();
    return plistSettings ? { admin: { origin: "plist", settings: plistSettings } } : {};
  }

  const regExe =
    process.platform === "win32"
      ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\reg.exe`
      : isWsl()
        ? "/mnt/c/Windows/System32/reg.exe"
        : undefined;

  if (!regExe) {
    return {};
  }

  const hklm = readWindowsPolicyRegistry(regExe, WINDOWS_POLICY_HKLM);
  const hkcu = readWindowsPolicyRegistry(regExe, WINDOWS_POLICY_HKCU);
  return {
    ...(hklm ? { admin: { origin: "hklm" as const, settings: hklm } } : {}),
    ...(hkcu ? { hkcu: { settings: hkcu } } : {}),
  };
}

function readMacosManagedPlist(): Settings | undefined {
  const candidates: string[] = [];
  try {
    const username = userInfo().username;
    if (username) {
      candidates.push(`/Library/Managed Preferences/${username}/${MACOS_POLICY_DOMAIN}.plist`);
    }
  } catch {
    // userInfo can fail in restricted runtimes; device-level preferences still apply.
  }
  candidates.push(`/Library/Managed Preferences/${MACOS_POLICY_DOMAIN}.plist`);

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    const result = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", candidate], {
      encoding: "utf8",
      timeout: 5_000,
    });
    if (result.status !== 0 || !result.stdout) {
      continue;
    }
    const parsed = parsePolicySettingsValue(result.stdout);
    if (parsed && Object.keys(parsed).length > 0) {
      return parsed;
    }
  }

  return undefined;
}

function readWindowsPolicyRegistry(regExe: string, key: string): Settings | undefined {
  const result = spawnSync(regExe, ["query", key, "/v", WINDOWS_POLICY_VALUE], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
  if (result.status !== 0 || !result.stdout) {
    return undefined;
  }

  const value = registryValue(result.stdout, WINDOWS_POLICY_VALUE);
  return value ? parsePolicySettingsValue(value) : undefined;
}

function registryValue(output: string, valueName: string): string | undefined {
  const pattern = new RegExp(`^\\s*${escapeRegExp(valueName)}\\s+REG_\\w+\\s+(.*)$`, "im");
  return output.match(pattern)?.[1]?.trimEnd();
}

function parsePolicySettingsValue(raw: string): Settings | undefined {
  try {
    const parsed = JSON.parse(stripJsonComments(raw)) as unknown;
    const settings = isPlainObject(parsed) && "Settings" in parsed ? parsed.Settings : parsed;
    if (typeof settings === "string") {
      const nested = JSON.parse(stripJsonComments(settings)) as unknown;
      return isPlainObject(nested) ? nested : undefined;
    }
    return isPlainObject(settings) ? settings : undefined;
  } catch {
    return undefined;
  }
}

function isWsl(): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  if (process.env.WSL_DISTRO_NAME) {
    return true;
  }
  try {
    return readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

function readManagedSettingsDir(directory: string): Settings | undefined {
  const settings: Settings[] = [];
  const rootSettings = readSettingsFile(join(directory, "managed-settings.json"));
  if (rootSettings) {
    settings.push(rootSettings);
  }

  const fragmentsDir = join(directory, "managed-settings.d");
  try {
    const fragments = readdirSync(fragmentsDir, { withFileTypes: true })
      .filter(
        (entry) =>
          (entry.isFile() || entry.isSymbolicLink()) &&
          entry.name.endsWith(".json") &&
          !entry.name.startsWith("."),
      )
      .map((entry) => entry.name)
      .sort();

    for (const fragment of fragments) {
      const fragmentSettings = readSettingsFile(join(fragmentsDir, fragment));
      if (fragmentSettings) {
        settings.push(fragmentSettings);
      }
    }
  } catch {
    // Missing or unreadable managed-settings.d is ignored, matching CLI startup tolerance.
  }

  if (settings.length === 0) {
    return undefined;
  }

  const merged = mergeSettings(...settings);
  const { wslInheritsWindowsSettings: _wslInheritsWindowsSettings, ...rest } = merged;
  return Object.keys(rest).length > 0 ? merged : undefined;
}

function readSettingsFile(path: string): Settings | undefined {
  try {
    if (!existsSync(path) || !lstatSync(path).isFile()) {
      return undefined;
    }
    const raw = readFileSync(path, "utf8");
    if (raw.trim().length === 0) {
      return {};
    }
    const parsed = JSON.parse(stripJsonComments(raw)) as unknown;
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function stripJsonComments(raw: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const current = raw[index];
    const next = raw[index + 1];

    if (inString) {
      result += current;
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === '"') {
        inString = false;
      }
      continue;
    }

    if (current === '"') {
      inString = true;
      result += current;
      continue;
    }

    if (current === "/" && next === "/") {
      while (index < raw.length && raw[index] !== "\n") {
        index += 1;
      }
      result += "\n";
      continue;
    }

    if (current === "/" && next === "*") {
      index += 2;
      while (index < raw.length && !(raw[index] === "*" && raw[index + 1] === "/")) {
        index += 1;
      }
      index += 1;
      continue;
    }

    result += current;
  }

  return result.replace(/,\s*([}\]])/g, "$1");
}

function mergeSettings(...items: Array<Settings | undefined>): Settings {
  const merged: Settings = {};
  for (const item of items) {
    if (!item) {
      continue;
    }
    mergeInto(merged, item);
  }
  return merged;
}

function mergeInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    const current = target[key];
    if (Array.isArray(current) && Array.isArray(value)) {
      target[key] = uniqueArray([...current, ...value]);
      continue;
    }
    if (isPlainObject(current) && isPlainObject(value)) {
      const nested = { ...current };
      mergeInto(nested, value);
      target[key] = nested;
      continue;
    }
    target[key] = cloneUnknown(value);
  }
}

function filterParentManagedSettings(settings: Settings, admin: Settings): Settings {
  const filtered: Settings = {};
  const parent = cloneSettings(settings);

  copyIf(parent, filtered, "allowManagedHooksOnly", true);
  copyIf(parent, filtered, "allowManagedMcpServersOnly", true);
  copyIf(parent, filtered, "allowManagedPermissionRulesOnly", true);

  const strictPluginOnlyCustomization = parent.strictPluginOnlyCustomization;
  if (
    strictPluginOnlyCustomization === true ||
    (Array.isArray(strictPluginOnlyCustomization) && strictPluginOnlyCustomization.length > 0)
  ) {
    filtered.strictPluginOnlyCustomization = strictPluginOnlyCustomization;
  }

  if (parent.deniedMcpServers !== undefined) {
    filtered.deniedMcpServers = parent.deniedMcpServers;
  }
  if (admin.forceLoginOrgUUID === undefined && parent.forceLoginOrgUUID !== undefined) {
    filtered.forceLoginOrgUUID = parent.forceLoginOrgUUID;
  }
  if (admin.allowedMcpServers === undefined && parent.allowedMcpServers !== undefined) {
    filtered.allowedMcpServers = parent.allowedMcpServers;
  }

  const permissions = asRecord(parent.permissions);
  if (permissions) {
    const filteredPermissions: Record<string, unknown> = {};
    copyKey(permissions, filteredPermissions, "deny");
    copyKey(permissions, filteredPermissions, "ask");
    copyIf(permissions, filteredPermissions, "disableBypassPermissionsMode", "disable");
    if (admin.allowManagedPermissionRulesOnly !== true) {
      copyKey(permissions, filteredPermissions, "allow");
      copyKey(permissions, filteredPermissions, "additionalDirectories");
    }
    if (Object.keys(filteredPermissions).length > 0) {
      filtered.permissions = filteredPermissions;
    }
  }

  const sandbox = asRecord(parent.sandbox);
  if (sandbox) {
    const filteredSandbox: Record<string, unknown> = {};
    copyIf(sandbox, filteredSandbox, "enabled", true);
    copyIf(sandbox, filteredSandbox, "failIfUnavailable", true);
    copyIf(sandbox, filteredSandbox, "allowUnsandboxedCommands", false);
    copyIf(sandbox, filteredSandbox, "autoAllowBashIfSandboxed", false);

    const network = asRecord(sandbox.network);
    const adminNetwork = asRecord(asRecord(admin.sandbox)?.network);
    if (network) {
      const filteredNetwork: Record<string, unknown> = {};
      copyKey(network, filteredNetwork, "deniedDomains");
      copyIf(network, filteredNetwork, "allowManagedDomainsOnly", true);
      if (adminNetwork?.allowManagedDomainsOnly !== true) {
        copyKey(network, filteredNetwork, "allowedDomains");
      }
      if (Object.keys(filteredNetwork).length > 0) {
        filteredSandbox.network = filteredNetwork;
      }
    }

    const filesystem = asRecord(sandbox.filesystem);
    const adminFilesystem = asRecord(asRecord(admin.sandbox)?.filesystem);
    if (filesystem) {
      const filteredFilesystem: Record<string, unknown> = {};
      copyKey(filesystem, filteredFilesystem, "denyRead");
      copyKey(filesystem, filteredFilesystem, "denyWrite");
      copyIf(filesystem, filteredFilesystem, "allowManagedReadPathsOnly", true);
      if (adminFilesystem?.allowManagedReadPathsOnly !== true) {
        copyKey(filesystem, filteredFilesystem, "allowRead");
      }
      if (Object.keys(filteredFilesystem).length > 0) {
        filteredSandbox.filesystem = filteredFilesystem;
      }
    }

    if (Object.keys(filteredSandbox).length > 0) {
      filtered.sandbox = filteredSandbox;
    }
  }

  return filtered;
}

function copyKey(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
): void {
  if (source[key] !== undefined) {
    target[key] = cloneUnknown(source[key]);
  }
}

function copyIf(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
  expected: unknown,
): void {
  if (source[key] === expected) {
    target[key] = cloneUnknown(source[key]);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function provenanceEntry(source: InternalSource): ProvenanceEntry {
  return {
    source: source.source,
    ...(source.path !== undefined ? { path: source.path } : {}),
    ...(source.policyOrigin !== undefined ? { policyOrigin: source.policyOrigin } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneSettings(settings: Settings): Settings {
  return cloneUnknown(settings) as Settings;
}

function cloneUnknown(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneUnknown(entry));
  }
  if (isPlainObject(value)) {
    const cloned: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      cloned[key] = cloneUnknown(nested);
    }
    return cloned;
  }
  return value;
}

function uniqueArray(values: unknown[]): unknown[] {
  const unique: unknown[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const key = JSON.stringify(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(cloneUnknown(value));
  }
  return unique;
}
