import type { JsonStore } from "../shared/json.ts"
import { clearGoal, createGoal, nowSeconds, readGoal, setGoalStatus, withGoalLock, writeGoal } from "./store.ts"
import type { Goal } from "./types.ts"

/** 一次记账的增量。 */
export type GoalUsage = {
  readonly tokens: number
  /** 完整提示词增量；旧调用方不传时只更新总量。 */
  readonly input?: number
  /** 输出增量（含 reasoning）。 */
  readonly output?: number
  /** 缓存读取增量。 */
  readonly cached?: number
  readonly elapsedSeconds: number
}

/** 目标控制器：所有方法异步，读写都经过插件存储。 */
export type GoalController = {
  setGoal(sessionID: string, objective: string, tokenBudget?: number): Promise<Goal>
  getGoal(sessionID: string): Promise<Goal | null>
  pauseGoal(sessionID: string): Promise<Goal | null>
  resumeGoal(sessionID: string): Promise<Goal | null>
  clearGoal(sessionID: string): Promise<boolean>
  markComplete(sessionID: string): Promise<Goal | null>
  markBlocked(sessionID: string, reason: string): Promise<Goal | null>
  accountUsage(sessionID: string, usage: GoalUsage): Promise<Goal | null>
}

/**
 * 输入：插件存储。
 * 输出：目标控制器。
 * 预期：所有状态转换都落盘；不合法转换返回 `null` 或原目标，不抛异常。
 */
export function createGoalController(store: JsonStore): GoalController {
  const controller: GoalController = {
    async setGoal(sessionID, objective, tokenBudget) {
      await clearGoal(store, sessionID)
      const goal = await createGoal(store, sessionID, objective)
      // 非法预算（0/负数/NaN）当作没设置，避免第一次记账就直接 budget_limited。
      const budget =
        tokenBudget !== undefined && Number.isFinite(tokenBudget) && tokenBudget > 0 ? tokenBudget : undefined
      if (budget === undefined) return goal
      const withBudget: Goal = { ...goal, tokenBudget: budget }
      await writeGoal(store, withBudget)
      return withBudget
    },

    getGoal(sessionID) {
      return readGoal(store, sessionID)
    },

    async pauseGoal(sessionID) {
      // 只允许 active → paused：已 complete/blocked/budget_limited 的目标不覆写。
      const existing = await readGoal(store, sessionID)
      if (existing?.status !== "active") return null
      return setGoalStatus(store, sessionID, "paused")
    },

    async resumeGoal(sessionID) {
      const existing = await readGoal(store, sessionID)
      if (existing === null) return null
      if (existing.status === "active") return existing
      return setGoalStatus(store, sessionID, "active")
    },

    clearGoal(sessionID) {
      return clearGoal(store, sessionID)
    },

    markComplete(sessionID) {
      return setGoalStatus(store, sessionID, "complete")
    },

    async markBlocked(sessionID, reason) {
      const existing = await readGoal(store, sessionID)
      if (existing === null) return null
      // 只有 active 目标能被标记阻塞；paused/complete/blocked/budget_limited 原样返回。
      // 模型调 update_goal status="blocked" 是显式决定，一次就静默；
      // 什么时候该报 blocked 由提示词里的规则约束（同一阻塞重复出现时），控制器不做二次判定。
      if (existing.status !== "active") return existing

      const updated: Goal = {
        ...existing,
        status: "blocked",
        lastBlockedReason: reason,
        updatedAt: nowSeconds(),
      }
      await writeGoal(store, updated)
      return updated
    },

    async accountUsage(sessionID, usage) {
      const goal = await readGoal(store, sessionID)
      if (goal?.status !== "active") return goal

      const delta = (value: number | undefined): number =>
        value !== undefined && Number.isFinite(value) ? Math.max(0, value) : 0
      const tokenDelta = delta(usage.tokens)
      const timeDelta = delta(usage.elapsedSeconds)
      if (tokenDelta === 0 && timeDelta === 0) return goal

      const nextTokens = goal.tokensUsed + tokenDelta
      const hasBreakdown = usage.input !== undefined || usage.output !== undefined || usage.cached !== undefined
      const budgetReached = goal.tokenBudget !== undefined && nextTokens >= goal.tokenBudget
      const updated: Goal = {
        ...goal,
        tokensUsed: nextTokens,
        timeUsedSeconds: goal.timeUsedSeconds + timeDelta,
        updatedAt: nowSeconds(),
        ...(hasBreakdown
          ? {
              inputTokens: (goal.inputTokens ?? 0) + delta(usage.input),
              outputTokens: (goal.outputTokens ?? 0) + delta(usage.output),
              cachedTokens: (goal.cachedTokens ?? 0) + delta(usage.cached),
            }
          : {}),
        ...(budgetReached ? { status: "budget_limited" as const } : {}),
      }
      await writeGoal(store, updated)
      return updated
    },
  }

  /**
   * 所有写路径都过同一把会话级锁：`step.ended` 记账与 `/goal pause|complete` 是并发的读改写，
   * 不串行就会出现「暂停后又被记账覆盖回 active」。
   */
  return {
    ...controller,
    setGoal: (sessionID, objective, tokenBudget) =>
      withGoalLock(sessionID, () => controller.setGoal(sessionID, objective, tokenBudget)),
    pauseGoal: (sessionID) => withGoalLock(sessionID, () => controller.pauseGoal(sessionID)),
    resumeGoal: (sessionID) => withGoalLock(sessionID, () => controller.resumeGoal(sessionID)),
    clearGoal: (sessionID) => withGoalLock(sessionID, () => controller.clearGoal(sessionID)),
    markComplete: (sessionID) => withGoalLock(sessionID, () => controller.markComplete(sessionID)),
    markBlocked: (sessionID, reason) =>
      withGoalLock(sessionID, () => controller.markBlocked(sessionID, reason)),
    accountUsage: (sessionID, usage) =>
      withGoalLock(sessionID, () => controller.accountUsage(sessionID, usage)),
  }
}
