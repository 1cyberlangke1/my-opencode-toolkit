import type { JsonValue, ScannableStore } from "../src/shared/json.ts"

/** 可手动触发并记录延迟的假 timer。 */
export type FakeTimer = {
  readonly delay: number
  unref(): void
  run(): void
}

/**
 * 输入：无。
 * 输出：假 timer 表 + 恢复函数。
 * 预期：只替换全局 setTimeout/clearTimeout，便于断言退避延迟与手动触发。
 */
export function captureTimers(): { timers: FakeTimer[]; restore(): void } {
  const timers: FakeTimer[] = []
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout

  const fakeSetTimeout = (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const timer: FakeTimer = {
      delay: ms ?? 0,
      unref: () => undefined,
      run: () => {
        callback(...args)
      },
    }
    timers.push(timer)
    return timer as unknown as ReturnType<typeof setTimeout>
  }
  const fakeClearTimeout = (timer?: ReturnType<typeof setTimeout>) => {
    const index = timers.indexOf(timer as unknown as FakeTimer)
    if (index >= 0) timers.splice(index, 1)
  }

  globalThis.setTimeout = fakeSetTimeout as unknown as typeof globalThis.setTimeout
  globalThis.clearTimeout = fakeClearTimeout as unknown as typeof globalThis.clearTimeout

  return {
    timers,
    restore() {
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
    },
  }
}

/**
 * 输入：无。
 * 输出：无。
 * 预期：让已排队的微任务链（存储读写、串行队列）跑完；不依赖真实定时器。
 */
export async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 32; index += 1) await Promise.resolve()
}

/** 内存存储：模拟 ctx.storage 的读写与分页扫描。 */
export class MemoryStore implements ScannableStore {
  readonly values = new Map<string, JsonValue>()

  get(key: string): Promise<unknown> {
    return Promise.resolve(this.values.get(key))
  }

  set(key: string, value: JsonValue): Promise<void> {
    this.values.set(key, value)
    return Promise.resolve()
  }

  remove(key: string): Promise<void> {
    this.values.delete(key)
    return Promise.resolve()
  }

  scan(options: { prefix: string; limit?: number; after?: string }): Promise<{
    entries: readonly { key: string; value: unknown }[]
    next?: string
  }> {
    const limit = options.limit ?? 100
    const after = options.after
    const keys = [...this.values.keys()].filter((key) => key.startsWith(options.prefix)).sort()
    // 游标 key 可能已被删除：按“第一个大于游标的 key”继续，而不是 findIndex 的 -1。
    const found = after === undefined ? 0 : keys.findIndex((key) => key > after)
    const start = found === -1 ? keys.length : found
    const slice = keys.slice(start, start + limit)
    const next = start + limit < keys.length ? slice.at(-1) : undefined
    return Promise.resolve({
      entries: slice.map((key) => ({ key, value: this.values.get(key) })),
      ...(next === undefined ? {} : { next }),
    })
  }
}
