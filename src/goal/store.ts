import { randomUUID } from "node:crypto"

import type { JsonStore } from "../shared/json.ts"
import { goalKey } from "../shared/keys.ts"
import { globalSerialRegistry, runSerial } from "../shared/serial.ts"
import { parseGoal, type Goal, type GoalStatus } from "./types.ts"

/**
 * 输入：存储 + 会话 ID。
 * 输出：该会话的目标，没有或数据损坏时为 `null`。
 * 预期：只读，不创建 key。
 */
export async function readGoal(store: JsonStore, sessionID: string): Promise<Goal | null> {
  return parseGoal(await store.get(goalKey(sessionID)))
}

/**
 * 输入：存储 + 完整目标。
 * 输出：无。
 * 预期：整体覆盖写，key 由目标里的 sessionID 决定。
 */
export async function writeGoal(store: JsonStore, goal: Goal): Promise<void> {
  await store.set(goalKey(goal.sessionID), goal)
}

/**
 * 输入：存储 + 会话 ID。
 * 输出：原本是否存在目标。
 * 预期：删除 key；不存在时也返回 false 而不是抛错。
 */
export async function clearGoal(store: JsonStore, sessionID: string): Promise<boolean> {
  const existed = (await readGoal(store, sessionID)) !== null
  await store.remove(goalKey(sessionID))
  return existed
}

/**
 * 输入：存储 + 会话 ID + 目标描述。
 * 输出：新建的目标。
 * 预期：覆盖同会话的旧目标，计数从 0 开始，状态为 active。
 */
export async function createGoal(store: JsonStore, sessionID: string, objective: string): Promise<Goal> {
  const now = nowSeconds()
  const goal: Goal = {
    goalId: randomUUID(),
    sessionID,
    objective,
    status: "active",
    tokensUsed: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    timeUsedSeconds: 0,
    createdAt: now,
    updatedAt: now,
  }
  await writeGoal(store, goal)
  return goal
}

/**
 * 输入：存储 + 会话 ID + 状态。
 * 输出：更新后的目标，目标不存在时为 `null`。
 * 预期：只改状态与时间戳；进入 active 或 complete 时清掉阻塞记录。
 */
export async function setGoalStatus(
  store: JsonStore,
  sessionID: string,
  status: GoalStatus,
): Promise<Goal | null> {
  const existing = await readGoal(store, sessionID)
  if (existing === null) return null

  const clear = status === "active" || status === "complete"
  const updated: Goal = {
    goalId: existing.goalId,
    sessionID: existing.sessionID,
    objective: existing.objective,
    status,
    tokensUsed: existing.tokensUsed,
    timeUsedSeconds: existing.timeUsedSeconds,
    createdAt: existing.createdAt,
    updatedAt: nowSeconds(),
    ...(existing.tokenBudget === undefined ? {} : { tokenBudget: existing.tokenBudget }),
    ...(existing.inputTokens === undefined ? {} : { inputTokens: existing.inputTokens }),
    ...(existing.outputTokens === undefined ? {} : { outputTokens: existing.outputTokens }),
    ...(existing.cachedTokens === undefined ? {} : { cachedTokens: existing.cachedTokens }),
    ...(clear || existing.lastBlockedReason === undefined ? {} : { lastBlockedReason: existing.lastBlockedReason }),
    ...(clear || existing.blockedStreak === undefined ? {} : { blockedStreak: existing.blockedStreak }),
  }
  await writeGoal(store, updated)
  return updated
}

/** 输入：无；输出：当前 Unix 秒。预期：整秒，便于存储与展示。 */
export function nowSeconds(): number {
  return Math.trunc(Date.now() / 1000)
}

/** goal 存档的进程级串行队列：记账与状态切换必须排队，否则后写的会把先写的状态冲掉。 */
const goalChains = globalSerialRegistry(Symbol.for("my-opencode-toolkit.goal-chains"))

/** 输入：会话 ID + 读改写函数；输出：该函数的结果。预期：同一会话的 goal 写操作串行执行。 */
export function withGoalLock<T>(sessionID: string, task: () => Promise<T>): Promise<T> {
  return runSerial(goalChains, sessionID, task)
}
