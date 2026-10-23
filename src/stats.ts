import type { Plugin } from "@opencode/plugin"

import type { PanelSubagent, PanelSubagentDetail } from "./shared/rpc.ts"
import { asRecord } from "./shared/json.ts"

/** 单个会话的进程内统计。 */
export type SessionStats = {
  readonly steps: number
  /** 总提示词 token：`input + cache.read + cache.write`。 */
  readonly input: number
  readonly output: number
  /** 缓存命中 token：只算 `cache.read`。 */
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
  /** 输入：会话；输出：是否已从 OpenCode 消息重建过。 */
  isSeeded(sessionID: string): boolean
  /** 输入：会话 + 重建结果；输出：无。预期：覆盖当前值并标记已 seed。 */
  seed(sessionID: string, stats: SessionStats): void
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
  seeded: boolean
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
    const created: MutableStats = { steps: 0, input: 0, output: 0, cached: 0, tools: {}, subagents: 0, seeded: false }
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
      // 分母是完整提示词；cache.write 是写入成本，不算命中。
      stats.input += count(record["input"]) + count(cache["read"]) + count(cache["write"])
      stats.output += count(record["output"]) + count(record["reasoning"])
      stats.cached += count(cache["read"])
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
      return {
        steps: stats.steps,
        input: stats.input,
        output: stats.output,
        cached: stats.cached,
        tools: { ...stats.tools },
        subagents: stats.subagents,
      }
    },

    isSeeded(sessionID) {
      return sessions.get(sessionID)?.seeded ?? false
    },

    seed(sessionID, stats) {
      sessions.set(sessionID, { ...stats, tools: { ...stats.tools }, seeded: true })
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
 * 输入：插件上下文 + 父会话 ID。
 * 输出：子会话列表；预期：按 parentID 过滤并逐页翻完，失败返回已收集部分。
 */
type SubagentSession = Awaited<ReturnType<Plugin.Context["session"]["list"]>>["data"][number]

async function collectSubagentSessions(ctx: Plugin.Context, sessionID: string): Promise<SubagentSession[]> {
  const result: SubagentSession[] = []
  let cursor: string | undefined
  // 翻页上限：防止异常服务端返回循环 cursor 时无限循环。
  for (let page = 0; page < 200; page += 1) {
    const listed = await ctx.session
      .list({ parentID: sessionID, ...(cursor === undefined ? {} : { cursor }) })
      .catch(() => undefined)
    if (listed === undefined) return result
    result.push(...listed.data)

    const next = listed.cursor.next
    if (next === undefined || next === null || next === cursor) return result
    cursor = next
  }
  return result
}

/**
 * 输入：插件上下文 + 父会话 ID。
 * 输出：该会话的子代理数量。
 * 预期：翻页读取失败时返回已统计的数量，不抛异常。
 */
async function countSubagents(ctx: Plugin.Context, sessionID: string): Promise<number> {
  return (await collectSubagentSessions(ctx, sessionID)).length
}

/**
 * 输入：插件上下文 + 父会话 ID。
 * 输出：按更新时间倒序的子代理摘要。
 * 预期：只返回列表所需字段，不读子会话消息；数量上限由调用方决定。
 */
export async function listSubagents(
  ctx: Plugin.Context,
  sessionID: string,
  limit = 20,
): Promise<readonly PanelSubagent[]> {
  const sessions = await collectSubagentSessions(ctx, sessionID)
  return sessions
    .map((session) => {
      const cache = session.tokens.cache
      return {
        id: session.id,
        title: session.title ?? session.id,
        ...(session.agent === undefined ? {} : { agent: session.agent }),
        ...(session.outcome === undefined ? {} : { outcome: session.outcome }),
        updatedAt: session.time.updated,
        input: session.tokens.input + cache.read + cache.write,
        output: session.tokens.output,
        cached: cache.read,
      }
    })
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, limit)
}

/**
 * 输入：插件上下文 + 子会话 ID。
 * 输出：子会话的 token/tool 详情。
 * 预期：复用 buildStats；读取失败由调用方处理。
 */
export async function buildSubagentDetail(
  ctx: Plugin.Context,
  sessionID: string,
): Promise<PanelSubagentDetail> {
  const stats = await buildStats(ctx, sessionID)
  return {
    steps: stats.steps,
    input: stats.input,
    output: stats.output,
    cached: stats.cached,
    hitRate: hitRatePercent(stats.input, stats.cached),
    tools: Object.entries(stats.tools)
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count),
  }
}

/**
 * 输入：插件上下文 + 会话 ID。
 * 输出：从 OpenCode 已存消息重建的统计。
 * 预期：只统计 assistant 消息的 tokens 与 tool 片段；子代理数来自会话列表的 parentID 过滤。
 *       读取失败按空统计处理，不抛异常。
 */
export async function buildStats(ctx: Plugin.Context, sessionID: string): Promise<SessionStats> {
  const messages = await ctx.session.context({ sessionID }).catch(() => [])
  let steps = 0
  let input = 0
  let output = 0
  let cached = 0
  const tools: Record<string, number> = {}

  for (const message of messages) {
    if (message.type !== "assistant") continue
    steps += 1
    const tokens = message.tokens
    if (tokens !== undefined) {
      // 与 recordStep 保持同一口径：input 是完整提示词，cached 只算读命中。
      input += tokens.input + tokens.cache.read + tokens.cache.write
      output += tokens.output + tokens.reasoning
      cached += tokens.cache.read
    }
    for (const part of message.content) {
      if (part.type !== "tool") continue
      tools[part.name] = (tools[part.name] ?? 0) + 1
    }
  }

  const subagents = await countSubagents(ctx, sessionID)
  return { steps, input, output, cached, tools, subagents }
}

/**
 * 输入：完整提示词 token（含缓存读写）与命中 token（`cache.read`）。
 * 输出：缓存命中率百分比，向下截断到两位小数。
 * 预期：分母为 0 时返回 0；结果夹在 0..100；`100` 只代表真实全命中。
 */
export function hitRatePercent(input: number, cached: number): number {
  if (input <= 0 || cached <= 0) return 0
  return Math.floor(Math.min(1, cached / input) * 10_000) / 100
}
