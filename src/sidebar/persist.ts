import type { TuiKV } from "@opencode-ai/plugin/tui";

import type { SessionStats } from "./stats";

const KV_PREFIX = "mot_sidebar";

export const KV_KEYS = {
  stats: (sessionId: string) => `${KV_PREFIX}.${sessionId}.stats`,
  cacheOpen: `${KV_PREFIX}.cacheOpen`,
  toolsOpen: `${KV_PREFIX}.toolsOpen`,
  subOpen: `${KV_PREFIX}.subOpen`,
  panelCollapsed: `${KV_PREFIX}.panelCollapsed`,
  childCacheOpen: `${KV_PREFIX}.childCacheOpen`,
  childToolsOpen: `${KV_PREFIX}.childToolsOpen`,
} as const;

export interface SidebarPersist {
  loadStats(sessionId: string): SessionStats | undefined;
  saveStats(sessionId: string, stats: SessionStats): void;
  loadBool(key: string, fallback: boolean): boolean;
  saveBool(key: string, value: boolean): void;
}

export function createSidebarPersist(kv: TuiKV): SidebarPersist {
  return {
    loadStats(sessionId) {
      try {
        const raw = kv.get<string>(KV_KEYS.stats(sessionId), "");
        if (!raw) return undefined;
        const parsed: unknown = JSON.parse(raw);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          typeof (parsed as Record<string, unknown>).cache === "object" &&
          Array.isArray((parsed as Record<string, unknown>).tools) &&
          typeof (parsed as Record<string, unknown>).subagentCount === "number"
        ) {
          return parsed as SessionStats;
        }
        return undefined;
      } catch {
        return undefined;
      }
    },
    saveStats(sessionId, stats) {
      try {
        kv.set(KV_KEYS.stats(sessionId), JSON.stringify(stats));
      } catch {
        // KV writes must not crash the panel
      }
    },
    loadBool(key, fallback) {
      try {
        const raw = kv.get<boolean>(key, fallback);
        return typeof raw === "boolean" ? raw : fallback;
      } catch {
        return fallback;
      }
    },
    saveBool(key, value) {
      try {
        kv.set(key, value);
      } catch {
        // ignore
      }
    },
  };
}
