import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { configFilePath, parseConfig } from "./load";
import { DEFAULT_CONFIG, type NotificationConfig, type SidebarConfig, type ToolkitConfig } from "./types";

export interface ConfigStore {
  /** Read the current persisted config. */
  get(): ToolkitConfig;
  /** Persist the whole config atomically. */
  set(config: ToolkitConfig): void;
  /** Read and merge a partial patch, then persist. Returns the new config. */
  update(patch: Partial<ToolkitConfig>): ToolkitConfig;
  /** Update only the notification section. Returns the new config. */
  updateNotification(patch: Partial<NotificationConfig>): ToolkitConfig;
  /** Update only the sidebar section. Returns the new config. */
  updateSidebar(patch: Partial<SidebarConfig>): ToolkitConfig;
  path: string;
}

export function createConfigStore(path: string = configFilePath()): ConfigStore {
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

  return {
    path,
    get: read,
    set: write,
    update(patch) {
      const next: ToolkitConfig = { ...read(), ...patch };
      write(next);
      return next;
    },
    updateNotification(patch) {
      const next: ToolkitConfig = read();
      next.notification = { ...next.notification, ...patch };
      write(next);
      return next;
    },
    updateSidebar(patch) {
      const next: ToolkitConfig = read();
      next.sidebar = { ...next.sidebar, ...patch };
      write(next);
      return next;
    },
  };
}
