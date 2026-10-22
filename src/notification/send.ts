import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { buildWindowsToastScript, escapeAppleScriptText } from "./format.ts"

const execFileAsync = promisify(execFile)

const POWERSHELL = "powershell.exe"
const OSASCRIPT = "osascript"
const NOTIFY_SEND = "notify-send"

/** Windows toast 对长度敏感，统一截断。 */
const TITLE_MAX = 100
const MESSAGE_MAX = 800

/** 发送函数。 */
export type NotificationSender = (title: string, message: string) => Promise<void>

/** 输入：文本 + 上限；输出：截断后的文本。 */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text
}

/**
 * 输入：命令名 + 该命令能快速成功退出的探测参数。
 * 输出：可用时返回命令名，否则 `null`。
 * 预期：结果缓存；探测超时 3 秒，不阻塞通知链路。
 *       探测参数必须按命令区分：把 PowerShell 的 `-Command` 传给 osascript/notify-send 会必然失败，
 *       导致这两个平台的命令被误判为不存在。
 */
function createCommandFinder(commandName: string, probeArgs: readonly string[]): () => Promise<string | null> {
  let cached: string | null | undefined
  let pending: Promise<string | null> | undefined

  return async () => {
    if (cached !== undefined) return cached
    if (pending !== undefined) return pending

    pending = (async () => {
      try {
        await execFileAsync(commandName, [...probeArgs], {
          timeout: 3_000,
          windowsHide: true,
        })
        cached = commandName
      } catch {
        cached = null
      }
      return cached
    })()
    return pending
  }
}

const findPowerShell = createCommandFinder(POWERSHELL, ["-NoProfile", "-Command", "exit 0"])
const findOsascript = createCommandFinder(OSASCRIPT, ["-e", "return"])
const findNotifySend = createCommandFinder(NOTIFY_SEND, ["--help"])

/** 输入：命令 + 参数；输出：无。预期：静默执行，失败由调用方忽略。 */
async function runQuiet(command: string, args: readonly string[]): Promise<void> {
  await execFileAsync(command, [...args], { timeout: 10_000, windowsHide: true })
}

/** 输入：标题 + 正文；输出：无。预期：没有 powershell 时静默跳过。 */
async function sendWindows(title: string, message: string): Promise<void> {
  const path = await findPowerShell()
  if (path === null) return
  const script = buildWindowsToastScript(truncate(title, TITLE_MAX), truncate(message, MESSAGE_MAX))
  await runQuiet(path, ["-NoProfile", "-NonInteractive", "-Command", script])
}

/** 输入：标题 + 正文；输出：无。预期：没有 osascript 时静默跳过。 */
async function sendMacos(title: string, message: string): Promise<void> {
  const path = await findOsascript()
  if (path === null) return
  const safeTitle = escapeAppleScriptText(truncate(title, TITLE_MAX))
  const safeMessage = escapeAppleScriptText(truncate(message, MESSAGE_MAX))
  await runQuiet(path, ["-e", `display notification "${safeMessage}" with title "${safeTitle}"`])
}

/** 输入：标题 + 正文；输出：无。预期：没有 notify-send 时静默跳过。 */
async function sendLinux(title: string, message: string): Promise<void> {
  const path = await findNotifySend()
  if (path === null) return
  await runQuiet(path, [truncate(title, TITLE_MAX), truncate(message, MESSAGE_MAX)])
}

/**
 * 输入：Node 平台字符串。
 * 输出：该平台的发送函数。
 * 预期：不支持的平台返回空实现，绝不抛错。
 */
export function createSender(platform: NodeJS.Platform): NotificationSender {
  switch (platform) {
    case "win32":
      return sendWindows
    case "darwin":
      return sendMacos
    case "linux":
      return sendLinux
    default:
      return () => Promise.resolve()
  }
}
