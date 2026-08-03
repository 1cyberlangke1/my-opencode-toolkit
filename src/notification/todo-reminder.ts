import type { ToolkitConfig } from "../config/types";
import { loadConfig } from "../config/load";
import { createTranslator, resolveLang } from "../i18n";
import { getSessionID } from "./event-properties";
import { getMainSessionID, subagentSessions } from "./session-state";
import {
  createSessionStateStore,
  type SessionStateStore,
  type TodoItem,
} from "./todo-reminder-state";

interface TodoReminderContext {
  client: {
    session: {
      messages(id: string): Promise<
        Array<{
          info?: Record<string, unknown>;
          parts?: Array<{ type?: string; text?: string; metadata?: Record<string, unknown> }>;
        }> | undefined
      >;
      todo(id: string): Promise<TodoItem[] | undefined>;
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

const COMPLETED_STATUSES = new Set(["completed", "cancelled", "blocked", "deleted"]);
/** Marker appended to injected continuation text so it can be told apart from real user input. */
const CONTINUATION_MARKER = "<!-- TODO_CONTINUATION -->";
const TOAST_DURATION_MS = 900;
const ABORT_WINDOW_MS = 3_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const FAILURE_RESET_WINDOW_MS = 5 * 60_000;

/** Render the remaining todo items as a markdown list ("- [status] content"). */
function renderTodoList(todos: TodoItem[]): string {
  const remaining = todos.filter((todo) => !COMPLETED_STATUSES.has(todo.status));
  if (remaining.length === 0) return "- (none)";
  return remaining.map((todo) => `- [${todo.status}] ${todo.content ?? ""}`).join("\n");
}

/** Resolve the session's agent from the last user message, if available. */
async function resolveSessionAgent(ctx: TodoReminderContext, sessionID: string): Promise<string | undefined> {
  try {
    const messages = await ctx.client.session.messages(sessionID);
    if (!messages || messages.length === 0) return undefined;
    const last = messages.at(-1);
    const agent = last?.info?.agent;
    return typeof agent === "string" && agent.length > 0 ? agent : undefined;
  } catch {
    return undefined;
  }
}

/** True when the last assistant message was aborted by the user (MessageAbortedError). */
async function lastAssistantMessageWasAborted(
  ctx: TodoReminderContext,
  sessionID: string,
): Promise<boolean> {
  try {
    const messages = await ctx.client.session.messages(sessionID);
    if (!messages || messages.length === 0) return false;
    const assistantMessages = messages.filter((message) => message.info?.role === "assistant");
    if (assistantMessages.length === 0) return false;
    const last = assistantMessages.at(-1);
    const error = last?.info?.error;
    if (!error || typeof error !== "object") return false;
    const name = (error as Record<string, unknown>).name;
    return name === "MessageAbortedError" || name === "AbortError";
  } catch {
    return false;
  }
}

/** True when the last message is real user input (not an injected continuation). */
function lastMessageIsUserInput(
  messages: Array<{
    info?: Record<string, unknown>;
    parts?: Array<{ type?: string; text?: string; metadata?: Record<string, unknown> }>;
  }>,
): boolean {
  if (messages.length === 0) return false;
  const last = messages.at(-1);
  if (!last) return false;
  // 防御：消息可能缺 info，缺了就视为非用户输入（不挡续作）。
  const role = last.info?.role;
  if (role !== "user") return false;
  const hasMarker = (last.parts ?? []).some(
    (part) =>
      part.type === "text" &&
      typeof part.text === "string" &&
      part.text.includes(CONTINUATION_MARKER),
  );
  return !hasMarker;
}

export function createTodoReminder(ctx: TodoReminderContext): (input: EventInput) => Promise<void> {
  const loadConfigFn = ctx.loadConfigOverride ?? loadConfig;
  const stateStore: SessionStateStore = createSessionStateStore();
  /** Per-session injection counter; reset when todos make progress. */
  const injectionCounts = new Map<string, number>();

  const showCountdownToast = async (
    seconds: number,
    remainingCount: number,
    cfg: ToolkitConfig,
  ): Promise<void> => {
    const lang = resolveLang(cfg.lang, process.env);
    const t = createTranslator(lang);
    const message = t("todoReminder.countdown")
      .replace("{seconds}", String(seconds))
      .replace("{remaining}", String(remainingCount));
    try {
      await ctx.client.tui.showToast({
        title: t("todoReminder.title"),
        message,
        variant: "warning",
        duration: TOAST_DURATION_MS,
      });
    } catch {
      // fail-soft: toast is cosmetic
    }
  };

  const startCountdown = (
    sessionID: string,
    incompleteCount: number,
    _total: number,
    cfg: ToolkitConfig,
  ): void => {
    const state = stateStore.getState(sessionID);
    stateStore.cancelCountdown(sessionID);

    // Countdown toast ticks down from the configured seconds (e.g. 5 → 1).
    const totalSeconds = Math.max(1, cfg.todoReminder.countdownSeconds);
    let remaining = totalSeconds;
    void showCountdownToast(remaining, incompleteCount, cfg);

    state.countdownInterval = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        // 只停 toast 递减；注入 timer（countdownTimer）由 setTimeout 自然触发。
        // 不能用 cancelCountdown——它会 clearTimeout 掉注入 timer，造成竞态偶发不注入。
        clearInterval(state.countdownInterval);
        return;
      }
      void showCountdownToast(remaining, incompleteCount, cfg);
    }, 1000);

    state.countdownTimer = setTimeout(() => {
      stateStore.cancelCountdown(sessionID);
      void injectContinuation(sessionID, cfg);
    }, totalSeconds * 1000);
  };

  const injectContinuation = async (sessionID: string, cfg: ToolkitConfig): Promise<void> => {
    const state = stateStore.getState(sessionID);
    if (state.wasCancelled) return;
    if (state.inFlight) return;

    const todos = await ctx.client.session.todo(sessionID).catch(() => undefined);
    if (!todos) return;
    const incomplete = todos.filter((todo) => !COMPLETED_STATUSES.has(todo.status));
    if (incomplete.length === 0) return;

    const agent = await resolveSessionAgent(ctx, sessionID);
    const todoList = renderTodoList(todos);
    const text = `${cfg.todoReminder.message.replace("{todos}", todoList)}\n${CONTINUATION_MARKER}`;

    state.inFlight = true;
    try {
      await ctx.client.session.prompt(sessionID, {
        ...(agent ? { agent } : {}),
        parts: [{ type: "text", text, metadata: { todoReminder: true } }],
      });
      state.inFlight = false;
      state.lastInjectedAt = Date.now();
      state.consecutiveFailures = 0;
      injectionCounts.set(sessionID, (injectionCounts.get(sessionID) ?? 0) + 1);
    } catch {
      state.inFlight = false;
      state.lastInjectedAt = Date.now();
      state.consecutiveFailures = state.consecutiveFailures + 1;
    }
  };

  const handleSessionIdle = async (sessionID: string): Promise<void> => {
    const cfg = loadConfigFn();
    if (!cfg.enabled || !cfg.todoReminder.enabled) return;

    if (cfg.todoReminder.onlyMainSession) {
      const mainSessionID = getMainSessionID();
      if (mainSessionID && sessionID !== mainSessionID) return;
      if (subagentSessions.has(sessionID)) return;
    }

    // Plan mode: do not auto-continue while the agent is planning.
    const agent = await resolveSessionAgent(ctx, sessionID);
    if (agent === "plan") return;

    const state = stateStore.getState(sessionID);

    if (state.wasCancelled) return;
    if (state.tokenLimitDetected) return;

    if (state.abortDetectedAt) {
      const elapsed = Date.now() - state.abortDetectedAt;
      state.abortDetectedAt = undefined;
      if (elapsed < ABORT_WINDOW_MS) return;
    }

    if (await lastAssistantMessageWasAborted(ctx, sessionID)) return;

    const todos = await ctx.client.session.todo(sessionID).catch(() => undefined);
    if (!todos || todos.length === 0) {
      stateStore.resetState(sessionID);
      injectionCounts.delete(sessionID);
      return;
    }

    const incompleteCount = todos.filter((todo) => !COMPLETED_STATUSES.has(todo.status)).length;
    if (incompleteCount === 0) {
      // All current todos are done: do not remind, and do not leave a stale
      // "previously completed" flag that would block reminders for new todos.
      injectionCounts.delete(sessionID);
      state.lastIncompleteCount = 0;
      return;
    }

    // Todos made progress since the last idle: reset the injection budget.
    const prevIncomplete = state.lastIncompleteCount;
    if (prevIncomplete !== undefined && incompleteCount < prevIncomplete) {
      injectionCounts.set(sessionID, 0);
    }
    state.lastIncompleteCount = incompleteCount;

    if (state.inFlight) return;

    const messages = await ctx.client.session.messages(sessionID).catch(() => undefined);
    if (messages && messages.length > 0 && lastMessageIsUserInput(messages)) {
      return;
    }

    const injectedCount = injectionCounts.get(sessionID) ?? 0;
    if (injectedCount >= cfg.todoReminder.maxInjections) return;

    if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      const lastInjectedAt = state.lastInjectedAt ?? 0;
      if (Date.now() - lastInjectedAt >= FAILURE_RESET_WINDOW_MS) {
        state.consecutiveFailures = 0;
      } else {
        return;
      }
    }

    startCountdown(sessionID, incompleteCount, todos.length, cfg);
  };

  /** Reset transient flags and cancel any in-flight countdown when the session becomes active again. */
  const handleNonIdleEvent = (eventType: string, props: Record<string, unknown> | undefined): void => {
    if (eventType === "message.updated" || eventType === "message.part.updated" || eventType === "message.part.delta" || eventType === "tool.execute.before" || eventType === "tool.execute.after") {
      const sessionID = getSessionID(props);
      if (!sessionID) return;
      const state = stateStore.getExistingState(sessionID);
      if (state) {
        state.abortDetectedAt = undefined;
        state.wasCancelled = false;
        state.tokenLimitDetected = false;
      }
      stateStore.cancelCountdown(sessionID);
    }
  };

  return async (input: EventInput): Promise<void> => {
    const { event } = input;
    const props = event.properties as Record<string, unknown> | undefined;

    if (event.type === "session.error") {
      const sessionID = getSessionID(props);
      if (!sessionID) return;
      const state = stateStore.getState(sessionID);
      const error = props?.error;
      const errorName =
        typeof error === "object" && error !== null
          ? ((error as Record<string, unknown>).name as string | undefined)
          : undefined;
      if (errorName === "MessageAbortedError" || errorName === "AbortError") {
        state.wasCancelled = true;
        state.abortDetectedAt = Date.now();
        state.lastInjectedAt = undefined;
        state.consecutiveFailures = 0;
        stateStore.cancelCountdown(sessionID);
      } else if (isTokenLimitError(error)) {
        state.tokenLimitDetected = true;
        stateStore.cancelCountdown(sessionID);
      }
      return;
    }

    if (event.type === "session.idle") {
      const sessionID = getSessionID(props);
      if (!sessionID) return;
      await handleSessionIdle(sessionID);
      return;
    }

    if (event.type === "session.deleted") {
      const sessionID = getSessionID(props);
      if (sessionID) stateStore.cleanup(sessionID);
      return;
    }

    handleNonIdleEvent(event.type, props);
  };
}

function isTokenLimitError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.toLowerCase() : "";
  const message = typeof record.message === "string" ? record.message.toLowerCase() : "";
  if (name.includes("contextlengtherror") || name.includes("context_length_exceeded")) return true;
  const patterns = ["prompt is too long", "is too long", "token limit", "context length", "too many tokens"];
  return patterns.some((pattern) => message.includes(pattern));
}
