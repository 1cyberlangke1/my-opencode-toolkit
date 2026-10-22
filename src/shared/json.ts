/**
 * 插件存储能接受的 JSON 值。
 *
 * 预期：只包含 JSON 原生类型，保证 `ctx.storage.set` 能直接落盘。
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

/**
 * 插件存储的最小接口。
 *
 * 输入：key 与 JSON 值。
 * 输出：读取返回 `unknown`（调用方负责校验），写入无返回。
 * 预期：与 `ctx.storage` 结构兼容，测试里可用内存实现替换。
 */
export type JsonStore = {
  get(key: string): Promise<unknown>
  set(key: string, value: JsonValue): Promise<void>
  remove(key: string): Promise<void>
}

/**
 * 输入：任意值。
 * 输出：普通对象则返回自身，否则 `undefined`。
 * 预期：用于把存储里读出的 `unknown` 收窄成可按 key 访问的记录；数组不算记录。
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}
