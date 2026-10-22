import { describe, expect, it } from "vitest"

import { capTimerDelay, MAX_TIMER_DELAY_MS } from "../src/shared/timer.ts"

describe("capTimerDelay", () => {
  it("正常延迟原样返回", () => {
    expect(capTimerDelay(0)).toBe(0)
    expect(capTimerDelay(1000)).toBe(1000)
  })

  it("负数夹到 0", () => {
    expect(capTimerDelay(-5)).toBe(0)
  })

  it("超过 24 小时或非有限值夹到上限", () => {
    expect(capTimerDelay(MAX_TIMER_DELAY_MS + 1)).toBe(MAX_TIMER_DELAY_MS)
    expect(capTimerDelay(Number.POSITIVE_INFINITY)).toBe(MAX_TIMER_DELAY_MS)
    expect(capTimerDelay(Number.NaN)).toBe(MAX_TIMER_DELAY_MS)
  })
})
