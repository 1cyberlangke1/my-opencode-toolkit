import { describe, expect, it } from "vitest"

import { NPM_PRESETS, npmPresetOptions } from "../src/provider/npm-presets.ts"

describe("SDK 预设提示", () => {
  it("每个预设都把端点放进 footer，包名放进 title", () => {
    const options = npmPresetOptions()

    expect(options).toHaveLength(NPM_PRESETS.length)
    for (const [index, option] of options.entries()) {
      const preset = NPM_PRESETS[index]
      expect(preset).toBeDefined()
      if (!preset) continue
      // title/value 是包名本身，footer 才是右对齐的端点提示。
      expect(option.title).toBe(preset.id)
      expect(option.value).toBe(preset.id)
      expect(option.footer).toBe(preset.endpoint)
    }
  })

  it("端点互不相同，能区分 /chat/completions 与 /responses", () => {
    // 这几个地址长得像却不是一回事，重复就等于没提示。
    const endpoints = NPM_PRESETS.map((preset) => preset.endpoint)

    expect(new Set(endpoints).size).toBe(endpoints.length)
    for (const endpoint of endpoints) expect(endpoint.length).toBeGreaterThan(0)
  })
})
