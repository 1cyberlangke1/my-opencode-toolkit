import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { buildWindowsToastScript, escapeAppleScriptText } from "./formatting";

const execFileAsync = promisify(execFile);

const POWERSHELL = "powershell.exe";
const OSASCRIPT = "osascript";
const NOTIFY_SEND = "notify-send";

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

  const script = buildWindowsToastScript(title, message);
  await runQuiet(powershellPath, ["-NoProfile", "-NonInteractive", "-Command", script]);
}

export async function sendMacosNotification(title: string, message: string): Promise<void> {
  const osascriptPath = await getOsascriptPath();
  if (!osascriptPath) return;

  const script = `display notification "${escapeAppleScriptText(message)}" with title "${escapeAppleScriptText(title)}"`;
  await runQuiet(osascriptPath, ["-e", script]);
}

export async function sendLinuxNotification(title: string, message: string): Promise<void> {
  const notifySendPath = await getNotifySendPath();
  if (!notifySendPath) return;

  await runQuiet(notifySendPath, [title, message]);
}
