import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import { DEFAULT_CONFIG, type NotificationConfig, type SidebarConfig, type ToolkitConfig } from "./types";
import { isBoolean, isLang, isNonNegativeNumber } from "./types";

/** Global config file path shared between server and TUI plugins. */
export function configFilePath(): string {
  return join(homedir(), ".config", "opencode", "my-opencode-toolkit.json");
}

function parseNotification(value: unknown): NotificationConfig {
  if (typeof value !== "object" || value === null) {
    return { ...DEFAULT_CONFIG.notification };
  }

  const raw = value as Record<string, unknown>;
  const result: NotificationConfig = { ...DEFAULT_CONFIG.notification };
  if (isBoolean(raw.enabled)) result.enabled = raw.enabled;
  if (isBoolean(raw.onComplete)) result.onComplete = raw.onComplete;
  if (isBoolean(raw.onQuestion)) result.onQuestion = raw.onQuestion;
  if (isBoolean(raw.onPermission)) result.onPermission = raw.onPermission;
  if (isNonNegativeNumber(raw.idleConfirmationDelay)) {
    result.idleConfirmationDelay = raw.idleConfirmationDelay;
  }
  if (isBoolean(raw.skipIfIncompleteTodos)) result.skipIfIncompleteTodos = raw.skipIfIncompleteTodos;
  if (isBoolean(raw.onlyMainSession)) result.onlyMainSession = raw.onlyMainSession;
  return result;
}

function parseSidebar(value: unknown): SidebarConfig {
  if (typeof value !== "object" || value === null) {
    return { ...DEFAULT_CONFIG.sidebar };
  }

  const raw = value as Record<string, unknown>;
  const result: SidebarConfig = { ...DEFAULT_CONFIG.sidebar };
  if (isBoolean(raw.enabled)) result.enabled = raw.enabled;
  if (isBoolean(raw.showCache)) result.showCache = raw.showCache;
  if (isBoolean(raw.showTools)) result.showTools = raw.showTools;
  if (isBoolean(raw.showSubagents)) result.showSubagents = raw.showSubagents;
  if (isBoolean(raw.collapsed)) result.collapsed = raw.collapsed;
  return result;
}

export function parseConfig(raw: unknown): ToolkitConfig {
  if (typeof raw !== "object" || raw === null) {
    return structuredClone(DEFAULT_CONFIG);
  }

  const obj = raw as Record<string, unknown>;
  const result: ToolkitConfig = structuredClone(DEFAULT_CONFIG);
  if (isLang(obj.lang)) result.lang = obj.lang;
  if (isBoolean(obj.enabled)) result.enabled = obj.enabled;
  result.notification = parseNotification(obj.notification);
  result.sidebar = parseSidebar(obj.sidebar);
  return result;
}

/** Read the global config, merging with defaults. Never throws. */
export function loadConfig(path: string = configFilePath()): ToolkitConfig {
  try {
    const content = readFileSync(path, "utf8");
    return parseConfig(JSON.parse(content) as unknown);
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}
