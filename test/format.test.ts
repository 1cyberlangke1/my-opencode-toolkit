import { describe, expect, it } from "vitest"

import { truncate } from "../src/shared/format.ts"
import { formatTokens } from "../src/tui/format.ts"

describe("truncate", () => {
  it("默认让省略号占用额外 3 个字符", () => {
    expect(truncate("abcdefgh", 5)).toBe("abcde...")
    expect(truncate("abc", 5)).toBe("abc")
  })

  it("reserve=3 时总长度不超过 max", () => {
    expect(truncate("abcdefgh", 5, 3)).toBe("ab...")
  })

  it("max 小于 reserve 时不产生负长度切片", () => {
    expect(truncate("abcdefgh", 2, 3)).toBe("...")
  })
})

describe("formatTokens", () => {
  it("小于一千原样输出", () => {
    expect(formatTokens(0)).toBe("0")
    expect(formatTokens(999)).toBe("999")
  })

  it("千级用大写 K", () => {
    expect(formatTokens(1000)).toBe("1K")
    expect(formatTokens(1234)).toBe("1.2K")
    expect(formatTokens(12_300)).toBe("12.3K")
    expect(formatTokens(999_949)).toBe("999.9K")
  })

  it("进位边界不会出现 1000K", () => {
    expect(formatTokens(999_950)).toBe("1M")
    expect(formatTokens(999_999)).toBe("1M")
  })

  it("更大单位按 K/M/B/T/P/E 单字母大写", () => {
    expect(formatTokens(1_000_000)).toBe("1M")
    expect(formatTokens(1_234_567)).toBe("1.2M")
    expect(formatTokens(1_000_000_000)).toBe("1B")
    expect(formatTokens(1_500_000_000)).toBe("1.5B")
    expect(formatTokens(1_000_000_000_000)).toBe("1T")
    expect(formatTokens(1_000_000_000_000_000)).toBe("1P")
    expect(formatTokens(1_000_000_000_000_000_000)).toBe("1E")
  })

  it("负数、NaN 和非有限值", () => {
    expect(formatTokens(-1234)).toBe("-1.2K")
    expect(formatTokens(Number.NaN)).toBe("0")
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe("0")
  })
})
