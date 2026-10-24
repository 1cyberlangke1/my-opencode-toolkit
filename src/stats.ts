import type { Plugin } from "@opencode/plugin"

import type { PanelSubagent, PanelSubagentDetail } from "./shared/rpc.ts"

/** 单个会话的累计统计。展示时只读；统计累加时持有可变副本。 */
export type SessionStats = {
  steps: number
  /** 总提示词 token：`input + cache.read + cache.write`。 */
  input: number
  output: number
  /** 缓存命中 token：只算 `cache.read`。 */
  cached: number
  /** 最近一次被调用的工具名；没有记录时为 undefined。 */
  lastTool?: string
  tools: Record<string, number>
}

/**
 * 输入：插件上下文 + 父会话 ID + 需要的数量。
 * 输出：最新的子会话列表；预期：只取一页（默认按更新时间倒序），显式排除归档会话。
 *       不翻页：游标锚点是可变的 `time_updated`，翻页期间会话被更新会漏项。
 *       按 id 去重，避免服务端在边界上重复返回同一条。
 */
type SubagentSession = Awaited<ReturnType<Plugin.Context["session"]["list"]>>["data"][number]

async function collectSubagentSessions(
  ctx: Plugin.Context,
  sessionID: string,
  limit: number,
): Promise<SubagentSession[]> {
  const listed = await ctx.session
    .list({ parentID: sessionID, archived: false, order: "desc", limit })
    .catch(() => undefined)
  if (listed === undefined) return []

  const seen = new Set<string>()
  return listed.data.filter((session) => {
    if (seen.has(session.id)) return false
    seen.add(session.id)
    return true
  })
}

/**
 * 输入：插件上下文 + 父会话 ID。
 * 输出：按更新时间倒序的子代理摘要。
 * 预期：只返回列表所需字段，不读子会话消息；只取最新一页，数量上限由调用方决定。
 */
export async function listSubagents(
  ctx: Plugin.Context,
  sessionID: string,
  limit = 20,
): Promise<readonly PanelSubagent[]> {
  const sessions = await collectSubagentSessions(ctx, sessionID, limit)
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
        // 与详情口径一致：output 含 reasoning。
        output: session.tokens.output + session.tokens.reasoning,
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
 * 预期：只统计 assistant 消息的 tokens 与 tool 片段。
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
      // 与 readStepTokens 保持同一口径：input 是完整提示词，cached 只算读命中。
      input += tokens.input + tokens.cache.read + tokens.cache.write
      output += tokens.output + tokens.reasoning
      cached += tokens.cache.read
    }
    for (const part of message.content) {
      if (part.type !== "tool") continue
      tools[part.name] = (tools[part.name] ?? 0) + 1
    }
  }

  return { steps, input, output, cached, tools }
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
