import type { JsonStore } from "../shared/json.ts"
import { clearGoal, createGoal, nowSeconds, readGoal, setGoalStatus, writeGoal } from "./store.ts"
import type { Goal } from "./types.ts"

/** 同一阻塞原因连续出现多少次才判定为 blocked。 */
export const BLOCKED_STREAK_REQUIRED = 3

/** 一次记账的增量。 */
export type GoalUsage = {
  readonly tokens: number
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
  return {
    async setGoal(sessionID, objective, tokenBudget) {
      await clearGoal(store, sessionID)
      const goal = await createGoal(store, sessionID, objective)
      if (tokenBudget === undefined) return goal
      const withBudget: Goal = { ...goal, tokenBudget }
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

      const sameReason = existing.lastBlockedReason === reason
      const streak = sameReason ? (existing.blockedStreak ?? 1) + 1 : 1
      const status = streak >= BLOCKED_STREAK_REQUIRED ? "blocked" : existing.status
      const updated: Goal = {
        ...existing,
        status,
        lastBlockedReason: reason,
        blockedStreak: streak,
        updatedAt: nowSeconds(),
      }
      await writeGoal(store, updated)
      return updated
    },

    async accountUsage(sessionID, usage) {
      const goal = await readGoal(store, sessionID)
      if (goal?.status !== "active") return goal

      const tokenDelta = Math.max(0, usage.tokens)
      const timeDelta = Math.max(0, usage.elapsedSeconds)
      if (tokenDelta === 0 && timeDelta === 0) return goal

      const nextTokens = goal.tokensUsed + tokenDelta
      const budgetReached = goal.tokenBudget !== undefined && nextTokens >= goal.tokenBudget
      const updated: Goal = {
        ...goal,
        tokensUsed: nextTokens,
        timeUsedSeconds: goal.timeUsedSeconds + timeDelta,
        updatedAt: nowSeconds(),
        ...(budgetReached ? { status: "budget_limited" as const } : {}),
      }
      await writeGoal(store, updated)
      return updated
    },
  }
}
