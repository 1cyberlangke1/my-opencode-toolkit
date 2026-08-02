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
}

export function createEventHandler(args: EventHandlerArgs): (input: EventInput) => Promise<void> {
  const { sessionNotification, todoReminder } = args;

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
    if (syntheticIdle) {
      await runEventHookSafely(sessionNotification, syntheticIdle);
      await runEventHookSafely(todoReminder ?? null, syntheticIdle);
    } else {
      await runEventHookSafely(sessionNotification, input);
      await runEventHookSafely(todoReminder ?? null, input);
    }
  };
}
