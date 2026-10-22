import type { JsonValue, ScannableStore } from "../src/shared/json.ts"

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
    const start = after === undefined ? 0 : keys.findIndex((key) => key > after)
    const slice = keys.slice(start, start + limit)
    const next = start + limit < keys.length ? slice.at(-1) : undefined
    return Promise.resolve({
      entries: slice.map((key) => ({ key, value: this.values.get(key) })),
      ...(next === undefined ? {} : { next }),
    })
  }
}
