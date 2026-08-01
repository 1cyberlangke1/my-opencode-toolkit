/** @jsxImportSource @opentui/solid */

import { createSignal, onCleanup, onMount, untrack, Show, For } from "solid-js";
import type { TuiPluginApi, TuiSlotContext, TuiSlotPlugin, TuiThemeCurrent } from "@opencode-ai/plugin/tui";
import type { Message } from "@opencode-ai/sdk/v2";

import type { ConfigStore } from "../config/store";
import { createTranslator, resolveLang, type Translator } from "../i18n";
import { formatDuration, padRight, truncate } from "./format";
import { createSidebarPersist, KV_KEYS } from "./persist";
import {
  cacheHitRate,
  computeSessionStats,
  formatPercent,
  formatTokens,
  type CacheStats,
  type SessionStats,
} from "./stats";
import { subscribeSidebarEvents, type SidebarEventSubscriptions } from "./events";
import type { SubStatus, SubagentEntry, TokenBreakdown } from "./subagent";
import { usePalette, rgb } from "./theme";

const ORDER = 70;

export function createSidebarSlot(api: TuiPluginApi, store: ConfigStore): TuiSlotPlugin {
  return {
    order: ORDER,
    slots: {
      sidebar_content(ctx: TuiSlotContext, input: { session_id: string }) {
        return <SessionStatsPanel api={api} store={store} theme={ctx.theme.current} sessionId={input.session_id} />;
      },
    },
  };
}

interface PanelProps {
  api: TuiPluginApi;
  store: ConfigStore;
  theme: TuiThemeCurrent;
  sessionId: string;
}

function SessionStatsPanel(props: PanelProps) {
  const { api, store, sessionId } = props;
  const pal = usePalette(props.theme);
  const persist = createSidebarPersist(api.kv);

  const t = (key: Parameters<Translator>[0]): string => {
    const config = store.get();
    return createTranslator(resolveLang(config.lang, process.env))(key);
  };

  const [stats, setStatsRaw] = createSignal<SessionStats>({ cache: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, tools: [], subagentCount: 0 });
  const [subagents, setSubagents] = createSignal<SubagentEntry[]>([]);
  const [expandedId, setExpandedId] = createSignal<string | undefined>(undefined);
  const [childStats, setChildStats] = createSignal<SessionStats | undefined>(undefined);
  const [renderTick, setRenderTick] = createSignal(0);
  const bump = (): void => {
    setRenderTick((v) => v + 1);
  };

  const [cacheOpen, setCacheOpen] = createSignal(persist.loadBool(KV_KEYS.cacheOpen, true));
  const [toolsOpen, setToolsOpen] = createSignal(persist.loadBool(KV_KEYS.toolsOpen, false));
  const [subOpen, setSubOpen] = createSignal(persist.loadBool(KV_KEYS.subOpen, false));
  const [collapsed, setCollapsed] = createSignal(persist.loadBool(KV_KEYS.panelCollapsed, false));
  const [childCacheOpen, setChildCacheOpen] = createSignal(persist.loadBool(KV_KEYS.childCacheOpen, true));
  const [childToolsOpen, setChildToolsOpen] = createSignal(persist.loadBool(KV_KEYS.childToolsOpen, true));

  // Breathing clock for the "running" status dot.
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const clock = setInterval(() => setNow(Date.now()), 100);
    onCleanup(() => clearInterval(clock));
  });

  // Wrap stats setter to persist after every update.
  const setStats = (next: SessionStats): void => {
    setStatsRaw(next);
    persist.saveStats(sessionId, next);
  };

  const getParts = (messageID: string) => api.state.part(messageID);
  const getMessages = (sid: string): readonly Message[] => api.state.session.messages(sid);

  function refreshStats(): void {
    const messages = getMessages(sessionId);
    setStats(computeSessionStats(messages, getParts));
  }

  function refreshChildStats(entry: SubagentEntry): void {
    if (!entry.sessionId) {
      setChildStats(undefined);
      return;
    }
    const sid = entry.sessionId;
    const child = computeSessionStats(getMessages(sid), getParts);
    setChildStats(child);
    // Dynamically read metrics for history-scanned entries (no idle event fired).
    const tokens = readSessionTokens(sid);
    const model = readSessionModel(sid);
    const cost = readSessionCost(sid);
    const patch: Partial<Pick<SubagentEntry, "tokens" | "cost" | "model">> = {};
    if (tokens !== undefined) patch.tokens = tokens;
    if (model !== undefined) patch.model = model;
    if (cost !== undefined) patch.cost = cost;
    subscriptions?.tracker.updateEntry(entry.id, patch);
    // Sync the tracker back into the reactive signal so the expanded detail shows fresh data.
    setSubagents(Array.from(subscriptions?.tracker.entries.values() ?? []));
    bump();
  }

  function readSessionTokens(sid: string): TokenBreakdown | undefined {
    const msgs = getMessages(sid);
    const acc: TokenBreakdown = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    let found = false;
    for (const m of msgs) {
      if (m === undefined || m.role !== "assistant" || !("tokens" in m) || m.tokens === undefined) continue;
      const tokens = m.tokens as {
        input: number;
        output: number;
        reasoning: number;
        cache: { read: number; write: number };
      };
      acc.input += Number(tokens.input) || 0;
      acc.output += Number(tokens.output) || 0;
      acc.reasoning += Number(tokens.reasoning) || 0;
      acc.cacheRead += Number(tokens.cache?.read) || 0;
      acc.cacheWrite += Number(tokens.cache?.write) || 0;
      found = true;
    }
    return found ? acc : undefined;
  }

  function readSessionModel(sid: string): string | undefined {
    const msgs = getMessages(sid);
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m === undefined) continue;
      if (m.role === "assistant" && "modelID" in m && m.modelID) return String(m.modelID);
      if ("model" in m && m.model !== undefined && m.model.modelID) return String(m.model.modelID);
    }
    return undefined;
  }

  function readSessionCost(sid: string): number | undefined {
    try {
      const session = api.state.session.get(sid);
      if (session?.cost !== undefined && session.cost > 0) return session.cost;
      const msgs = getMessages(sid);
      let total = 0;
      for (const m of msgs) {
        if (m.role === "assistant" && "cost" in m && typeof m.cost === "number") {
          total += m.cost;
        }
      }
      return total > 0 ? total : undefined;
    } catch {
      return undefined;
    }
  }

  function fillEntryMetrics(sid: string, ids: string[]): void {
    const tokens = readSessionTokens(sid);
    const model = readSessionModel(sid);
    const cost = readSessionCost(sid);
    for (const id of ids) {
      const patch: Partial<Pick<SubagentEntry, "tokens" | "cost" | "model">> = {};
      if (tokens !== undefined) patch.tokens = tokens;
      if (model !== undefined) patch.model = model;
      if (cost !== undefined) patch.cost = cost;
      subscriptions?.tracker.updateEntry(id, patch);
    }
  }

  let subscriptions: SidebarEventSubscriptions | undefined;
  let disposed = false;
  const pendingTimers: Array<ReturnType<typeof setTimeout>> = [];

  // Re-read sub-agent metrics (tokens/cost/model) right after the session.idle
  // / session.error event. SDK state may not have settled at event time, so a
  // single delayed re-read captures the final values (matches the reference
  // implementation's "delayed backfill" comment).
  function backfillEntryMetrics(sid: string): void {
    fillEntryMetrics(sid, Array.from(subscriptions?.tracker.entries.keys() ?? []));
    setSubagents(Array.from(subscriptions?.tracker.entries.values() ?? []));
    bump();
  }

  onMount(() => {
    // Restore cached stats immediately (survives restart).
    const cached = persist.loadStats(sessionId);
    if (cached) setStatsRaw(cached);

    subscriptions = subscribeSidebarEvents(
      api.event,
      {
        onUpdate: () => {
          refreshStats();
          setSubagents(Array.from(subscriptions?.tracker.entries.values() ?? []));
          bump();
        },
        onSubagentDone: (sid) => {
          subscriptions?.tracker.resolveBySession(sid, "done");
          backfillEntryMetrics(sid);
          const timer = setTimeout(() => {
            if (disposed) return;
            backfillEntryMetrics(sid);
          }, 150);
          pendingTimers.push(timer);
        },
        onSubagentError: (sid) => {
          subscriptions?.tracker.resolveBySession(sid, "error");
          backfillEntryMetrics(sid);
          const timer = setTimeout(() => {
            if (disposed) return;
            backfillEntryMetrics(sid);
          }, 150);
          pendingTimers.push(timer);
        },
      },
    );
    setSubagents(Array.from(subscriptions.tracker.entries.values()));
    onCleanup(() => {
      disposed = true;
      for (const timer of pendingTimers) clearTimeout(timer);
      pendingTimers.length = 0;
      subscriptions?.dispose();
    });
  });

  // Delayed initial scan: wait for state to be ready, then merge history.
  onMount(() => {
    const timer = setTimeout(() => {
      untrack(() => {
        refreshStats();
        const existing = getMessages(sessionId);
        for (const message of existing) {
          subscriptions?.tracker.scanParts(getParts(message.id));
        }
        setSubagents(Array.from(subscriptions?.tracker.entries.values() ?? []));
        bump();
      });
    }, 200);
    onCleanup(() => clearTimeout(timer));
  });

  const hitRate = (): string => formatPercent(cacheHitRate(stats().cache));
  const cache = (): CacheStats => stats().cache;
  const childHitRate = (): string => {
    const c = childStats()?.cache;
    if (!c) return "";
    return formatPercent(cacheHitRate(c));
  };
  const sep = (): string => "─".repeat(Math.max(1, 22));

  const toggleBool = (get: () => boolean, set: (v: boolean) => void, key: string): void => {
    const next = !get();
    set(next);
    persist.saveBool(key, next);
    bump();
  };

  return (
    <box flexDirection="column" gap={0}>
      {/* ── panel header ── */}
      <text onMouseUp={() => toggleBool(collapsed, setCollapsed, KV_KEYS.panelCollapsed)}>
        <span style={{ fg: pal().muted }}>{renderTick() >= 0 && collapsed() ? "▶ " : "▼ "}</span>
        <span style={{ fg: pal().primary }}>{t("sidebar.title")}</span>
      </text>

      <Show when={renderTick() >= 0 && !collapsed()}>
        <box paddingLeft={2} flexDirection="column" gap={0}>
          {/* ── cache section ── */}
          <Show when={store.get().sidebar.showCache}>
            <text onMouseUp={() => toggleBool(cacheOpen, setCacheOpen, KV_KEYS.cacheOpen)}>
              <span style={{ fg: pal().muted }}>{renderTick() >= 0 && cacheOpen() ? "▼ " : "▶ "}</span>
              <span style={{ fg: pal().primary }}>{t("sidebar.cache.title")}</span>
            </text>
            <Show when={renderTick() >= 0 && cacheOpen()}>
              <box paddingLeft={2} flexDirection="column" gap={0}>
                <text>
                  <span style={{ fg: pal().text }}>{padRight(`${t("sidebar.cache.hitRate")}:`, 14)}</span>
                  <span style={{ fg: pal().success }}>{hitRate()}</span>
                </text>
                <text>
                  <span style={{ fg: pal().text }}>{padRight(`${t("sidebar.cache.input")}:`, 14)}</span>
                  <span style={{ fg: pal().muted }}>{formatTokens(cache().input)}</span>
                </text>
                <text>
                  <span style={{ fg: pal().text }}>{padRight(`${t("sidebar.cache.output")}:`, 14)}</span>
                  <span style={{ fg: pal().muted }}>{formatTokens(cache().output)}</span>
                </text>
                <text>
                  <span style={{ fg: pal().text }}>{padRight(`${t("sidebar.cache.read")}:`, 14)}</span>
                  <span style={{ fg: pal().muted }}>{formatTokens(cache().cacheRead)}</span>
                </text>
                <text>
                  <span style={{ fg: pal().text }}>{padRight(`${t("sidebar.cache.write")}:`, 14)}</span>
                  <span style={{ fg: pal().muted }}>{formatTokens(cache().cacheWrite)}</span>
                </text>
              </box>
            </Show>
            <text style={{ fg: pal().border }}>{sep()}</text>
          </Show>

          {/* ── tools section ── */}
          <Show when={store.get().sidebar.showTools}>
            <text onMouseUp={() => toggleBool(toolsOpen, setToolsOpen, KV_KEYS.toolsOpen)}>
              <span style={{ fg: pal().muted }}>{renderTick() >= 0 && toolsOpen() ? "▼ " : "▶ "}</span>
              <span style={{ fg: pal().primary }}>
                {t("sidebar.tools.title")} ({stats().tools.length})
              </span>
            </text>
            <Show when={renderTick() >= 0 && toolsOpen()}>
              <Show
                when={stats().tools.length > 0}
                fallback={<text style={{ fg: pal().muted }}>{t("sidebar.empty")}</text>}
              >
                <box paddingLeft={2} flexDirection="column" gap={0}>
                  <For each={stats().tools}>
                    {(tool) => (
                      <text>
                        <span style={{ fg: pal().text }}>{padRight(truncate(tool.name, 18), 18)}</span>
                        <span style={{ fg: pal().muted }}>{tool.count}</span>
                      </text>
                    )}
                  </For>
                </box>
              </Show>
            </Show>
            <text style={{ fg: pal().border }}>{sep()}</text>
          </Show>

          {/* ── subagents section ── */}
          <Show when={store.get().sidebar.showSubagents}>
            <text onMouseUp={() => toggleBool(subOpen, setSubOpen, KV_KEYS.subOpen)}>
              <span style={{ fg: pal().muted }}>{renderTick() >= 0 && subOpen() ? "▼ " : "▶ "}</span>
              <span style={{ fg: pal().primary }}>
                {t("sidebar.subagents.title")} ({subagents().length})
              </span>
            </text>
            <Show when={renderTick() >= 0 && subOpen()}>
              <Show
                when={subagents().length > 0}
                fallback={<text style={{ fg: pal().muted }}>{t("sidebar.empty")}</text>}
              >
                <box paddingLeft={2} flexDirection="column" gap={0}>
                  <For each={subagents()}>
                    {(entry) => (
                      <box flexDirection="column" gap={0}>
                        <text
                          onMouseUp={() => {
                            const next = expandedId() === entry.id ? undefined : entry.id;
                            setExpandedId(next);
                            if (next) refreshChildStats(entry);
                            bump();
                          }}
                        >
                          <span style={{ fg: pal().muted }}>{renderTick() >= 0 && expandedId() === entry.id ? "▼ " : "▶ "}</span>
                          <span style={{ fg: statusColor(entry.status) }}>{statusDot()}</span>
                          <span style={{ fg: pal().text }}> {truncate(entry.title, 20)}</span>
                        </text>

                        <Show when={renderTick() >= 0 && expandedId() === entry.id}>
                          <box paddingLeft={2} flexDirection="column" gap={0}>
                            <text>
                              <span style={{ fg: pal().primary }}>{t("sidebar.subagents.field.agent")}: </span>
                              <span style={{ fg: pal().muted }}>{entry.agent}</span>
                            </text>
                            <text>
                              <span style={{ fg: pal().primary }}>{t("sidebar.subagents.field.status")}: </span>
                              <span style={{ fg: statusColor(entry.status) }}>{statusLabel(entry.status, t)}</span>
                            </text>
                            <Show when={entry.endedAt !== undefined}>
                              <text>
                                <span style={{ fg: pal().primary }}>{t("sidebar.subagents.field.duration")}: </span>
                                <span style={{ fg: pal().muted }}>
                                  {formatDuration(entry.endedAt! - entry.startedAt)}
                                </span>
                              </text>
                            </Show>
                            <Show when={entry.tokens !== undefined}>
                              <text>
                                <span style={{ fg: pal().text }}>{padRight(`${t("sidebar.cache.input")}:`, 14)}</span>
                                <span style={{ fg: pal().muted }}>{formatTokens(entry.tokens!.input)}</span>
                              </text>
                              <text>
                                <span style={{ fg: pal().text }}>{padRight(`${t("sidebar.cache.output")}:`, 14)}</span>
                                <span style={{ fg: pal().muted }}>{formatTokens(entry.tokens!.output)}</span>
                              </text>
                              <text>
                                <span style={{ fg: pal().text }}>{padRight(`${t("sidebar.cache.read")}:`, 14)}</span>
                                <span style={{ fg: pal().muted }}>{formatTokens(entry.tokens!.cacheRead)}</span>
                              </text>
                              <text>
                                <span style={{ fg: pal().text }}>{padRight(`${t("sidebar.cache.write")}:`, 14)}</span>
                                <span style={{ fg: pal().muted }}>{formatTokens(entry.tokens!.cacheWrite)}</span>
                              </text>
                            </Show>
                            <Show when={entry.cost !== undefined}>
                              <text>
                                <span style={{ fg: pal().primary }}>{t("sidebar.subagents.field.cost")}: </span>
                                <span style={{ fg: pal().warning }}>${entry.cost!.toFixed(4)}</span>
                              </text>
                            </Show>
                            <Show when={entry.model !== undefined}>
                              <text>
                                <span style={{ fg: pal().primary }}>{t("sidebar.subagents.field.model")}: </span>
                                <span style={{ fg: pal().muted }}>{truncate(entry.model!, 24)}</span>
                              </text>
                            </Show>

                            {/* child cache section (collapsible) */}
                            <text onMouseUp={() => toggleBool(childCacheOpen, setChildCacheOpen, KV_KEYS.childCacheOpen)}>
                              <span style={{ fg: pal().muted }}>{renderTick() >= 0 && childCacheOpen() ? "▼ " : "▶ "}</span>
                              <span style={{ fg: pal().primary }}>
                                {t("sidebar.cache.title")} {childHitRate() ? `(${childHitRate()})` : ""}
                              </span>
                            </text>
                            <Show when={renderTick() >= 0 && childCacheOpen() && childStats() !== undefined}>
                              <box paddingLeft={2} flexDirection="column" gap={0}>
                                <text>
                                  <span style={{ fg: pal().text }}>{padRight(`${t("sidebar.cache.input")}:`, 14)}</span>
                                  <span style={{ fg: pal().muted }}>{formatTokens(childStats()!.cache.input)}</span>
                                </text>
                                <text>
                                  <span style={{ fg: pal().text }}>{padRight(`${t("sidebar.cache.output")}:`, 14)}</span>
                                  <span style={{ fg: pal().muted }}>{formatTokens(childStats()!.cache.output)}</span>
                                </text>
                                <text>
                                  <span style={{ fg: pal().text }}>{padRight(`${t("sidebar.cache.read")}:`, 14)}</span>
                                  <span style={{ fg: pal().muted }}>{formatTokens(childStats()!.cache.cacheRead)}</span>
                                </text>
                                <text>
                                  <span style={{ fg: pal().text }}>{padRight(`${t("sidebar.cache.write")}:`, 14)}</span>
                                  <span style={{ fg: pal().muted }}>{formatTokens(childStats()!.cache.cacheWrite)}</span>
                                </text>
                              </box>
                            </Show>

                            {/* child tools section (collapsible) */}
                            <text onMouseUp={() => toggleBool(childToolsOpen, setChildToolsOpen, KV_KEYS.childToolsOpen)}>
                              <span style={{ fg: pal().muted }}>{renderTick() >= 0 && childToolsOpen() ? "▼ " : "▶ "}</span>
                              <span style={{ fg: pal().primary }}>
                                {t("sidebar.subagents.field.tools")} ({childStats()?.tools.length ?? 0})
                              </span>
                            </text>
                            <Show
                              when={
                                renderTick() >= 0 &&
                                childToolsOpen() &&
                                childStats() !== undefined &&
                                childStats()!.tools.length > 0
                              }
                            >
                              <box paddingLeft={2} flexDirection="column" gap={0}>
                                <For each={childStats()?.tools ?? []}>
                                  {(tool) => (
                                    <text>
                                      <span style={{ fg: pal().text }}>{padRight(truncate(tool.name, 16), 16)}</span>
                                      <span style={{ fg: pal().muted }}>{tool.count}</span>
                                    </text>
                                  )}
                                </For>
                              </box>
                            </Show>

                            <Show when={entry.sessionId}>
                              <text
                                onMouseUp={() => {
                                  if (entry.sessionId) {
                                    api.route.navigate("session", { sessionID: entry.sessionId });
                                  }
                                }}
                              >
                                <span style={{ fg: pal().warning }}>→ {t("sidebar.subagents.open")}</span>
                              </text>
                            </Show>
                          </box>
                        </Show>
                      </box>
                    )}
                  </For>
                </box>
              </Show>
            </Show>
          </Show>

          <Show when={stats().tools.length === 0 && cache().input === 0 && subagents().length === 0}>
            <text style={{ fg: pal().muted }}>{t("sidebar.empty")}</text>
          </Show>
        </box>
      </Show>
    </box>
  );

  function statusDot(): string {
    return "●";
  }

  function statusColor(status: SubStatus): string {
    if (status === "done") return pal().success;
    if (status === "error") return pal().error;
    // running: breathing between muted and warning (2s cycle)
    const t = (Math.sin(((now() % 2000) / 2000) * Math.PI * 2 - Math.PI / 2) + 1) / 2;
    const a = rgb(pal().muted);
    const b = rgb(pal().warning);
    if (!a || !b) return pal().warning;
    const r = Math.round(a.r + (b.r - a.r) * t);
    const g = Math.round(a.g + (b.g - a.g) * t);
    const bl = Math.round(a.b + (b.b - a.b) * t);
    return `#${[r, g, bl].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")}`;
  }

  function statusLabel(status: SubStatus, tr: Translator): string {
    switch (status) {
      case "running":
        return tr("sidebar.subagents.status.running");
      case "done":
        return tr("sidebar.subagents.status.done");
      case "error":
        return tr("sidebar.subagents.status.error");
    }
  }
}
