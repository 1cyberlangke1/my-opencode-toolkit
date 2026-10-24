import type { JsonStore } from "./shared/json.ts"
import { asRecord } from "./shared/json.ts"
import { statsKey } from "./shared/keys.ts"
import type { SessionStats } from "./stats.ts"

/**
 * 输入：任意值。
 * 输出：非负有限数，否则 0。
 * 预期：损坏值不抛错，按 0 处理。
 */
function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * 输入：storage 读出的任意值。
 * 输出：合法统计；形状不对时为 `null`（调用方回退到空统计）。
 * 预期：绝不抛错。
 */
export function parseStoredStats(value: unknown): SessionStats | null {
  const record = asRecord(value)
  if (record === undefined) return null
  if (record["steps"] === undefined || record["input"] === undefined) return null
  if (record["output"] === undefined || record["cached"] === undefined) return null
  if (record["tools"] === undefined) return null
  const tools: Record<string, number> = {}
  const rawTools = asRecord(record["tools"])
  if (rawTools === undefined) return null
  for (const [name, value] of Object.entries(rawTools)) {
    tools[name] = count(value)
  }
  return {
    steps: count(record["steps"]),
    input: count(record["input"]),
    output: count(record["output"]),
    cached: count(record["cached"]),
    ...(typeof record["lastTool"] === "string" && record["lastTool"].length > 0
      ? { lastTool: record["lastTool"] }
      : {}),
    tools,
  }
}

/**
 * 输入：存储 + 会话 ID。
 * 输出：该会话的累计统计；没有或损坏时为 `null`。
 * 预期：只读，不创建 key。
 */
export async function loadStats(store: JsonStore, sessionID: string): Promise<SessionStats | null> {
  return parseStoredStats(await store.get(statsKey(sessionID)))
}

/**
 * 输入：存储 + 会话 ID + 当前累计。
 * 输出：无。
 * 预期：整体覆盖写；每次累加后立刻调用，崩溃最多丢最后一步。
 */
export async function saveStats(store: JsonStore, sessionID: string, stats: SessionStats): Promise<void> {
  await store.set(statsKey(sessionID), {
    steps: stats.steps,
    input: stats.input,
    output: stats.output,
    cached: stats.cached,
    ...(stats.lastTool === undefined ? {} : { lastTool: stats.lastTool }),
    tools: { ...stats.tools },
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
