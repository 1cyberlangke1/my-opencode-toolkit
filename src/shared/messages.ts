import type { Plugin } from "@opencode/plugin"

/** 兼容 user 类型注入的标记；当前自动注入走 synthetic，不再依赖这些标记。 */
export const SYNTHETIC_MARKERS = ["goalContinuation", "cronContinuation", "loopContinuation"] as const

/**
 * 输入：一条消息。
 * 输出：是否是本插件注入的合成用户消息。
 * 预期：只看 `type === "user"` 且 metadata 里任一标记为 true；其他消息一律 false。
 *       通知预览据此跳过续作/定时注入，避免把系统提示当成用户原话。
 */
export function isSyntheticUserMessage(message: {
  readonly type: string
  readonly metadata?: Record<string, unknown>
}): boolean {
  if (message.type !== "user") return false
  return SYNTHETIC_MARKERS.some((marker) => message.metadata?.[marker] === true)
}

/**
 * 输入：插件上下文 + 会话 ID + 注入标记。
 * 输出：末条消息是否是真实用户输入（不是本插件注入的）。
 * 预期：读不到消息时返回 true——「读不到」和「确认不是用户」必须分开：
 *       前者宁可推迟一次注入，也不要插进用户正在输入的那一轮。
 */
export async function lastMessageIsUserInput(
  ctx: Plugin.Context,
  sessionID: string,
  marker: string,
): Promise<boolean> {
  const messages = await ctx.session.context({ sessionID }).catch(() => undefined)
  if (messages === undefined) return true
  const last = messages.at(-1)
  if (last?.type !== "user") return false
  return last.metadata?.[marker] !== true
}
