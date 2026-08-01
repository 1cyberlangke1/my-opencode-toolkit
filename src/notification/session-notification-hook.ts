import type { Message, Session } from "@opencode-ai/sdk";

import type { ToolkitConfig } from "../config/types";
import { loadConfig } from "../config/load";
import { resolveLang, type Translator, createTranslator } from "../i18n";
import { resolveMessageEventSessionID, resolveSessionEventID } from "./event-session-id";
import { buildSessionContent } from "./content";
import {
  createIdleNotificationScheduler,
  type IdleNotificationScheduler,
} from "./scheduler";
import type { NotificationSender } from "./sender";
import { createNotificationSender } from "./sender";

interface SessionIdleEvent {
  type: "session.idle";
  properties: {
    sessionID: string;
  };
}

function isSessionIdleEvent(event: { type: string; properties?: unknown }): event is SessionIdleEvent {
  return (
    event.type === "session.idle" &&
    typeof event.properties === "object" &&
    event.properties !== null &&
    typeof (event.properties as Record<string, unknown>).sessionID === "string"
  );
}

export interface SessionNotificationContext {
  client: {
    session: {
      get(id: string): Promise<Session | undefined>;
      messages(id: string): Promise<Array<{ info: Message; parts: Array<{ type: string; text?: string }> }> | undefined>;
      todo(id: string): Promise<Array<{ status: string }> | undefined>;
    };
  };
  loadConfigOverride?: () => ToolkitConfig;
}

export interface SessionNotificationHook {
  event(input: { event: { type: string; properties?: unknown } }): Promise<void>;
  dispose(): void;
}

const QUESTION_TOOLS = new Set(["question", "ask_user_question", "askuserquestion"]);
const PERMISSION_EVENTS = new Set(["permission.ask", "permission.asked", "permission.updated"]);

export function createSessionNotificationHook(
  ctx: SessionNotificationContext,
  platform: NodeJS.Platform,
): SessionNotificationHook {
  const loadConfigFn = ctx.loadConfigOverride ?? loadConfig;

  const sender: NotificationSender = createNotificationSender(platform);

  const hasPendingWork = async (sessionID: string): Promise<boolean> => {
    try {
      const todos = await ctx.client.session.todo(sessionID);
      if (!todos || todos.length === 0) return false;
      return todos.some((todo) => todo.status !== "completed" && todo.status !== "cancelled");
    } catch {
      return false;
    }
  };

  const scheduler: IdleNotificationScheduler = createIdleNotificationScheduler(
    {
      idleConfirmationDelay: 1500,
      skipIfIncompleteTodos: true,
      maxTrackedSessions: 100,
    },
    {
      hasPendingWork,
      send: async (sessionID) => {
        const config = loadConfigFn();
        const lang = resolveLang(config.lang, process.env);
        const t: Translator = createTranslator(lang);

        const [session, messages] = await Promise.all([
          ctx.client.session.get(sessionID).catch(() => undefined),
          ctx.client.session.messages(sessionID).catch(() => undefined),
        ]);

        const content = buildSessionContent(
          { session, messages },
          t("notification.title"),
          t("notification.completed"),
          t,
        );
        await sender.send(content);
      },
    },
  );

  return {
    async event({ event }): Promise<void> {
      const config = loadConfigFn();
      if (!config.enabled) return;

      switch (event.type) {
        case "session.created": {
          const sessionID = resolveSessionEventID(event.properties);
          if (sessionID) scheduler.markSessionActivity(sessionID);
          return;
        }
        case "session.idle": {
          if (!isSessionIdleEvent(event)) return;
          const sessionID = event.properties.sessionID;

          const notifConfig = config.notification;
          if (!notifConfig.enabled || !notifConfig.onComplete) return;
          if (notifConfig.onlyMainSession) {
            const session = await ctx.client.session.get(sessionID).catch(() => undefined);
            if (session?.parentID) return; // subagent session
          }

          scheduler.scheduleIdleNotification(sessionID);
          return;
        }
        case "message.updated":
        case "message.part.updated":
        case "message.part.delta": {
          const sessionID = resolveMessageEventSessionID(event.properties);
          if (sessionID) scheduler.markSessionActivity(sessionID);
          return;
        }
        case "permission.ask":
        case "permission.asked":
        case "permission.updated": {
          if (!PERMISSION_EVENTS.has(event.type)) return;
          if (!config.notification.enabled || !config.notification.onPermission) return;
          const sessionID = resolveSessionEventID(event.properties);
          if (!sessionID) return;
          if (config.notification.onlyMainSession) {
            const session = await ctx.client.session.get(sessionID).catch(() => undefined);
            if (session?.parentID) return;
          }
          scheduler.markSessionActivity(sessionID);
          const lang = resolveLang(config.lang, process.env);
          const t: Translator = createTranslator(lang);
          await sender.send({ title: t("notification.title"), message: t("notification.permission") });
          return;
        }
        case "tool.execute.before": {
          const sessionID = resolveSessionEventID(event.properties);
          if (sessionID) {
            scheduler.markSessionActivity(sessionID);
            const props = event.properties as Record<string, unknown> | undefined;
            const toolName =
              typeof props?.tool === "string" ? props.tool : typeof props?.name === "string" ? props.name : "";
            if (toolName && QUESTION_TOOLS.has(toolName.toLowerCase())) {
              if (!config.notification.enabled || !config.notification.onQuestion) return;
              const lang = resolveLang(config.lang, process.env);
              const t: Translator = createTranslator(lang);
              await sender.send({ title: t("notification.title"), message: t("notification.question") });
            }
          }
          return;
        }
        case "tool.execute.after": {
          const sessionID = resolveSessionEventID(event.properties);
          if (sessionID) scheduler.markSessionActivity(sessionID);
          return;
        }
        case "session.deleted": {
          const sessionID = resolveSessionEventID(event.properties);
          if (sessionID) scheduler.deleteSession(sessionID);
          return;
        }
        default:
          return;
      }
    },
    dispose(): void {
      scheduler.dispose();
    },
  };
}
