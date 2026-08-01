import type { Session } from "@opencode-ai/sdk";

import type { Translator } from "../i18n";
import type { NotificationContent } from "./sender";

interface MessageInfo {
  role: "user" | "assistant";
  error?: unknown;
}

interface MessageEntry {
  info: MessageInfo;
  parts: Array<{ type: string; text?: string }>;
}

function extractMessageText(message: MessageEntry | undefined): string {
  return (message?.parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => (part.text ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

function collapseWhitespace(text: string): string {
  return text
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

function getLastNonEmptyLine(text: string): string {
  const lines = text
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.at(-1) ?? "";
}

function findLastMessage(
  messages: MessageEntry[],
  role: "user" | "assistant",
): MessageEntry | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message === undefined) continue;
    if (message.info.role !== role) continue;
    if (role === "assistant" && message.info.error) continue;
    if (!extractMessageText(message)) continue;
    return message;
  }

  return undefined;
}

export interface SessionContentInput {
  session: Session | undefined;
  messages: MessageEntry[] | undefined;
}

/**
 * Build a rich notification from session state: title + last user message +
 * last assistant line. Falls back to plain base text when nothing is available.
 */
export function buildSessionContent(
  input: SessionContentInput,
  baseTitle: string,
  baseMessage: string,
  t: Translator,
): NotificationContent {
  const sessionTitle = input.session?.title.trim() ?? "";
  const lastUserText = collapseWhitespace(
    extractMessageText(findLastMessage(input.messages ?? [], "user")),
  );
  const lastAssistantLine = getLastNonEmptyLine(
    extractMessageText(findLastMessage(input.messages ?? [], "assistant")),
  );

  const detailLines = [
    lastUserText ? `${t("notification.user")}: ${lastUserText}` : "",
    lastAssistantLine ? `${t("notification.assistant")}: ${lastAssistantLine}` : "",
  ].filter(Boolean);

  return {
    title: sessionTitle ? `${baseTitle} · ${sessionTitle}` : baseTitle,
    message:
      detailLines.length > 0 ? [baseMessage, ...detailLines].join("\n") : baseMessage,
  };
}
