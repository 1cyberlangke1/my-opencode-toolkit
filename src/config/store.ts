import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { configFilePath, parseConfig } from "./load";
import { DEFAULT_CONFIG, type GoalConfig, type NotificationConfig, type SidebarConfig, type TodoReminderConfig, type ToolkitConfig } from "./types";

export interface ConfigStore {
  /** Read the current persisted config. */
  get(): ToolkitConfig;
  /** Persist the whole config atomically. */
  set(config: ToolkitConfig): void;
  /** Read and merge a partial patch, then persist. Returns the new config. */
  update(patch: Partial<ToolkitConfig>): ToolkitConfig;
  /** Update only the notification section. Returns the new config. */
  updateNotification(patch: Partial<NotificationConfig>): ToolkitConfig;
  /** Update only the todo-reminder section. Returns the new config. */
  updateTodoReminder(patch: Partial<TodoReminderConfig>): ToolkitConfig;
  /** Update only the goal section. Returns the new config. */
  updateGoal(patch: Partial<GoalConfig>): ToolkitConfig;
  /** Update only the sidebar section. Returns the new config. */
  updateSidebar(patch: Partial<SidebarConfig>): ToolkitConfig;
  /** Subscribe to config changes. Returns an unsubscribe function. */
  subscribe(listener: (config: ToolkitConfig) => void): () => void;
  path: string;
}

export function createConfigStore(path: string = configFilePath()): ConfigStore {
  const listeners = new Set<(config: ToolkitConfig) => void>();

  function read(): ToolkitConfig {
    try {
      const content = readFileSync(path, "utf8");
      return parseConfig(JSON.parse(content) as unknown);
    } catch {
      return structuredClone(DEFAULT_CONFIG);
    }
  }

  function write(config: ToolkitConfig): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmpPath = `${path}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf8");
    renameSync(tmpPath, path);
  }

  function notify(config: ToolkitConfig): void {
    for (const listener of listeners) listener(config);
  }

  return {
    path,
    get: read,
    set(config) {
      write(config);
      notify(config);
    },
    update(patch) {
      const next: ToolkitConfig = { ...read(), ...patch };
      write(next);
      notify(next);
      return next;
    },
    updateNotification(patch) {
      const next: ToolkitConfig = read();
      next.notification = { ...next.notification, ...patch };
      write(next);
      notify(next);
      return next;
    },
    updateTodoReminder(patch) {
      const next: ToolkitConfig = read();
      next.todoReminder = { ...next.todoReminder, ...patch };
      write(next);
      notify(next);
      return next;
    },
    updateGoal(patch) {
      const next: ToolkitConfig = read();
      next.goal = { ...next.goal, ...patch };
      write(next);
      notify(next);
      return next;
    },
    updateSidebar(patch) {
      const next: ToolkitConfig = read();
      next.sidebar = { ...next.sidebar, ...patch };
      write(next);
      notify(next);
      return next;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
