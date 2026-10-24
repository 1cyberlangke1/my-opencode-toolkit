import type { Plugin } from "@opencode/plugin"

/** 会话角色查询。 */
export type SessionRoles = {
  /** 输入：会话 ID；输出：是否子代理会话。预期：结果缓存，父会话 ID 不会变。 */
  isSubagent(sessionID: string): Promise<boolean>
  /** 输入：会话 ID；输出：无。预期：会话删除后清掉缓存。 */
  forget(sessionID: string): void
}

/**
 * 输入：插件上下文。
 * 输出：带缓存的会话角色查询。
 * 预期：查询失败时按子代理处理（fail-closed）：宁可少给一次工具，也不让子代理拿到主会话能力。
 *       失败不缓存，下次请求重新查。
 */
export function createSessionRoles(ctx: Plugin.Context): SessionRoles {
  const cache = new Map<string, boolean>()

  return {
    async isSubagent(sessionID) {
      const cached = cache.get(sessionID)
      if (cached !== undefined) return cached

      const session = await ctx.session.get({ sessionID }).catch(() => undefined)
      if (session === undefined) return true

      const parentID = session.parentID
      const value = typeof parentID === "string" && parentID.length > 0
      cache.set(sessionID, value)
      return value
    },

    forget(sessionID) {
      cache.delete(sessionID)
    },
  }
}
