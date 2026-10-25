import { describe, expect, it } from "vitest"

import { countdownColor, dim, hitRateColor } from "../src/tui/color.ts"
import { formatCountdown, truncate, visualWidth } from "../src/tui/format.ts"

describe("hitRateColor", () => {
  it("0 红、50 黄、100 绿", () => {
    expect(hitRateColor(0)).toBe("#ef4444")
    expect(hitRateColor(50)).toBe("#eab308")
    expect(hitRateColor(100)).toBe("#22c55e")
  })

  it("越界夹住", () => {
    expect(hitRateColor(-10)).toBe("#ef4444")
    expect(hitRateColor(120)).toBe("#22c55e")
  })
})

describe("countdownColor", () => {
  it("0 红、10m 黄、1h 绿", () => {
    expect(countdownColor(0)).toBe("#ef4444")
    expect(countdownColor(10 * 60_000)).toBe("#eab308")
    expect(countdownColor(60 * 60_000)).toBe("#22c55e")
  })

  it("超过 1h 仍为绿", () => {
    expect(countdownColor(2 * 60 * 60_000)).toBe("#22c55e")
  })
})

describe("原文宽度与倒计时", () => {
  it("CJK 按两列计算", () => {
    expect(visualWidth("你好a")).toBe(5)
    expect(truncate("你好世界", 5)).toBe("你好…")
  })

  it("倒计时压缩成 s/m/h", () => {
    expect(formatCountdown(37_000)).toBe("37s")
    expect(formatCountdown(4 * 60_000)).toBe("4m0s")
    expect(formatCountdown(62 * 60_000)).toBe("1h2m0s")
  })
})
describe("dim", () => {
  it("hex 颜色按系数压暗，色相不变", () => {
    expect(dim("#ffffff", 0.5)).toBe("#808080")
    expect(dim("#00ff00", 0)).toBe("#000000")
  })

  it("RGBA 对象只缩放 r/g/b，alpha 保持", () => {
    const dimmed = dim({ r: 0.8, g: 0.4, b: 0.2, a: 0.7 }, 0.5)
    expect(typeof dimmed).not.toBe("string")
    if (typeof dimmed === "string") return
    expect(dimmed.r).toBeCloseTo(0.4, 2)
    expect(dimmed.g).toBeCloseTo(0.2, 2)
    expect(dimmed.b).toBeCloseTo(0.1, 2)
    expect(dimmed.a).toBeCloseTo(0.7, 2)
  })

  it("系数越界夹到 0-1", () => {
    expect(dim("#ffffff", 2)).toBe("#ffffff")
    expect(dim("#ffffff", -1)).toBe("#000000")
  })
})