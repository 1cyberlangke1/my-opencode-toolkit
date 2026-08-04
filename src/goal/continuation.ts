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
          info?: Record<string, unknown>;
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

/** True when the last message is real user input (not an injected continuation). */
async function lastMessageIsUser(ctx: GoalContinuationContext, sessionID: string): Promise<boolean> {
  const messages = await ctx.client.session.messages(sessionID).catch(() => undefined);
  if (!messages || messages.length === 0) return false;
  const last = messages.at(-1);
  if (last?.info?.role !== "user") return false;
  // 注入的续作消息带 GOAL_MARKER，不算「用户输入」——否则注入后 AI 未回复会永久死锁（对齐 todo）。
  const hasMarker = (last.parts ?? []).some(
    (part) => part.type === "text" && typeof part.text === "string" && part.text.includes(GOAL_MARKER),
  );
  return !hasMarker;
}

export interface GoalContinuation {
  /** 事件入口：idle 续作 / session.error 分类 / 活动事件重置锁死标志。 */
  handler: (input: EventInput) => Promise<void>;
  /** 清除会话的锁死标志（wasCancelled/tokenLimitDetected/insufficientFundsDetected），/goal resume 等显式恢复时调用。 */
  resetRunState: (sessionID: string) => void;
}

export function createGoalContinuation(args: {
  controller: GoalController;
  ctx: GoalContinuationContext;
}): GoalContinuation {
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
      // 消息发送后立即弹 toast（不等 prompt resolve——同步 prompt 会挂起到 AI 回复完，
      // 否则 toast 延迟到回复结束才弹，主人期望注入即弹，对齐 scheduling/continuation）。
      const pending = ctx.client.session.prompt(sessionID, {
        parts: [{ type: "text", text, metadata: { goalContinuation: true } }],
      });
      showInjectedToast();
      await pending;
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

  /** 显式恢复（如 /goal resume）时清除锁死标志，否则 resume 后 idle 仍被 wasCancelled 等挡死。 */
  const resetRunState = (sessionID: string): void => {
    // runStates.get 总是返回 state（不存在则创建），无需判空。
    const state = runStates.get(sessionID);
    state.wasCancelled = false;
    state.tokenLimitDetected = false;
    state.insufficientFundsDetected = false;
  };

  return {
    handler: async (input: EventInput): Promise<void> => {
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
      // 同时重置锁死标志（对齐 todo handleNonIdleEvent）：一次打断（abort）或上下文超长
      // （token_limit）后，只要 AI 恢复活动就解除锁定——否则 goal 显示 active 但永不续作。
      // insufficientFundsDetected 保留（真没钱，需用户显式 resume/充值，不应被活动事件自动恢复）。
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
          // runStates.get 总是返回 state（不存在则创建），无需判空。
          const state = runStates.get(sessionID);
          state.wasCancelled = false;
          state.tokenLimitDetected = false;
          if (event.type === "message.updated" || event.type === "tool.execute.after") {
            await accountThrottled(sessionID);
          }
        }
        return;
      }
    },
    resetRunState,
  };
}
