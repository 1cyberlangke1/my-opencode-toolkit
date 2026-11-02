import { describe, expect, it } from "vitest"

import { truncate } from "../src/shared/format.ts"
import { formatIntervalSeconds, formatTokens, parseIntervalSeconds } from "../src/tui/format.ts"

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

describe("formatIntervalSeconds", () => {
  it("30 秒以下也按秒输出", () => {
    expect(formatIntervalSeconds(15)).toBe("15s")
    expect(formatIntervalSeconds(30)).toBe("30s")
  })

  it("整分钟或带秒输出", () => {
    expect(formatIntervalSeconds(60)).toBe("1m")
    expect(formatIntervalSeconds(300)).toBe("5m")
    expect(formatIntervalSeconds(90)).toBe("1m30s")
  })

  it("整小时或带分秒输出", () => {
    expect(formatIntervalSeconds(3600)).toBe("1h")
    expect(formatIntervalSeconds(5400)).toBe("1h30m")
    expect(formatIntervalSeconds(3665)).toBe("1h1m5s")
  })
})

describe("parseIntervalSeconds", () => {
  it("纯秒数（下限 30 秒）", () => {
    expect(parseIntervalSeconds("300")).toBe(300)
    expect(parseIntervalSeconds("30")).toBe(30)
    expect(parseIntervalSeconds("29")).toBeUndefined() // 低于 30 秒拒绝
    expect(parseIntervalSeconds("-10")).toBeUndefined()
  })

  it("带单位简写（s/m/h）", () => {
    expect(parseIntervalSeconds("30s")).toBe(30)
    expect(parseIntervalSeconds("5m")).toBe(300)
    expect(parseIntervalSeconds("1h")).toBe(3600)
    expect(parseIntervalSeconds("1h30m")).toBe(5400)
    expect(parseIntervalSeconds("1m30s")).toBe(90)
    expect(parseIntervalSeconds("20s")).toBeUndefined() // 低于 30 秒拒绝
  })

  it("非法输入回退 undefined", () => {
    expect(parseIntervalSeconds("")).toBeUndefined()
    expect(parseIntervalSeconds("abc")).toBeUndefined()
    expect(parseIntervalSeconds("5x")).toBeUndefined()
  })
})
