import { describe, expect, it } from "vitest"

import type { JsonStore, JsonValue } from "../src/shared/json.ts"
import { SETTINGS_KEY } from "../src/shared/keys.ts"
import { loadSettings, saveSettings } from "../src/shared/settings-store.ts"
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/shared/settings.ts"

/** 内存存储，模拟 ctx.storage 的读写语义。 */
class MemoryStore implements JsonStore {
  readonly values = new Map<string, JsonValue>()

  get(key: string): Promise<unknown> {
    return Promise.resolve(this.values.get(key))
  }

  set(key: string, value: JsonValue): Promise<void> {
    this.values.set(key, value)
    return Promise.resolve()
  }
}

describe("loadSettings", () => {
  it("首次运行写入默认值并返回", async () => {
    const store = new MemoryStore()
    const got = await loadSettings(store)
    expect(got).toEqual(DEFAULT_SETTINGS)
    expect(store.values.get(SETTINGS_KEY)).toEqual(DEFAULT_SETTINGS)
  })

  it("用插件 options 作为首次默认值", async () => {
    const store = new MemoryStore()
    const got = await loadSettings(store, { lang: "zh", notification: { enabled: false } })
    expect(got.lang).toBe("zh")
    expect(got.notification.enabled).toBe(false)
    expect(got.goal).toEqual(DEFAULT_SETTINGS.goal)
  })

  it("已有值优先于 options", async () => {
    const store = new MemoryStore()
    store.values.set(SETTINGS_KEY, normalizeSettings({ lang: "en" }))
    const got = await loadSettings(store, { lang: "zh" })
    expect(got.lang).toBe("en")
  })

  it("存储损坏时按默认值补齐，不抛异常", async () => {
    const store = new MemoryStore()
    store.values.set(SETTINGS_KEY, "broken")
    const got = await loadSettings(store)
    expect(got).toEqual(DEFAULT_SETTINGS)
  })
})

describe("saveSettings", () => {
  it("写盘前归一化，未知字段不会落盘", async () => {
    const store = new MemoryStore()
    await saveSettings(store, {
      ...DEFAULT_SETTINGS,
      lang: "zh",
      extra: true,
    } as unknown as typeof DEFAULT_SETTINGS)

    const stored = store.values.get(SETTINGS_KEY)
    expect(stored).toEqual(normalizeSettings({ lang: "zh" }))
    expect(JSON.stringify(stored)).not.toContain("extra")
  })
})
