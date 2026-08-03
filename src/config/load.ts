import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import { DEFAULT_CONFIG, type GoalConfig, type NotificationConfig, type SchedulingConfig, type SidebarConfig, type TodoReminderConfig, type ToolkitConfig } from "./types";
import { isBoolean, isLang, isPositiveNumber } from "./types";

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
  if (isBoolean(raw.skipIfIncompleteTodos)) result.skipIfIncompleteTodos = raw.skipIfIncompleteTodos;
  if (isBoolean(raw.onlyMainSession)) result.onlyMainSession = raw.onlyMainSession;
  return result;
}

function parseTodoReminder(value: unknown): TodoReminderConfig {
  if (typeof value !== "object" || value === null) {
    return { ...DEFAULT_CONFIG.todoReminder };
  }

  const raw = value as Record<string, unknown>;
  const result: TodoReminderConfig = { ...DEFAULT_CONFIG.todoReminder };
  if (isBoolean(raw.enabled)) result.enabled = raw.enabled;
  if (isBoolean(raw.onlyMainSession)) result.onlyMainSession = raw.onlyMainSession;
  if (isPositiveNumber(raw.maxInjections)) result.maxInjections = raw.maxInjections;
  if (isPositiveNumber(raw.countdownSeconds)) result.countdownSeconds = raw.countdownSeconds;
  if (typeof raw.message === "string" && raw.message.length > 0) result.message = raw.message;
  return result;
}

function parseGoal(value: unknown): GoalConfig {
  if (typeof value !== "object" || value === null) {
    return { ...DEFAULT_CONFIG.goal };
  }

  const raw = value as Record<string, unknown>;
  const result: GoalConfig = { ...DEFAULT_CONFIG.goal };
  if (isBoolean(raw.enabled)) result.enabled = raw.enabled;
  return result;
}

function parseScheduling(value: unknown): SchedulingConfig {
  if (typeof value !== "object" || value === null) {
    return { ...DEFAULT_CONFIG.scheduling };
  }

  const raw = value as Record<string, unknown>;
  const result: SchedulingConfig = { ...DEFAULT_CONFIG.scheduling };
  if (isBoolean(raw.enabled)) result.enabled = raw.enabled;
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
  if (isBoolean(obj.autoGitignore)) result.autoGitignore = obj.autoGitignore;
  result.notification = parseNotification(obj.notification);
  result.todoReminder = parseTodoReminder(obj.todoReminder);
  result.goal = parseGoal(obj.goal);
  result.scheduling = parseScheduling(obj.scheduling);
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
