import type { Message, Session } from "@opencode-ai/sdk";

import type { ToolkitConfig } from "../config/types";
import { loadConfig } from "../config/load";
import { resolveLang, type Translator, createTranslator } from "../i18n";
import {
  getEventToolName,
  getQuestionText,
  getSessionID,
} from "./event-properties";
import { buildSessionContent } from "./content";
import type { NotificationSender } from "./sender";
import { createNotificationSender } from "./sender";
import { getMainSessionID, setMainSession, subagentSessions } from "./session-state";

interface SessionNotificationContext {
  client: {
    session: {
      get(id: string): Promise<Session | undefined>;
      messages(id: string): Promise<Array<{ info: Message; parts: Array<{ type: string; text?: string }> }> | undefined>;
      todo(id: string): Promise<Array<{ status: string }> | undefined>;
    };
  };
  loadConfigOverride?: () => ToolkitConfig;
}

interface EventInput {
  event: { type: string; properties?: unknown };
}

const QUESTION_TOOLS = new Set(["question", "ask_user_question", "askuserquestion"]);
const PERMISSION_EVENTS = new Set([
  "permission.ask",
  "permission.asked",
  "permission.updated",
  "permission.requested",
]);
const PERMISSION_HINT_PATTERN = /\b(permission|approve|approval|allow|deny|consent)\b/i;

export function createSessionNotification(ctx: SessionNotificationContext) {
  const loadConfigFn = ctx.loadConfigOverride ?? loadConfig;

  const sender: NotificationSender = createNotificationSender(process.platform);

  const hasPendingWork = async (sessionID: string): Promise<boolean> => {
    try {
      const todos = await ctx.client.session.todo(sessionID);
      if (!todos || todos.length === 0) return false;
      return todos.some((todo) => todo.status !== "completed" && todo.status !== "cancelled");
    } catch {
      return false;
    }
  };

  const sendCompletion = async (sessionID: string): Promise<void> => {
    const cfg = loadConfigFn();
    const lang = resolveLang(cfg.lang, process.env);
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
  };

  const shouldNotifyForSession = (sessionID: string): boolean => {
    if (subagentSessions.has(sessionID)) return false;

    const cfg = loadConfigFn();
    if (cfg.notification.onlyMainSession) {
      const mainSessionID = getMainSessionID();
      if (mainSessionID && sessionID !== mainSessionID) return false;
    }

    return true;
  };

  return async (input: EventInput): Promise<void> => {
    const { event } = input;
    const props = event.properties as Record<string, unknown> | undefined;

    const cfg = loadConfigFn();
    if (!cfg.enabled) return;

    if (event.type === "session.created") {
      const sessionID = getSessionID(props);
      const info = props?.info as { parentID?: string } | undefined;
      const isSubagentSession = !!info?.parentID || (!!sessionID && subagentSessions.has(sessionID));
      if (!isSubagentSession) setMainSession(sessionID);
      return;
    }

    if (event.type === "session.idle") {
      const sessionID = getSessionID(props);
      if (!sessionID) return;

      const notifConfig = cfg.notification;
      if (!notifConfig.enabled || !notifConfig.onComplete) return;
      if (!shouldNotifyForSession(sessionID)) return;
      if (notifConfig.skipIfIncompleteTodos && (await hasPendingWork(sessionID))) return;

      await sendCompletion(sessionID);
      return;
    }

    if (PERMISSION_EVENTS.has(event.type)) {
      const sessionID = getSessionID(props);
      if (!sessionID) return;

      if (!cfg.notification.enabled || !cfg.notification.onPermission) return;
      if (!shouldNotifyForSession(sessionID)) return;

      const lang = resolveLang(cfg.lang, process.env);
      const t: Translator = createTranslator(lang);
      await sender.send({ title: t("notification.title"), message: t("notification.permission") });
      return;
    }

    if (event.type === "tool.execute.before" || event.type === "tool.execute.after") {
      const sessionID = getSessionID(props);
      if (sessionID && event.type === "tool.execute.before") {
        const toolName = getEventToolName(props)?.toLowerCase();
        if (toolName && QUESTION_TOOLS.has(toolName)) {
          if (!cfg.notification.enabled || !cfg.notification.onQuestion) return;
          if (!shouldNotifyForSession(sessionID)) return;

          const questionText = getQuestionText(props);
          const lang = resolveLang(cfg.lang, process.env);
          const t: Translator = createTranslator(lang);
          const message = PERMISSION_HINT_PATTERN.test(questionText)
            ? t("notification.permission")
            : t("notification.question");
          await sender.send({ title: t("notification.title"), message });
        }
      }
      return;
    }

    if (event.type === "session.deleted") {
      const sessionID = getSessionID(props);
      if (sessionID && sessionID === getMainSessionID()) setMainSession(undefined);
      return;
    }
  };
}
