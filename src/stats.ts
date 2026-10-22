import { asRecord } from "./shared/json.ts"

/** 单个会话的进程内统计。 */
export type SessionStats = {
  readonly steps: number
  readonly input: number
  readonly output: number
  readonly cached: number
  readonly tools: Readonly<Record<string, number>>
  readonly subagents: number
}

/** 统计累加器。 */
export type StatsTracker = {
  /** 输入：会话 + 本步 token；输出：无。预期：input/output/缓存分别累加。 */
  recordStep(sessionID: string, tokens: unknown): void
  /** 输入：会话 + 工具名；输出：无。预期：按工具名计数。 */
  recordTool(sessionID: string, tool: string): void
  /** 输入：父会话；输出：无。预期：子代理数量 +1。 */
  recordSubagent(parentID: string): void
  /** 输入：会话；输出：统计快照。 */
  get(sessionID: string): SessionStats
  /** 输入：会话；输出：无。预期：删除该会话统计。 */
  forget(sessionID: string): void
  /** 输入：无；输出：无。预期：清空全部统计。 */
  clear(): void
}

type MutableStats = {
  steps: number
  input: number
  output: number
  cached: number
  tools: Record<string, number>
  subagents: number
}

/**
 * 输入：无。
 * 输出：内存统计累加器。
 * 预期：只统计当前进程生命周期；重启后从 0 开始。
 */
export function createStatsTracker(): StatsTracker {
  const sessions = new Map<string, MutableStats>()

  /** 输入：会话；输出：可写统计。预期：不存在时创建空统计。 */
  const of = (sessionID: string): MutableStats => {
    const existing = sessions.get(sessionID)
    if (existing !== undefined) return existing
    const created: MutableStats = { steps: 0, input: 0, output: 0, cached: 0, tools: {}, subagents: 0 }
    sessions.set(sessionID, created)
    return created
  }

  /** 输入：任意值；输出：非负有限数，否则 0。 */
  const count = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0

  return {
    recordStep(sessionID, tokens) {
      const record = asRecord(tokens)
      if (record === undefined) return
      const cache = asRecord(record["cache"]) ?? {}
      const stats = of(sessionID)
      stats.steps += 1
      stats.input += count(record["input"])
      stats.output += count(record["output"])
      stats.cached += count(cache["read"]) + count(cache["write"])
    },

    recordTool(sessionID, tool) {
      if (tool.length === 0) return
      const stats = of(sessionID)
      stats.tools[tool] = (stats.tools[tool] ?? 0) + 1
    },

    recordSubagent(parentID) {
      if (parentID.length === 0) return
      of(parentID).subagents += 1
    },

    get(sessionID) {
      const stats = sessions.get(sessionID)
      if (stats === undefined) {
        return { steps: 0, input: 0, output: 0, cached: 0, tools: {}, subagents: 0 }
      }
      return { ...stats, tools: { ...stats.tools } }
    },

    forget(sessionID) {
      sessions.delete(sessionID)
    },

    clear() {
      sessions.clear()
    },
  }
}

/**
 * 输入：统计累加器 + 会话事件。
 * 输出：无。
 * 预期：step 结束记 token，会话删除清统计，新建子代理给父会话 +1。
 */
export function trackEvent(
  tracker: StatsTracker,
  event: { readonly type: string; readonly data: unknown },
): void {
  const data = asRecord(event.data)
  if (data === undefined) return
  const sessionID = data["sessionID"]
  if (typeof sessionID !== "string" || sessionID.length === 0) return

  if (event.type === "session.step.ended") {
    tracker.recordStep(sessionID, data["tokens"])
    return
  }
  if (event.type === "session.deleted") {
    tracker.forget(sessionID)
    return
  }
  if (event.type === "session.created") {
    const parentID = data["parentID"]
    if (typeof parentID === "string" && parentID.length > 0) tracker.recordSubagent(parentID)
  }
}

/**
 * 输入：输入 token 与缓存 token。
 * 输出：缓存命中率百分比，向下截断到两位小数。
 * 预期：分母为 0 时返回 0；`100` 只代表真实全命中。
 */
export function hitRatePercent(input: number, cached: number): number {
  const total = input + cached
  if (total <= 0) return 0
  return Math.floor((cached / total) * 10_000) / 100
}
