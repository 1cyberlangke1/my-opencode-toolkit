import type { ToolkitConfig } from "../config/types";
import { loadConfig } from "../config/load";
import { createTranslator, resolveLang } from "../i18n";
import { getSessionID } from "../notification/event-properties";
import { createGoalAccounting } from "./accounting";
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
          parts?: Array<{ type?: string; text?: string; state?: { status?: string } }>;
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
    tui: {
      showToast(body: {
        title?: string;
        message: string;
        variant: "info" | "success" | "warning" | "error";
        duration?: number;
      }): Promise<unknown>;
    };
  };
  loadConfigOverride?: () => ToolkitConfig;
}

interface EventInput {
  event: { type: string; properties?: unknown };
}

const GOAL_MARKER = "<!-- GOAL_CONTINUATION -->";

interface SessionRunState {
  consecutiveFailures: number;
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

/** True when the last message is a user message (previous continuation not yet answered, or waiting on the user). */
async function lastMessageIsUser(ctx: GoalContinuationContext, sessionID: string): Promise<boolean> {
  const messages = await ctx.client.session.messages(sessionID).catch(() => undefined);
  if (!messages || messages.length === 0) return false;
  const last = messages.at(-1);
  return last?.info.role === "user";
}

export function createGoalContinuation(args: {
  controller: GoalController;
  ctx: GoalContinuationContext;
}): (input: EventInput) => Promise<void> {
  const { controller, ctx } = args;
  const loadConfigFn = ctx.loadConfigOverride ?? loadConfig;
  const runStates = createGoalRunStateStore();
  const accounting = createGoalAccounting();
  const inFlight = new Set<string>();
  const lastAccountAt = new Map<string, number>();
  const ACCOUNT_THROTTLE_MS = 2000;

  /** 实时记账：每轮消息/工具完成后累计 token+时间（throttle 防高频读全量消息）。 */
  const accountThrottled = async (sessionID: string): Promise<void> => {
    const now = Date.now();
    const last = lastAccountAt.get(sessionID);
    if (last !== undefined && now - last < ACCOUNT_THROTTLE_MS) return;
    lastAccountAt.set(sessionID, now);
    await accounting.account(ctx, sessionID, controller);
  };

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
      showInjectedToast();
      return true;
    } catch {
      return false;
    } finally {
      inFlight.delete(sessionID);
    }
  };

  /** Toast shown right after a goal continuation is injected. */
  const showInjectedToast = (): void => {
    const cfg = loadConfigFn();
    const lang = resolveLang(cfg.lang, process.env);
    const t = createTranslator(lang);
    void ctx.client.tui
      .showToast({
        title: t("goalCommand.title"),
        message: t("goalCommand.injected"),
        variant: "info",
      })
      .catch(() => undefined);
  };

  /** Notify the user whenever the goal becomes paused (any path). */
  const showPausedToast = (): void => {
    const cfg = loadConfigFn();
    const lang = resolveLang(cfg.lang, process.env);
    const t = createTranslator(lang);
    void ctx.client.tui
      .showToast({
        title: t("goalCommand.title"),
        message: t("goalCommand.paused"),
        variant: "warning",
      })
      .catch(() => undefined);
  };

  const handleSessionIdle = async (sessionID: string): Promise<void> => {
    const cfg = loadConfigFn();
    if (!cfg.enabled || !cfg.goal.enabled) return;

    // Charge token/time usage first (controller only accrues while active).
    await accounting.account(ctx, sessionID, controller);

    const state = runStates.get(sessionID);
    if (state.wasCancelled || state.tokenLimitDetected || state.insufficientFundsDetected) return;

    const goal = controller.getGoal(sessionID);
    if (goal === null || goal.status !== "active") return;

    // Skip if the last message is a user message (previous continuation not yet answered).
    if (await lastMessageIsUser(ctx, sessionID)) return;

    const text = promptForKind(goal, "continuation");
    const ok = await inject(sessionID, text);
    if (ok) {
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
      const paused = controller.pauseGoal(sessionID);
      if (paused !== null) showPausedToast();
      return;
    }
    if (kind === "abort") {
      // User interrupted the run: pause the goal (codex-style), resume via /goal resume.
      state.wasCancelled = true;
      const paused = controller.pauseGoal(sessionID);
      if (paused !== null) showPausedToast();
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
      if (sessionID) {
        runStates.clear(sessionID);
        accounting.clear(sessionID);
        lastAccountAt.delete(sessionID);
      }
      return;
    }

    // Fallback: activity events release the in-flight flag (todo-style), so a
    // hanging synchronous prompt does not block the next idle continuation.
    // 同时实时记账：每轮消息更新/工具执行后累计 token+时间（throttle 防高频）。
    if (
      event.type === "message.updated" ||
      event.type === "message.part.updated" ||
      event.type === "message.part.delta" ||
      event.type === "tool.execute.before" ||
      event.type === "tool.execute.after"
    ) {
      const sessionID = getSessionID(props);
      if (sessionID) {
        inFlight.delete(sessionID);
        if (event.type === "message.updated" || event.type === "tool.execute.after") {
          await accountThrottled(sessionID);
        }
      }
      return;
    }
  };
}
