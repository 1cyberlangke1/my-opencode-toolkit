import type { JsonStore, JsonValue } from "../src/shared/json.ts"

/** 内存存储：模拟 ctx.storage 的读写语义。 */
export class MemoryStore implements JsonStore {
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
}
