import type { JsonStore } from "./shared/json.ts"
import { asRecord } from "./shared/json.ts"
import { statsKey } from "./shared/keys.ts"
import type { SessionStats } from "./stats.ts"

/** 存储里的统计快照：多带一个最后记账的 assistant 消息 ID。 */
export type StoredStats = SessionStats & {
  /** 最后一次记账的 `assistantMessageID`；进程重启后用它挡住同一消息的事件重放。 */
  readonly lastMessageID?: string
}

/**
 * 输入：任意值。
 * 输出：非负有限数，否则 0。
 * 预期：存储值损坏时不抛错，按 0 处理。
 */
function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * 输入：storage 读出的任意值。
 * 输出：合法统计；形状不对或缺少必需字段时为 `null`。
 * 预期：损坏数据回退到"从消息重建"，绝不抛错。
 */
export function parseStoredStats(value: unknown): StoredStats | null {
  const record = asRecord(value)
  if (record === undefined) return null
  if (record["steps"] === undefined || record["input"] === undefined) return null
  if (record["output"] === undefined || record["cached"] === undefined) return null
  if (record["tools"] === undefined || record["subagents"] === undefined) return null

  const tools: Record<string, number> = {}
  const rawTools = asRecord(record["tools"])
  if (rawTools === undefined) return null
  for (const [name, count_] of Object.entries(rawTools)) {
    tools[name] = count(count_)
  }

  const rawMessageID = record["lastMessageID"]
  return {
    steps: count(record["steps"]),
    input: count(record["input"]),
    output: count(record["output"]),
    cached: count(record["cached"]),
    tools,
    subagents: count(record["subagents"]),
    ...(typeof rawMessageID === "string" && rawMessageID.length > 0 ? { lastMessageID: rawMessageID } : {}),
  }
}

/**
 * 输入：存储 + 会话 ID。
 * 输出：该会话持久化的统计，没有或损坏时为 `null`。
 * 预期：只读，不创建 key。
 */
export async function loadStats(store: JsonStore, sessionID: string): Promise<StoredStats | null> {
  return parseStoredStats(await store.get(statsKey(sessionID)))
}

/**
 * 输入：存储 + 会话 ID + 统计快照 + 最后记账的消息 ID。
 * 输出：无。
 * 预期：整体覆盖写；每次 step 结束后调用，崩溃最多丢最后一步。
 */
export async function saveStats(
  store: JsonStore,
  sessionID: string,
  stats: SessionStats,
  lastMessageID?: string,
): Promise<void> {
  await store.set(statsKey(sessionID), {
    steps: stats.steps,
    input: stats.input,
    output: stats.output,
    cached: stats.cached,
    tools: { ...stats.tools },
    subagents: stats.subagents,
    ...(lastMessageID === undefined ? {} : { lastMessageID }),
  })
}

/**
 * 输入：存储 + 会话 ID。
 * 输出：无。
 * 预期：删除 key；不存在时不抛错（幂等）。
 */
export async function removeStats(store: JsonStore, sessionID: string): Promise<void> {
  await store.remove(statsKey(sessionID))
}

/**
 * 输入：存档基数 + 未落盘增量。
 * 输出：合并后的新累计。
 * 预期：数值字段相加，工具计数按键相加；结果仍是合法 `SessionStats`。
 */
export function applyDelta(base: SessionStats, delta: SessionStats): SessionStats {
  const tools: Record<string, number> = { ...base.tools }
  for (const [name, count_] of Object.entries(delta.tools)) {
    tools[name] = (tools[name] ?? 0) + count_
  }
  return {
    steps: base.steps + delta.steps,
    input: base.input + delta.input,
    output: base.output + delta.output,
    cached: base.cached + delta.cached,
    tools,
    subagents: base.subagents + delta.subagents,
  }
}
