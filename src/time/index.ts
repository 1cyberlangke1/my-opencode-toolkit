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
  /** 输入：插件事件；输出：无。预期：只在 step.ended 计数，满 N 步注入一次。 */
  handle(event: PluginEvent): Promise<void>
  /** 输入：会话 ID；输出：无。预期：会话删除后清掉计数。 */
  forget(sessionID: string): void
  /** 输入：无；输出：无。预期：卸载时清空全部计数。 */
  dispose(): void
}

/**
 * 输入：插件上下文 + 会话角色 + 设置快照读取器。
 * 输出：时间注入句柄。
 * 预期：每会话计 step.ended 次数，满 intervalSteps 注入一条合成时间消息（resume:false
 *       不触发新轮）后归零。守卫按序：插件总开关 → time.enabled → 归属（宁少勿重）→
 *       子代理跳过；plan 会话照常注入。设置每次注入时现读，TUI 改完即时生效。
 */
export function createTimePulse(
  ctx: Plugin.Context,
  roles: SessionRoles,
  readSettings: () => Promise<Pick<TimeSettings, "enabled" | "intervalSteps" | "format" | "timezone">>,
): TimeHandle {
  /** 输入：会话 ID；输出：当前计数。 */
  const counts = new Map<string, number>()

  const handle = async (event: PluginEvent): Promise<void> => {
    if (event.type !== "session.step.ended") return
    const sessionID = readEventSessionID(event)
    if (sessionID === undefined) return

    const settings = await readSettings()
    if (!settings.enabled) return
    // 归属判定放最前：别的实例的会话不计数，避免多实例对同一事件重复累加。
    if (!(await ownsSession(ctx, sessionID))) return
    if (await roles.isSubagent(sessionID)) return

    const next = (counts.get(sessionID) ?? 0) + 1
    if (next < settings.intervalSteps) {
      counts.set(sessionID, next)
      return
    }
    counts.delete(sessionID)
    const text = formatTimeSafe(new Date(), settings.format, settings.timezone)
    await ctx.session.synthetic({
      sessionID,
      text,
      description: text,
      delivery: "steer",
      resume: false,
      metadata: { timePulse: true },
    })
  }

  return {
    handle,
    forget(sessionID) {
      counts.delete(sessionID)
    },
    dispose() {
      counts.clear()
    },
  }
}
