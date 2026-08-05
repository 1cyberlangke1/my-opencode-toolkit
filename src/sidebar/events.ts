import type { TuiEventBus, TuiState } from "@opencode-ai/plugin/tui";
import type { Part } from "@opencode-ai/sdk/v2";

import { createSubagentTracker, type SubagentTracker } from "./subagent";

export interface SidebarEventHandlers {
  /** Called when stats should be recomputed and the panel re-rendered. */
  onUpdate(): void;
  /** Called when a sub-agent session became idle (done). */
  onSubagentDone(sessionID: string): void;
  /** Called when a sub-agent session errored. */
  onSubagentError(sessionID: string): void;
}

export interface SidebarEventSubscriptions {
  tracker: SubagentTracker;
  dispose(): void;
}

/**
 * Subscribe to the TUI event stream and route events into the tracker and
 * render loop. Returns the tracker plus a disposer that unsubscribes all.
 */
export function subscribeSidebarEvents(
  event: TuiEventBus,
  state: TuiState,
  handlers: SidebarEventHandlers,
): SidebarEventSubscriptions {
  const tracker = createSubagentTracker((sessionID) => {
    try {
      const session = state.session.get(sessionID);
      return session?.agent;
    } catch {
      return undefined;
    }
  });

  // 每个 handler 包 try/catch：单事件异常不能 crash bus subscriber / 中断本次刷新
  // （opencode issue #12931：handler 抛错会 corrupt display 且后续事件不再派发 → 统计冻结）。
  const unsubPart = event.on("message.part.updated", (e) => {
    try {
      // 运行时防御：part 可能缺失/结构异常（对齐 magazine handlePartUpdated 的 `if (!part) return`）。
      const part = e.properties.part as Part | undefined;
      if (!part) return;
      tracker.scanParts([part]);
      handlers.onUpdate();
    } catch {
      // ignore：单事件异常不影响后续事件
    }
  });

  const unsubDelta = event.on("message.part.delta", () => {
    try {
      handlers.onUpdate();
    } catch {
      // ignore
    }
  });

  const unsubMessage = event.on("message.updated", () => {
    try {
      handlers.onUpdate();
    } catch {
      // ignore
    }
  });

  const unsubIdle = event.on("session.idle", (e) => {
    try {
      handlers.onSubagentDone(e.properties.sessionID);
    } catch {
      // ignore
    }
  });

  const unsubError = event.on("session.error", (e) => {
    try {
      handlers.onSubagentError(e.properties.sessionID ?? "");
    } catch {
      // ignore
    }
  });

  // 切换模型（POST /session/{id}/model）触发 session.updated：主动重算统计，
  // 避免切换模型后统计滞后/不更新。
  const unsubSession = event.on("session.updated", () => {
    try {
      handlers.onUpdate();
    } catch {
      // ignore
    }
  });

  return {
    tracker,
    dispose() {
      unsubPart();
      unsubDelta();
      unsubMessage();
      unsubIdle();
      unsubError();
      unsubSession();
    },
  };
}
