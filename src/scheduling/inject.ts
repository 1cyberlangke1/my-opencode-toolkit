import type { Plugin } from "@opencode/plugin"

import type { SessionRoles } from "../goal/session-role.ts"
import { lastMessageIsUserInput } from "../shared/messages.ts"

/**
 * 一次注入的结果。
 *
 * - `sent`：真的调用了 synthetic，调用方可以按「已消费」处理；
 * - `skipped`：守卫挡住（会话忙 / 末条是用户输入 / 子代理 / 抛错），调用方应顺延重试；
 * - `claim-lost`：同一次触发已被别的实例认领，调用方必须放弃本次触发、不能顺延，
 *   否则顺延会改掉 nextRunAt，生成新的消息 ID 后在 60 秒后二次注入。
 */
export type InjectOutcome = "sent" | "skipped" | "claim-lost"

/** synthetic 注入器：守卫只有一份，cron 额外用 claim/release 保证同一次触发只投一次。 */
export type SyntheticInjector = {
  readonly inject: (sessionID: string, text: string, id?: string) => Promise<InjectOutcome>
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

  const inject = async (sessionID: string, text: string, id?: string): Promise<InjectOutcome> => {
    if (inFlight.has(sessionID) || pending.has(sessionID)) return "skipped"
    if (await input.roles.isSubagent(sessionID)) return "skipped"
    if (await lastMessageIsUserInput(input.ctx, sessionID, input.marker)) return "skipped"
    if (input.claim !== undefined && id !== undefined && !input.claim(id, sessionID)) return "claim-lost"
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
      return "sent"
    } catch {
      if (input.release !== undefined && id !== undefined) input.release(id)
      return "skipped"
    } finally {
      inFlight.delete(sessionID)
    }
  }

  return { inject, pending, inFlight }
}
