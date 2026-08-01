import type { Part } from "@opencode-ai/sdk/v2";

export type SubStatus = "running" | "done" | "error";

export interface TokenBreakdown {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface SubagentEntry {
  id: string;
  agent: string;
  title: string;
  status: SubStatus;
  sessionId?: string;
  startedAt: number;
  endedAt?: number;
  /** Token breakdown consumed by the sub-agent session. */
  tokens?: TokenBreakdown;
  /** USD cost of the sub-agent session. */
  cost?: number;
  /** Model used by the sub-agent session. */
  model?: string;
}

/** Tool names that spawn sub-agents or delegate tasks. */
const SUBAGENT_TOOLS = new Set(["task", "delegate", "call_omo_agent"]);

/**
 * Track sub-agent invocations in a session, derived from the live part stream.
 * A sub-agent is introduced by a `subtask` part or by a `task`/`delegate`
 * tool call; its completion is resolved via child-session idle/error events.
 */
export function createSubagentTracker() {
  const entries = new Map<string, SubagentEntry>();

  function upsert(id: string, partial: Partial<SubagentEntry> & { agent: string }): SubagentEntry {
    const existing = entries.get(id);
    const entry: SubagentEntry = {
      id,
      agent: partial.agent,
      title: partial.title ?? partial.agent,
      status: partial.status ?? "running",
      startedAt: existing?.startedAt ?? partial.startedAt ?? Date.now(),
    };
    if (partial.sessionId !== undefined) entry.sessionId = partial.sessionId;
    if (existing?.endedAt !== undefined) {
      entry.endedAt = existing.endedAt;
    } else if (partial.endedAt !== undefined) {
      entry.endedAt = partial.endedAt;
    }
    entries.set(id, entry);
    return entry;
  }

  /** Scan a part list (from the current session or a child session). */
  function scanParts(parts: readonly Part[]): void {
    for (const part of parts) {
      if (part.type === "subtask") {
        upsert(`sub:${part.id}`, {
          agent: part.agent,
          title: part.description || part.agent,
          status: "running",
          sessionId: part.sessionID,
        });
        continue;
      }
      if (part.type === "tool" && SUBAGENT_TOOLS.has(part.tool)) {
        const status = part.state.status === "completed" ? "done" : "running";
        const input = part.state.input as Record<string, unknown> | undefined;
        const agent =
          typeof input?.subagent_type === "string"
            ? input.subagent_type
            : typeof input?.category === "string"
              ? input.category
              : part.tool;
        const meta =
          part.state.status === "completed" || part.state.status === "running"
            ? (part.state.metadata as Record<string, unknown> | undefined)
            : undefined;
        const sessionId =
          typeof meta?.session_id === "string"
            ? meta.session_id
            : typeof meta?.sessionId === "string"
              ? meta.sessionId
              : undefined;
        const entryPatch: Partial<SubagentEntry> & { agent: string } = {
          agent,
          title: (typeof input?.description === "string" && input.description) || agent,
          status,
        };
        if (sessionId !== undefined) entryPatch.sessionId = sessionId;
        if (status === "done") {
          // Use scan time, not the tool's historical timestamp, so startedAt/endedAt
          // stay on the same clock basis (startedAt defaults to Date.now()).
          entryPatch.endedAt = Date.now();
        }
        upsert(`tool:${part.id}`, entryPatch);
      }
    }
  }

  /** Resolve a sub-agent entry to done/error when a child session ends. */
  function resolveBySession(sessionID: string, status: "done" | "error"): void {
    for (const entry of entries.values()) {
      if (entry.sessionId === sessionID && entry.status === "running") {
        entry.status = status;
        entry.endedAt = Date.now();
      }
    }
  }

  /** Try to link an entry to its child session id when one becomes known. */
  function linkSession(id: string, sessionId: string): void {
    const entry = entries.get(id);
    if (entry && !entry.sessionId) {
      entry.sessionId = sessionId;
    }
  }

  /** Merge extra fields (tokens/cost/model) into an entry by id. */
  function updateEntry(
    id: string,
    patch: Partial<Pick<SubagentEntry, "tokens" | "cost" | "model">>,
  ): void {
    const entry = entries.get(id);
    if (!entry) return;
    if (patch.tokens !== undefined) entry.tokens = patch.tokens;
    if (patch.cost !== undefined) entry.cost = patch.cost;
    if (patch.model !== undefined) entry.model = patch.model;
  }
  return {
    entries,
    upsert,
    scanParts,
    resolveBySession,
    linkSession,
    updateEntry,
  };
}

export type SubagentTracker = ReturnType<typeof createSubagentTracker>;
