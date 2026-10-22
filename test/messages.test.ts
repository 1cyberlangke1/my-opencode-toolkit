import { describe, expect, it } from "vitest"

import { isSyntheticUserMessage, SYNTHETIC_MARKERS } from "../src/shared/messages.ts"

describe("isSyntheticUserMessage", () => {
  it("识别所有插件注入标记", () => {
    for (const marker of SYNTHETIC_MARKERS) {
      expect(isSyntheticUserMessage({ type: "user", metadata: { [marker]: true } })).toBe(true)
    }
  })

  it("真实用户消息不算", () => {
    expect(isSyntheticUserMessage({ type: "user", metadata: {} })).toBe(false)
    expect(isSyntheticUserMessage({ type: "user" })).toBe(false)
    expect(isSyntheticUserMessage({ type: "user", metadata: { goalContinuation: false } })).toBe(false)
  })

  it("助手消息即使带标记也不算", () => {
    expect(isSyntheticUserMessage({ type: "assistant", metadata: { goalContinuation: true } })).toBe(false)
  })
})
