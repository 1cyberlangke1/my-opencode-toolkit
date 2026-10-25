import type { Plugin } from "@opencode/plugin"

/**
 * 输入：插件上下文 + 会话 ID。
 * 输出：会话当前是否处于 Plan 模式。
 * 预期：查询失败时按「可能是 Plan」处理——宁可推迟一拍，也不把执行型注入塞进只读会话。
 *       Plan 是只读 agent，cron/loop 这类执行型注入在它下面只跳过，不排队。
 */
export async function isPlanSession(ctx: Plugin.Context, sessionID: string): Promise<boolean> {
  if (typeof ctx.session.get !== "function") return false
  const session = await ctx.session.get({ sessionID }).catch(() => undefined)
  if (session === undefined) return true
  return session.agent === "plan"
}
