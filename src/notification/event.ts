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
  hasActiveGoal?: (sessionID: string) => boolean;
}

export function createEventHandler(args: EventHandlerArgs): (input: EventInput) => Promise<void> {
  const { sessionNotification, todoReminder, goal, hasActiveGoal } = args;

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

  return async (input): Promise<void> => {
    const syntheticIdle = normalizeSessionStatusToIdle(input);
    const effective = syntheticIdle ?? input;

    await runEventHookSafely(sessionNotification, effective);
    await runEventHookSafely(goal ?? null, effective);

    const isIdle = effective.event.type === "session.idle";
    if (isIdle && hasActiveGoal) {
      const sessionID = getSessionIDFromProps(effective.event.properties);
      if (sessionID !== undefined && hasActiveGoal(sessionID)) {
        return;
      }
    }
    await runEventHookSafely(todoReminder ?? null, effective);
  };
}

function getSessionIDFromProps(properties: unknown): string | undefined {
  if (typeof properties !== "object" || properties === null) return undefined;
  const props = properties as Record<string, unknown>;
  const sessionID = props.sessionID ?? props.sessionId;
  if (typeof sessionID === "string" && sessionID.length > 0) return sessionID;
  return undefined;
}
