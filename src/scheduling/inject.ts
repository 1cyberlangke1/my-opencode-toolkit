import type { Plugin } from "@opencode/plugin"

import type { SessionRoles } from "../goal/session-role.ts"
import { lastMessageIsUserInput } from "../shared/messages.ts"

/**
 * synthetic 注入器。
 *
 * 输入：插件上下文 + 会话角色 + metadata 标记 + 可选的跨实例声明函数。
 * 输出：注入函数与两张运行态集合。
 * 预期：守卫（并发 / 上一条未完成 / 子代理 / 末条是用户输入）只有一份；
 *       cron 额外用 claim/release 保证同一次触发只让一个实例真正投递。
 *       `pending` 与 `inFlight` 暴露给调用方，供 idle / step 事件清理。
 */
export type SyntheticInjector = {
  readonly inject: (sessionID: string, text: string, id?: string) => Promise<boolean>
  /** 已注入但模型还没跑完的会话。 */
  readonly pending: Set<string>
  /** 正在调用 `session.synthetic` 的会话。 */
  readonly inFlight: Set<string>
}

export function createSyntheticInjector(input: {
  readonly ctx: Plugin.Context
  readonly roles: SessionRoles
  readonly marker: string
  readonly claim?: (id: string, sessionID: string) => boolean
  readonly release?: (id: string) => void
}): SyntheticInjector {
  const inFlight = new Set<string>()
  const pending = new Set<string>()

  const inject = async (sessionID: string, text: string, id?: string): Promise<boolean> => {
    if (inFlight.has(sessionID) || pending.has(sessionID)) return false
    if (await input.roles.isSubagent(sessionID)) return false
    if (await lastMessageIsUserInput(input.ctx, sessionID, input.marker)) return false
    if (input.claim !== undefined && id !== undefined && !input.claim(id, sessionID)) return false
    inFlight.add(sessionID)
    try {
      await input.ctx.session.synthetic({
        sessionID,
        ...(id === undefined ? {} : { id }),
        text,
        description: text,
        delivery: "steer",
        resume: true,
        metadata: { [input.marker]: true },
      })
      pending.add(sessionID)
      return true
    } catch {
      if (input.release !== undefined && id !== undefined) input.release(id)
      return false
    } finally {
      inFlight.delete(sessionID)
    }
  }

  return { inject, pending, inFlight }
}
