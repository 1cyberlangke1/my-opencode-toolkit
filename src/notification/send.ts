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

/** 命令探测超时；发送超时。 */
const PROBE_TIMEOUT_MS = 3_000
const SEND_TIMEOUT_MS = 10_000
/** 探测失败后的重试间隔：不能把一次失败当成永久不可用。 */
const FINDER_RETRY_MS = 60_000

/** 发送函数。 */
export type NotificationSender = (title: string, message: string) => Promise<void>

/**
 * 命令执行器。
 *
 * 输入：命令、参数、超时毫秒。
 * 输出：命令成功退出时 resolve。
 * 预期：默认实现走 `execFile`；测试可注入假实现，验证各平台的参数与转义。
 */
export type CommandRunner = (command: string, args: readonly string[], timeoutMs: number) => Promise<void>

const defaultRunner: CommandRunner = (command, args, timeoutMs) =>
  execFileAsync(command, [...args], { timeout: timeoutMs, windowsHide: true }).then(() => undefined)

import { truncate } from "../shared/format.ts"

/**
 * 输入：命令名 + 该命令能快速成功退出的探测参数 + 执行器。
 * 输出：可用时返回命令名，否则 `null`。
 * 预期：结果缓存；探测超时 3 秒，不阻塞通知链路。
 *       探测参数必须按命令区分：把 PowerShell 的 `-Command` 传给 osascript/notify-send 会必然失败，
 *       导致这两个平台的命令被误判为不存在。
 */
function createCommandFinder(
  commandName: string,
  probeArgs: readonly string[],
  runner: CommandRunner,
): () => Promise<string | null> {
  let cached: string | null | undefined
  let cachedAt = 0
  let pending: Promise<string | null> | undefined

  return async () => {
    // 成功永久缓存；失败只缓存一分钟，避免命令装好后整个进程都发不出通知。
    if (cached !== undefined && (cached !== null || Date.now() - cachedAt < FINDER_RETRY_MS)) return cached
    if (pending !== undefined) return pending

    pending = (async () => {
      try {
        await runner(commandName, probeArgs, PROBE_TIMEOUT_MS)
        cached = commandName
      } catch {
        cached = null
      } finally {
        cachedAt = Date.now()
        pending = undefined
      }
      return cached
    })()
    return pending
  }
}

/** 输入：执行器；输出：Windows toast 发送函数。 */
function windowsSender(runner: CommandRunner): NotificationSender {
  const find = createCommandFinder(POWERSHELL, ["-NoProfile", "-Command", "exit 0"], runner)
  return async (title, message) => {
    const path = await find()
    if (path === null) return
    const script = buildWindowsToastScript(truncate(title, TITLE_MAX), truncate(message, MESSAGE_MAX))
    await runner(path, ["-NoProfile", "-NonInteractive", "-Command", script], SEND_TIMEOUT_MS)
  }
}

/** 输入：执行器；输出：macOS 通知发送函数。 */
function macosSender(runner: CommandRunner): NotificationSender {
  const find = createCommandFinder(OSASCRIPT, ["-e", "return"], runner)
  return async (title, message) => {
    const path = await find()
    if (path === null) return
    const safeTitle = escapeAppleScriptText(truncate(title, TITLE_MAX))
    const safeMessage = escapeAppleScriptText(truncate(message, MESSAGE_MAX))
    await runner(
      path,
      ["-e", `display notification "${safeMessage}" with title "${safeTitle}"`],
      SEND_TIMEOUT_MS,
    )
  }
}

/** 输入：执行器；输出：Linux 通知发送函数。 */
function linuxSender(runner: CommandRunner): NotificationSender {
  const find = createCommandFinder(NOTIFY_SEND, ["--help"], runner)
  return async (title, message) => {
    const path = await find()
    if (path === null) return
    await runner(path, [truncate(title, TITLE_MAX), truncate(message, MESSAGE_MAX)], SEND_TIMEOUT_MS)
  }
}

/**
 * 输入：Node 平台字符串 + 可选执行器。
 * 输出：该平台的发送函数。
 * 预期：不支持的平台返回空实现，绝不抛错；每个 sender 各自缓存命令探测结果。
 */
export function createSender(
  platform: NodeJS.Platform,
  runner: CommandRunner = defaultRunner,
): NotificationSender {
  switch (platform) {
    case "win32":
      return windowsSender(runner)
    case "darwin":
      return macosSender(runner)
    case "linux":
      return linuxSender(runner)
    default:
      return () => Promise.resolve()
  }
}
