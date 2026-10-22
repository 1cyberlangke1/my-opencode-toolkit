import type { Plugin } from "@opencode/plugin"

import { readEventData } from "../shared/events.ts"
import type { PluginEvent } from "../shared/events.ts"
import { asRecord, type JsonStore } from "../shared/json.ts"
import { lastMessageIsUserInput } from "../shared/messages.ts"
import { loadSettings } from "../shared/settings-store.ts"
import type { GoalController } from "./controller.ts"
import { classifyGoalFailure } from "./error.ts"
import { buildContinuationPrompt } from "./prompts.ts"
import type { SessionRoles } from "./session-role.ts"

/** 注入消息的 metadata 标记，用于识别“这条 user 消息是我们发的”。 */
const CONTINUATION_MARKER = "goalContinuation"

/** 会话运行期锁死标志。 */
type RunState = {
  /** 用户打断过，暂停后需显式 resume。 */
  wasCancelled: boolean
  /** 上下文超长，等下一次模型活动自动解除。 */
  tokenLimitDetected: boolean
  /** 余额不足，只有显式 resume 才解除。 */
  insufficientFundsDetected: boolean
}

/** 续作控制器。 */
export type GoalContinuation = {
  /** 输入：会话事件；输出：无。预期：按事件类型记账、续作或暂停。 */
  handle(event: PluginEvent): Promise<void>
  /** 输入：会话 ID；输出：无。预期：清除打断/超长/余额锁死与待确认注入。 */
  resetRunState(sessionID: string): void
}

/**
 * 输入：插件上下文、存储、目标控制器、可选时钟。
 * 输出：续作控制器。
 * 预期：只在 goal 处于 active 且未被锁死时注入续作；一次 idle 最多注入一条。
 */
export function createGoalContinuation(args: {
  readonly ctx: Plugin.Context
  readonly store: JsonStore
  readonly controller: GoalController
  readonly roles: SessionRoles
  readonly now?: () => number
}): GoalContinuation {
  const { ctx, store, controller, roles } = args
  const now = args.now ?? Date.now
  const runStates = new Map<string, RunState>()
  const pending = new Set<string>()
  const inFlight = new Set<string>()
  const lastAccountAt = new Map<string, number>()

  /** 输入：会话 ID；输出：可变的运行状态。预期：不存在时创建默认值。 */
  const stateOf = (sessionID: string): RunState => {
    const existing = runStates.get(sessionID)
    if (existing !== undefined) return existing
    const created: RunState = { wasCancelled: false, tokenLimitDetected: false, insufficientFundsDetected: false }
    runStates.set(sessionID, created)
    return created
  }

  /** 输入：会话 ID；输出：设置是否允许续作。预期：总开关或 goal 开关关闭时不续作。 */
  const enabled = async (): Promise<boolean> => {
    const settings = await loadSettings(store)
    return settings.enabled && settings.goal.enabled
  }

  /** 输入：会话 ID + token 增量；输出：无。预期：只对 active 目标记账。 */
  const account = async (sessionID: string, tokens: number): Promise<void> => {
    const at = now()
    const last = lastAccountAt.get(sessionID)
    const elapsedSeconds = last === undefined ? 0 : Math.max(0, Math.floor((at - last) / 1000))
    lastAccountAt.set(sessionID, at)
    if (tokens === 0 && elapsedSeconds === 0) return
    await controller.accountUsage(sessionID, { tokens, elapsedSeconds })
  }

  /** 输入：会话 ID + 文本；输出：无。预期：注入一条带标记的续作提示；并发或失败时静默跳过。 */
  const inject = async (sessionID: string, text: string): Promise<void> => {
    if (inFlight.has(sessionID)) return
    inFlight.add(sessionID)
    try {
      await ctx.session.prompt({ sessionID, text, delivery: "steer", metadata: { [CONTINUATION_MARKER]: true } })
      pending.add(sessionID)
    } catch {
      // 注入失败：下一轮 idle 再试，不阻塞其他会话
    } finally {
      inFlight.delete(sessionID)
    }
  }

  /**
   * 输入：会话 ID。
   * 输出：末条消息是否是真实用户输入。
   * 预期：委托共享 helper，读不到消息时返回 false。
   */
  const userInputPending = (sessionID: string): Promise<boolean> =>
    lastMessageIsUserInput(ctx, sessionID, CONTINUATION_MARKER)

  /** 输入：会话 ID；输出：无。预期：active 且未锁死、且不是子代理时注入续作。 */
  const handleIdle = async (sessionID: string): Promise<void> => {
    if (!(await enabled())) return
    // 子代理不续作：子代理的生命周期由主会话的工具调用驱动。
    if (await roles.isSubagent(sessionID)) return

    const state = stateOf(sessionID)
    if (state.wasCancelled || state.tokenLimitDetected || state.insufficientFundsDetected) return

    // 上一条续作注入后没有产生任何 step：说明模型没有接手，先跳过一次避免死循环。
    if (pending.has(sessionID)) {
      pending.delete(sessionID)
      return
    }

    const goal = await controller.getGoal(sessionID)
    if (goal?.status !== "active") return

    // 末条是真实用户输入（上一条续作还没被回复）时跳过，避免叠加。
    if (await userInputPending(sessionID)) return

    await inject(sessionID, buildContinuationPrompt(goal))
  }

  /** 输入：会话 ID + 错误载荷；输出：无。预期：余额不足/超长锁死，其余只记录。 */
  const handleFailure = async (sessionID: string, error: unknown): Promise<void> => {
    if (!(await enabled())) return

    const state = stateOf(sessionID)
    const kind = classifyGoalFailure(error)
    if (kind === "insufficient_funds") {
      state.insufficientFundsDetected = true
      await controller.pauseGoal(sessionID)
      return
    }
    if (kind === "token_limit") {
      state.tokenLimitDetected = true
    }
  }

  /** 输入：会话 ID + 打断原因；输出：无。预期：用户打断时暂停目标。 */
  const handleInterrupted = async (sessionID: string, reason: string): Promise<void> => {
    if (reason !== "user") return
    if (!(await enabled())) return
    const state = stateOf(sessionID)
    state.wasCancelled = true
    await controller.pauseGoal(sessionID)
  }

  /** 输入：任意值；输出：本步消耗的 token 总数。预期：输入、输出、缓存读写都计入。 */
  const readTokens = (raw: unknown): number => {
    const record = asRecord(raw)
    if (record === undefined) return 0
    const cache = asRecord(record["cache"]) ?? {}
    const parts = [record["input"], record["output"], cache["read"], cache["write"]]
    let total = 0
    for (const part of parts) {
      if (typeof part === "number" && Number.isFinite(part) && part > 0) total += part
    }
    return total
  }

  return {
    async handle(event) {
      const data = readEventData(event)
      if (data === undefined) return
      const sessionID = data["sessionID"]
      if (typeof sessionID !== "string" || sessionID.length === 0) return

      switch (event.type) {
        case "session.step.ended": {
          // 模型活动：解除打断/超长锁死，并记账。
          const state = stateOf(sessionID)
          state.wasCancelled = false
          state.tokenLimitDetected = false
          pending.delete(sessionID)
          if (!(await enabled())) return
          await account(sessionID, readTokens(data["tokens"]))
          return
        }
        case "session.idle":
          await handleIdle(sessionID)
          return
        case "session.execution.failed":
          await handleFailure(sessionID, data["error"])
          return
        case "session.execution.interrupted":
          await handleInterrupted(sessionID, typeof data["reason"] === "string" ? data["reason"] : "")
          return
        case "session.deleted":
          runStates.delete(sessionID)
          pending.delete(sessionID)
          inFlight.delete(sessionID)
          lastAccountAt.delete(sessionID)
          roles.forget(sessionID)
          return
        default:
          return
      }
    },

    resetRunState(sessionID) {
      const state = stateOf(sessionID)
      state.wasCancelled = false
      state.tokenLimitDetected = false
      state.insufficientFundsDetected = false
      pending.delete(sessionID)
    },
  }
}
