import { asRecord } from "./json.ts"

/** 插件事件的最小形状。 */
export type PluginEvent = {
  readonly type: string
  readonly data: unknown
}

/**
 * 输入：插件事件。
 * 输出：`data.sessionID`，没有则 `undefined`。
 * 预期：兼容 `sessionID` 字段缺失或类型错误；不抛异常。
 */
export function readEventSessionID(event: PluginEvent): string | undefined {
  const data = asRecord(event.data)
  const value = data?.["sessionID"]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * 输入：插件事件。
 * 输出：`data` 的对象视图，非对象时为 `undefined`。
 */
export function readEventData(event: PluginEvent): Record<string, unknown> | undefined {
  return asRecord(event.data)
}

/**
 * 输入：插件事件。
 * 输出：会话是否进入 idle。
 * 预期：兼容新的 `session.status`（`status.type === "idle"`）与旧的 `session.idle`；
 *       其他状态（busy/retry）返回 false。
 */
export function isIdleEvent(event: PluginEvent): boolean {
  // 2.1.x 的插件事件流只送 durable/server 事件；session.idle 是 ephemeral，
  // 实际到达的是 session.execution.succeeded。两者都视为一轮结束。
  if (event.type === "session.idle" || event.type === "session.execution.succeeded") return true
  if (event.type !== "session.status") return false
  const status = asRecord(readEventData(event)?.["status"])
  return status?.["type"] === "idle"
}

/** 事件处理函数。 */
export type EventHandler = (event: PluginEvent) => Promise<void>

/**
 * 输入：处理函数列表 + 事件。
 * 输出：无。
 * 预期：按顺序调用；单个 handler 抛错被吞掉，不影响其他 handler 与后续事件。
 */
export async function dispatchEvent(handlers: readonly EventHandler[], event: PluginEvent): Promise<void> {
  for (const handler of handlers) {
    try {
      await handler(event)
    } catch {
      // 单个 handler 失败不能影响其他 handler 与后续事件
    }
  }
}
