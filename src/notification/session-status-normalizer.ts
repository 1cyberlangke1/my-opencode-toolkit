import { resolveSessionEventID } from "./event-session-id";

type EventInput = { event: { type: string; properties?: unknown } };
type SessionStatus = { type: string };

export function normalizeSessionStatusToIdle(input: EventInput): EventInput | null {
  if (input.event.type !== "session.status") return null;

  const props = input.event.properties as Record<string, unknown> | undefined;
  if (!props) return null;

  const status = props.status as SessionStatus | undefined;
  if (!status || status.type !== "idle") return null;

  const sessionID = resolveSessionEventID(props);
  if (!sessionID) return null;

  return {
    event: {
      type: "session.idle",
      properties: { sessionID, synthetic: true },
    },
  };
}
