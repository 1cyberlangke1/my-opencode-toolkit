import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { buildWindowsToastScript, escapeAppleScriptText } from "./formatting";

const execFileAsync = promisify(execFile);

const POWERSHELL = "powershell.exe";
const OSASCRIPT = "osascript";
const NOTIFY_SEND = "notify-send";

export async function sendWindowsNotification(title: string, message: string): Promise<void> {
  const script = buildWindowsToastScript(title, message);
  await execFileAsync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: 10_000,
    windowsHide: true,
  });
}

export async function sendMacosNotification(title: string, message: string): Promise<void> {
  const script = `display notification "${escapeAppleScriptText(message)}" with title "${escapeAppleScriptText(title)}"`;
  await execFileAsync(OSASCRIPT, ["-e", script], {
    timeout: 10_000,
    windowsHide: true,
  });
}

export async function sendLinuxNotification(title: string, message: string): Promise<void> {
  await execFileAsync(NOTIFY_SEND, [title, message], {
    timeout: 10_000,
    windowsHide: true,
  });
}

export async function playWindowsSound(soundPath: string): Promise<void> {
  const escaped = soundPath.replace(/'/g, "''");
  const script = `(New-Object Media.SoundPlayer '${escaped}').PlaySync()`;
  await execFileAsync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: 10_000,
    windowsHide: true,
  });
}

