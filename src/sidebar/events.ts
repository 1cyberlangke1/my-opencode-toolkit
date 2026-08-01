import type { TuiEventBus, TuiState } from "@opencode-ai/plugin/tui";

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

  const unsubPart = event.on("message.part.updated", (e) => {
    const part = e.properties.part;
    tracker.scanParts([part]);
    handlers.onUpdate();
  });

  const unsubDelta = event.on("message.part.delta", () => {
    handlers.onUpdate();
  });

  const unsubMessage = event.on("message.updated", () => {
    handlers.onUpdate();
  });

  const unsubIdle = event.on("session.idle", (e) => {
    handlers.onSubagentDone(e.properties.sessionID);
  });

  const unsubError = event.on("session.error", (e) => {
    handlers.onSubagentError(e.properties.sessionID ?? "");
  });

  return {
    tracker,
    dispose() {
      unsubPart();
      unsubDelta();
      unsubMessage();
      unsubIdle();
      unsubError();
    },
  };
}
