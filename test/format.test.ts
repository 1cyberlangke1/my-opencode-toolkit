import { describe, expect, it } from "vitest"

import { formatTokens } from "../src/shared/format.ts"

describe("formatTokens", () => {
  it("小于一千原样输出", () => {
    expect(formatTokens(0)).toBe("0")
    expect(formatTokens(999)).toBe("999")
  })

  it("千级保留一位小数", () => {
    expect(formatTokens(1000)).toBe("1k")
    expect(formatTokens(1234)).toBe("1.2k")
    expect(formatTokens(12_300)).toBe("12.3k")
  })

  it("百万级用 m", () => {
    expect(formatTokens(1_000_000)).toBe("1m")
    expect(formatTokens(1_234_567)).toBe("1.2m")
  })
})
