import { normalizeSessionStatusToIdle } from "./session-status-normalizer";

type EventInput = { event: { type: string; properties?: unknown } };

interface SessionNotificationContext {
  client: {
    session: {
      get(id: string): Promise<unknown>;
      messages(id: string): Promise<unknown>;
      todo(id: string): Promise<unknown>;
    };
  };
  loadConfigOverride?: () => import("../config/types").ToolkitConfig;
}

interface EventHandlerArgs {
  ctx: SessionNotificationContext;
  sessionNotification: ((input: EventInput) => Promise<void>) | null;
  todoReminder?: ((input: EventInput) => Promise<void>) | null;
  goal?: ((input: EventInput) => Promise<void>) | null;
  /** 返回 true 表示本次 idle 注入了一条续作（协调层据此跳过 todo）。 */
  scheduling?: ((input: EventInput) => Promise<boolean>) | null;
  hasActiveGoal?: (sessionID: string) => boolean;
}

export function createEventHandler(args: EventHandlerArgs): (input: EventInput) => Promise<void> {
  const { sessionNotification, todoReminder, goal, scheduling, hasActiveGoal } = args;

  const runEventHookSafely = async (
    handler: ((input: EventInput) => Promise<void>) | null,
    input: EventInput,
  ): Promise<void> => {
    if (!handler) return;
    try {
      await Promise.resolve(handler(input));
    } catch {
      // ignore hook errors (mirrors omo)
    }
  };

  const runSchedulingSafely = async (
    handler: ((input: EventInput) => Promise<boolean>) | null,
    input: EventInput,
  ): Promise<boolean> => {
    if (!handler) return false;
    try {
      return await Promise.resolve(handler(input));
    } catch {
      return false;
    }
  };

  // Dedupe the same idle edge: opencode emits both `session.status: idle`
  // (normalized here) and the native `session.idle` for the same idle, which
  // would otherwise fire notifications/continuations twice.
  const recentIdles = new Map<string, number>();
  const IDLE_DEDUPE_MS = 1_000;

  return async (input): Promise<void> => {
    const syntheticIdle = normalizeSessionStatusToIdle(input);
    const effective = syntheticIdle ?? input;

    if (effective.event.type === "session.idle") {
      const sessionID = getSessionIDFromProps(effective.event.properties);
      if (sessionID !== undefined) {
        const now = Date.now();
        const last = recentIdles.get(sessionID);
        if (last !== undefined && now - last < IDLE_DEDUPE_MS) {
          return;
        }
        recentIdles.set(sessionID, now);
        if (recentIdles.size > 100) {
          for (const [sid, at] of recentIdles) {
            if (now - at >= IDLE_DEDUPE_MS) recentIdles.delete(sid);
          }
        }
      }
    }

    await runEventHookSafely(sessionNotification, effective);
    await runEventHookSafely(goal ?? null, effective);

    const isIdle = effective.event.type === "session.idle";
    const sessionID = getSessionIDFromProps(effective.event.properties);

    // goal 优先：active goal 存在时 cron/todo 让路（只注入 goal 续作）。
    if (isIdle && sessionID !== undefined && hasActiveGoal?.(sessionID)) {
      return;
    }

    // 一个 idle 只注入一条：scheduling 注入了就跳过 todo。
    let schedulingInjected = false;
    if (scheduling) {
      schedulingInjected = await runSchedulingSafely(scheduling, effective);
    }
    if (isIdle && !schedulingInjected) {
      await runEventHookSafely(todoReminder ?? null, effective);
    }
  };
}

function getSessionIDFromProps(properties: unknown): string | undefined {
  if (typeof properties !== "object" || properties === null) return undefined;
  const props = properties as Record<string, unknown>;
  const sessionID = props.sessionID ?? props.sessionId;
  if (typeof sessionID === "string" && sessionID.length > 0) return sessionID;
  return undefined;
}
