import { asRecord } from "../shared/json.ts"

/** 目标状态。`budget_limited` 由记账触发，`blocked` 由连续阻塞触发。 */
export const GOAL_STATUS_VALUES = ["active", "paused", "blocked", "budget_limited", "complete"] as const

export type GoalStatus = (typeof GOAL_STATUS_VALUES)[number]

/** 一个会话的持久目标。 */
export type Goal = {
  readonly goalId: string
  readonly sessionID: string
  readonly objective: string
  readonly status: GoalStatus
  readonly tokenBudget?: number
  readonly tokensUsed: number
  /** 完整提示词累计：input + cache.read + cache.write。 */
  readonly inputTokens?: number
  /** 输出累计：output + reasoning。 */
  readonly outputTokens?: number
  /** 缓存读取累计。 */
  readonly cachedTokens?: number
  readonly timeUsedSeconds: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastBlockedReason?: string
  readonly blockedStreak?: number
}

/**
 * 输入：任意值。
 * 输出：是否为合法状态字符串。
 * 预期：只接受固定枚举，其余（含大小写变体）一律 false。
 */
export function isGoalStatus(value: unknown): value is GoalStatus {
  return typeof value === "string" && (GOAL_STATUS_VALUES as readonly string[]).includes(value)
}

/**
 * 输入：任意值（通常来自存储）。
 * 输出：合法目标，或 `null`。
 * 预期：缺字段、类型不对、状态非法都返回 `null`；可选字段只在类型正确时保留。
 */
export function parseGoal(value: unknown): Goal | null {
  const record = asRecord(value)
  if (record === undefined) return null

  const goalId = record["goalId"]
  const sessionID = record["sessionID"]
  const objective = record["objective"]
  const status = record["status"]
  const tokensUsed = record["tokensUsed"]
  const timeUsedSeconds = record["timeUsedSeconds"]
  const createdAt = record["createdAt"]
  const updatedAt = record["updatedAt"]

  if (typeof goalId !== "string" || goalId.length === 0) return null
  if (typeof sessionID !== "string" || sessionID.length === 0) return null
  if (typeof objective !== "string") return null
  if (!isGoalStatus(status)) return null
  if (typeof tokensUsed !== "number" || !Number.isFinite(tokensUsed)) return null
  if (typeof timeUsedSeconds !== "number" || !Number.isFinite(timeUsedSeconds)) return null
  if (typeof createdAt !== "number" || typeof updatedAt !== "number") return null

  const tokenBudget = record["tokenBudget"]
  const inputTokens = record["inputTokens"]
  const outputTokens = record["outputTokens"]
  const cachedTokens = record["cachedTokens"]
  const lastBlockedReason = record["lastBlockedReason"]
  const blockedStreak = record["blockedStreak"]

  return {
    goalId,
    sessionID,
    objective,
    status,
    tokensUsed,
    timeUsedSeconds,
    createdAt,
    updatedAt,
    ...(typeof tokenBudget === "number" && Number.isFinite(tokenBudget) ? { tokenBudget } : {}),
    ...(typeof inputTokens === "number" && Number.isFinite(inputTokens) ? { inputTokens } : {}),
    ...(typeof outputTokens === "number" && Number.isFinite(outputTokens) ? { outputTokens } : {}),
    ...(typeof cachedTokens === "number" && Number.isFinite(cachedTokens) ? { cachedTokens } : {}),
    ...(typeof lastBlockedReason === "string" ? { lastBlockedReason } : {}),
    ...(typeof blockedStreak === "number" && Number.isFinite(blockedStreak) ? { blockedStreak } : {}),
  }
}
