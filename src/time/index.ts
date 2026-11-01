import type { Plugin } from "@opencode/plugin"

import type { SessionRoles } from "../goal/session-role.ts"
import { readEventSessionID, type PluginEvent } from "../shared/events.ts"
import { ownsSession } from "../shared/session.ts"
import type { TimeSettings } from "../shared/settings.ts"

/**
 * 输入：时间点 + 格式模板 + IANA 时区。
 * 输出：按模板渲染的时间串；时区非法时回落宿主时区。
 * 预期：token 映射 YYYY→年 MM→月 DD→日 HH→时 mm→分 ss→秒，其余字符原样保留；
 *       无效时区直接抛 RangeError，由调用方决定是否回落（本函数不吞）。
 */
export function formatTime(at: Date, format: string, timezone: string): string {
  const options: Intl.DateTimeFormatOptions =
    timezone.length > 0 ? { timeZone: timezone } : {}
  const parts = new Intl.DateTimeFormat("en-US", {
    ...options,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at)
  const lookup = new Map<string, string>()
  for (const part of parts) lookup.set(part.type, part.value)
  // 12 小时制下 hour 可能是 "24"（某些 ICU 的午夜），统一映射成 "00"。
  const hour = lookup.get("hour") === "24" ? "00" : (lookup.get("hour") ?? "")
  return format
    .replaceAll("YYYY", lookup.get("year") ?? "")
    .replaceAll("MM", lookup.get("month") ?? "")
    .replaceAll("DD", lookup.get("day") ?? "")
    .replaceAll("HH", hour)
    .replaceAll("mm", lookup.get("minute") ?? "")
    .replaceAll("ss", lookup.get("second") ?? "")
}

/**
 * 输入：时间点 + 格式模板 + IANA 时区。
 * 输出：格式化结果；非法时区回落宿主时区重试一次。
 * 预期：只有时区错误才回落；模板本身没有可失败的部分。
 */
export function formatTimeSafe(at: Date, format: string, timezone: string): string {
  if (timezone.length === 0) return formatTime(at, format, "")
  try {
    return formatTime(at, format, timezone)
  } catch {
    return formatTime(at, format, "")
  }
}

/** 校验 IANA 时区是否可用；空串视为宿主时区，返回 true。 */
export function isValidTimezone(timezone: string): boolean {
  if (timezone.length === 0) return true
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

/** 时间注入句柄。 */
export type TimeHandle = {
  /** 输入：插件事件；输出：无。预期：只在 step.ended 累加步数，绝不在步骤结束时注入。 */
  handle(event: PluginEvent): Promise<void>
  /** 输入：会话 ID；输出：无。预期：在轮次或步骤被触发启动时检查步数，达标则注入并清零。 */
  trigger(sessionID: string): Promise<void>
  /** 输入：会话 ID；输出：无。预期：会话删除后清掉计数。 */
  forget(sessionID: string): void
  /** 输入：无；输出：无。预期：卸载时清空全部计数。 */
  dispose(): void
}

/**
 * 输入：插件上下文 + 会话角色 + 设置快照读取器。
 * 输出：时间注入句柄。
 * 预期：每会话在 step.ended 累加步数；当有新交互触发（prompt 新提问或 tool.after 续跑）时，
 *       若累计满 intervalSteps 则注入一条合成时间消息并清零。
 *       不在步骤结束时硬塞时间，从物理机制上彻底杜绝幽灵空轮。
 */
export function createTimePulse(
  ctx: Plugin.Context,
  roles: SessionRoles,
  readSettings: () => Promise<Pick<TimeSettings, "enabled" | "intervalSteps" | "format" | "timezone">>,
): TimeHandle {
  /** 输入：会话 ID；输出：当前计数。 */
  const counts = new Map<string, number>()
  /** 刚刚完成时间注入的会话：注入带出的那一步本身不计入步数。 */
  const skipNextStep = new Set<string>()

  const handle = async (event: PluginEvent): Promise<void> => {
    if (event.type !== "session.step.ended") return
    const sessionID = readEventSessionID(event)
    if (sessionID === undefined) return

    // 别的实例的会话不计数，避免多实例对同一事件重复累加。
    if (!(await ownsSession(ctx, sessionID))) return
    if (await roles.isSubagent(sessionID)) return

    // 注入的那一轮/步本身不算步数
    if (skipNextStep.has(sessionID)) {
      skipNextStep.delete(sessionID)
      return
    }

    counts.set(sessionID, (counts.get(sessionID) ?? 0) + 1)
  }

  const trigger = async (sessionID: string): Promise<void> => {
    const currentCount = counts.get(sessionID) ?? 0
    if (currentCount === 0) return

    const settings = await readSettings()
    if (!settings.enabled) return
    if (currentCount < settings.intervalSteps) return
    if (!(await ownsSession(ctx, sessionID))) return
    if (await roles.isSubagent(sessionID)) return

    counts.delete(sessionID)
    // 标记：本次注入所触发的那一轮执行本身不算下次步数
    skipNextStep.add(sessionID)
    const timeStr = formatTimeSafe(new Date(), settings.format, settings.timezone)
    // 用方括号包裹时间串，形成不可误读的元数据锚点（与 [context-reminder] 同风格）。
    // 注入给模型的文本末尾带换行符，避免与随后进入的用户提问粘连成无间隔字符串；
    // TUI 的 description 同样带外壳，保持单行显示。
    const wrapped = `[${timeStr}]`
    const text = `${wrapped}\n`
    await ctx.session.synthetic({
      sessionID,
      text,
      description: wrapped,
      delivery: "steer",
      resume: false,
      metadata: { timePulse: true },
    })
  }

  return {
    handle,
    trigger,
    forget(sessionID) {
      counts.delete(sessionID)
      skipNextStep.delete(sessionID)
    },
    dispose() {
      counts.clear()
      skipNextStep.clear()
    },
  }
}
