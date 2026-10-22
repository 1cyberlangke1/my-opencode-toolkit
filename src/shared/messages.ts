import type { Plugin } from "@opencode/plugin"

/**
 * 输入：插件上下文 + 会话 ID + 注入标记。
 * 输出：末条消息是否是真实用户输入（不是本插件注入的）。
 * 预期：读不到消息时返回 false——宁可尝试注入，也不因为读取失败而永久死锁。
 */
export async function lastMessageIsUserInput(
  ctx: Plugin.Context,
  sessionID: string,
  marker: string,
): Promise<boolean> {
  const messages = await ctx.session.context({ sessionID }).catch(() => undefined)
  const last = messages?.at(-1)
  if (last?.type !== "user") return false
  return last.metadata?.[marker] !== true
}
