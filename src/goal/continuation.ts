import type { ToolkitConfig } from "../config/types";
import { loadConfig } from "../config/load";
import { getSessionID } from "../notification/event-properties";
import { classifyGoalFailure } from "./error";
import { buildBudgetLimitPrompt, buildContinuationPrompt, buildObjectiveUpdatedPrompt } from "./prompts";
import type { GoalController } from "./controller";
import type { Goal } from "./types";

interface GoalContinuationContext {
  client: {
    session: {
      messages(id: string): Promise<
        Array<{
          info: Record<string, unknown>;
          parts?: Array<{ type?: string; text?: string; metadata?: Record<string, unknown> }>;
        }> | undefined
      >;
      prompt(
        id: string,
        body: {
          agent?: string;
          parts: Array<{ type: "text"; text: string; metadata?: Record<string, unknown> }>;
        },
      ): Promise<unknown>;
    };
  };
  loadConfigOverride?: () => ToolkitConfig;
}

interface EventInput {
  event: { type: string; properties?: unknown };
}

const GOAL_MARKER = "<!-- GOAL_CONTINUATION -->";
const BASE_COOLDOWN_MS = 5_000;

interface SessionRunState {
  consecutiveFailures: number;
  lastInjectedAt?: number;
  wasCancelled?: boolean;
  tokenLimitDetected?: boolean;
  insufficientFundsDetected?: boolean;
  lastFailureKind?: string;
  lastFailureAt?: number;
}

interface GoalRunStateStore {
  get(sessionID: string): SessionRunState;
  clear(sessionID: string): void;
}

function createGoalRunStateStore(): GoalRunStateStore {
  const states = new Map<string, SessionRunState>();
  return {
    get(sessionID) {
      const existing = states.get(sessionID);
      if (existing) return existing;
      const state: SessionRunState = { consecutiveFailures: 0 };
      states.set(sessionID, state);
      return state;
    },
    clear(sessionID) {
      states.delete(sessionID);
    },
  };
}

export function createGoalContinuation(args: {
  controller: GoalController;
  ctx: GoalContinuationContext;
}): (input: EventInput) => Promise<void> {
  const { controller, ctx } = args;
  const loadConfigFn = ctx.loadConfigOverride ?? loadConfig;
  const runStates = createGoalRunStateStore();
  const inFlight = new Set<string>();

  const promptForKind = (goal: Goal, kind: "continuation" | "budget_limit" | "objective_updated"): string => {
    switch (kind) {
      case "continuation":
        return `${buildContinuationPrompt(goal)}\n${GOAL_MARKER}`;
      case "budget_limit":
        return `${buildBudgetLimitPrompt(goal)}\n${GOAL_MARKER}`;
      case "objective_updated":
        return `${buildObjectiveUpdatedPrompt(goal)}\n${GOAL_MARKER}`;
    }
  };

  const inject = async (sessionID: string, text: string): Promise<boolean> => {
    if (inFlight.has(sessionID)) return false;
    inFlight.add(sessionID);
    try {
      await ctx.client.session.prompt(sessionID, {
        parts: [{ type: "text", text, metadata: { goalContinuation: true } }],
      });
      return true;
    } catch {
      return false;
    } finally {
      inFlight.delete(sessionID);
    }
  };

  const effectiveCooldown = (state: SessionRunState, maxMs: number): number => {
    return Math.min(BASE_COOLDOWN_MS * 2 ** Math.min(state.consecutiveFailures, 6), maxMs);
  };

  const handleSessionIdle = async (sessionID: string): Promise<void> => {
    const cfg = loadConfigFn();
    if (!cfg.enabled || !cfg.goal.enabled) return;

    const state = runStates.get(sessionID);
    if (state.wasCancelled || state.tokenLimitDetected || state.insufficientFundsDetected) return;

    const goal = controller.getGoal(sessionID);
    if (goal === null || goal.status !== "active") return;

    if (state.lastInjectedAt && Date.now() - state.lastInjectedAt < effectiveCooldown(state, cfg.goal.maxRetryCooldownMs)) {
      return;
    }

    const text = promptForKind(goal, "continuation");
    const ok = await inject(sessionID, text);
    if (ok) {
      state.lastInjectedAt = Date.now();
      state.consecutiveFailures = 0;
    } else {
      state.consecutiveFailures += 1;
    }
  };

  const handleSessionError = (sessionID: string, error: unknown): void => {
    const cfg = loadConfigFn();
    if (!cfg.enabled || !cfg.goal.enabled) return;

    const state = runStates.get(sessionID);
    const kind = classifyGoalFailure(error);
    state.lastFailureKind = kind;
    state.lastFailureAt = Date.now();

    if (kind === "insufficient_funds") {
      state.insufficientFundsDetected = true;
      controller.pauseGoal(sessionID);
      return;
    }
    if (kind === "abort") {
      state.wasCancelled = true;
      return;
    }
    if (kind === "token_limit") {
      state.tokenLimitDetected = true;
      return;
    }

    state.consecutiveFailures += 1;
  };

  return async (input: EventInput): Promise<void> => {
    const { event } = input;
    const props = event.properties as Record<string, unknown> | undefined;

    if (event.type === "session.idle") {
      const sessionID = getSessionID(props);
      if (!sessionID) return;
      await handleSessionIdle(sessionID);
      return;
    }

    if (event.type === "session.error") {
      const sessionID = getSessionID(props);
      if (!sessionID) return;
      handleSessionError(sessionID, props?.error);
      return;
    }

    if (event.type === "session.deleted") {
      const sessionID = getSessionID(props);
      if (sessionID) runStates.clear(sessionID);
      return;
    }
  };
}
