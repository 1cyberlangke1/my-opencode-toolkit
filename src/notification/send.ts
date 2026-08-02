import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { buildWindowsToastScript, escapeAppleScriptText } from "./formatting";

const execFileAsync = promisify(execFile);

const POWERSHELL = "powershell.exe";
const OSASCRIPT = "osascript";
const NOTIFY_SEND = "notify-send";

/** Fallback caps for platform notifications (Windows toast has strict size limits). */
const TITLE_MAX = 100;
const MESSAGE_MAX = 800;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function createCommandFinder(commandName: string): () => Promise<string | null> {
  let cachedPath: string | null = null;
  let pending: Promise<string | null> | null = null;

  return async () => {
    if (cachedPath !== null) return cachedPath;
    if (pending) return pending;

    pending = (async () => {
      try {
        await execFileAsync(commandName, ["-NoProfile", "-Command", "exit 0"], {
          timeout: 3_000,
          windowsHide: true,
        });
        cachedPath = commandName;
      } catch {
        cachedPath = null;
      }
      return cachedPath;
    })();

    return pending;
  };
}

const getPowershellPath = createCommandFinder(POWERSHELL);
const getOsascriptPath = createCommandFinder(OSASCRIPT);
const getNotifySendPath = createCommandFinder(NOTIFY_SEND);

async function runQuiet(command: string, args: readonly string[]): Promise<void> {
  await execFileAsync(command, [...args], { timeout: 10_000, windowsHide: true });
}

export async function sendWindowsNotification(title: string, message: string): Promise<void> {
  const powershellPath = await getPowershellPath();
  if (!powershellPath) return;

  const safeTitle = truncate(title, TITLE_MAX);
  const safeMessage = truncate(message, MESSAGE_MAX);
  const script = buildWindowsToastScript(safeTitle, safeMessage);
  await runQuiet(powershellPath, ["-NoProfile", "-NonInteractive", "-Command", script]);
}

export async function sendMacosNotification(title: string, message: string): Promise<void> {
  const osascriptPath = await getOsascriptPath();
  if (!osascriptPath) return;

  const safeTitle = truncate(title, TITLE_MAX);
  const safeMessage = truncate(message, MESSAGE_MAX);
  const script = `display notification "${escapeAppleScriptText(safeMessage)}" with title "${escapeAppleScriptText(safeTitle)}"`;
  await runQuiet(osascriptPath, ["-e", script]);
}

export async function sendLinuxNotification(title: string, message: string): Promise<void> {
  const notifySendPath = await getNotifySendPath();
  if (!notifySendPath) return;

  await runQuiet(notifySendPath, [truncate(title, TITLE_MAX), truncate(message, MESSAGE_MAX)]);
}
