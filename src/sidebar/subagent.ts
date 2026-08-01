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

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]/g, "");
}

/**
 * Track sub-agent invocations in a session, derived from the live part stream.
 *
 * A sub-agent is introduced by a `subtask` part (its `sessionID` is the PARENT
 * session, not the child) or by a `task`/`delegate` tool call (the child
 * session id lives in `ToolState.metadata.session_id`). Completion is resolved
 * via child-session idle/error events, matched by exact sessionId first, then
 * by agent name, then by time proximity — mirroring opencode-subagent-magazine.
 */
export function createSubagentTracker(getSessionAgent?: (sessionID: string) => string | undefined) {
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
        // SubtaskPart.sessionID is the PARENT session, not the child.
        // The real child session id is discovered later via tool metadata or
        // matched through agent-name fallback on session.idle/error.
        upsert(`sub:${part.id}`, {
          agent: part.agent,
          title: part.description || part.agent,
          status: "running",
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
        // Child session id lives in state-level metadata (ToolStateCompleted.metadata),
        // injected by the tool executor. ToolPart.sessionID is the parent session.
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
    const nowTs = Date.now();

    // Phase 1: exact sessionId match.
    let matchedId: string | undefined;
    for (const [id, entry] of entries) {
      if (entry.sessionId === sessionID && entry.status === "running") {
        matchedId = id;
        break;
      }
    }

    // Phase 2: agent-name match (session agent vs entry agent overlap).
    if (matchedId === undefined && getSessionAgent) {
      const sessionAgent = getSessionAgent(sessionID);
      if (sessionAgent) {
        const saNorm = normalize(sessionAgent);
        let best: { id: string; gap: number } | null = null;
        for (const [id, entry] of entries) {
          if (entry.status !== "running") continue;
          const eaNorm = normalize(entry.agent);
          if (!eaNorm || !saNorm) continue;
          if (!eaNorm.includes(saNorm) && !saNorm.includes(eaNorm)) continue;
          const gap = nowTs - (entry.startedAt || 0);
          if (!best || gap > best.gap) best = { id, gap };
        }
        // Fallback: time proximity for entries with no sessionId yet.
        if (!best) {
          for (const [id, entry] of entries) {
            if (entry.status !== "running") continue;
            if (entry.sessionId) continue;
            const gap = nowTs - (entry.startedAt || 0);
            if (!best || gap > best.gap) best = { id, gap };
          }
        }
        matchedId = best?.id;
      }
    }

    if (matchedId !== undefined) {
      const entry = entries.get(matchedId);
      if (entry) {
        entry.status = status;
        entry.endedAt = nowTs;
        // Backfill the real child session id so later reads target the child.
        entry.sessionId = sessionID;
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
