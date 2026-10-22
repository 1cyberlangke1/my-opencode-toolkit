import { describe, expect, it } from "vitest"

import {
  computeNextCronRun,
  cronToHuman,
  jitteredNextCronRunMs,
  nextCronRunMs,
  oneShotJitteredNextCronRunMs,
  parseCronExpression,
} from "../src/scheduling/cron.ts"

describe("parseCronExpression", () => {
  it("接受通配、步进、范围、列表", () => {
    expect(parseCronExpression("* * * * *")).not.toBeNull()
    expect(parseCronExpression("*/5 * * * *")?.minute).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55])
    expect(parseCronExpression("0 9-17 * * 1-5")?.hour).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17])
    expect(parseCronExpression("0,30 * * * *")?.minute).toEqual([0, 30])
    expect(parseCronExpression("0 0 * * 7")?.dayOfWeek).toEqual([0])
  })

  it("拒绝非法表达式", () => {
    expect(parseCronExpression("")).toBeNull()
    expect(parseCronExpression("* * * *")).toBeNull()
    expect(parseCronExpression("60 * * * *")).toBeNull()
    expect(parseCronExpression("0 24 * * *")).toBeNull()
    expect(parseCronExpression("0 0 32 * *")).toBeNull()
    expect(parseCronExpression("0 0 * 13 *")).toBeNull()
    expect(parseCronExpression("*/0 * * * *")).toBeNull()
    expect(parseCronExpression("a * * * *")).toBeNull()
  })
})

describe("computeNextCronRun", () => {
  it("每分钟：严格取下一分钟", () => {
    const fields = parseCronExpression("* * * * *")
    expect(fields).not.toBeNull()
    if (fields === null) return
    const from = new Date(2026, 0, 1, 12, 0, 30)
    expect(computeNextCronRun(fields, from)?.getTime()).toBe(new Date(2026, 0, 1, 12, 1, 0).getTime())
  })

  it("每天固定时刻", () => {
    const from = new Date(2026, 0, 1, 10, 0, 0)
    expect(nextCronRunMs("30 14 * * *", from.getTime())).toBe(new Date(2026, 0, 1, 14, 30, 0).getTime())
  })

  it("工作日只在周一到周五", () => {
    // 2026-01-03 是周六
    const from = new Date(2026, 0, 3, 10, 0, 0)
    const next = nextCronRunMs("0 9 * * 1-5", from.getTime())
    expect(next).toBe(new Date(2026, 0, 5, 9, 0, 0).getTime())
  })

  it("dom 与 dow 同时受限时任一匹配", () => {
    // 每月 1 号 或 每周一
    const from = new Date(2026, 0, 2, 0, 0, 0) // 周五
    const next = nextCronRunMs("0 0 1 * 1", from.getTime())
    expect(next).toBe(new Date(2026, 0, 5, 0, 0, 0).getTime())
  })

  it("闰日 2 月 29 日在四年窗口内可解析", () => {
    const from = new Date(2026, 0, 1, 0, 0, 0)
    expect(nextCronRunMs("0 0 29 2 *", from.getTime())).toBe(new Date(2028, 1, 29, 0, 0, 0).getTime())
  })

  it("不可能日期返回 null", () => {
    expect(nextCronRunMs("0 0 31 2 *", new Date(2026, 0, 1, 0, 0, 0).getTime())).toBeNull()
  })
})

describe("jitter", () => {
  it("recurring 抖动有界且稳定", () => {
    const from = new Date(2026, 0, 1, 0, 0, 0).getTime()
    const base = nextCronRunMs("0 * * * *", from)
    expect(base).not.toBeNull()
    if (base === null) return

    const first = jitteredNextCronRunMs("0 * * * *", from, "abcdef12")
    const again = jitteredNextCronRunMs("0 * * * *", from, "abcdef12")
    expect(first).toBe(again)
    expect(first).not.toBeNull()
    if (first === null) return
    expect(first).toBeGreaterThanOrEqual(base)
    expect(first - base).toBeLessThanOrEqual(15 * 60 * 1000)
  })

  it("one-shot 提前量不早于起点", () => {
    const from = new Date(2026, 0, 1, 0, 0, 0).getTime()
    const result = oneShotJitteredNextCronRunMs("0 * * * *", from, "abcdef12")
    expect(result).not.toBeNull()
    if (result === null) return
    expect(result).toBeGreaterThanOrEqual(from)
  })

  it("非法表达式返回 null", () => {
    expect(jitteredNextCronRunMs("bad", Date.now(), "abcdef12")).toBeNull()
    expect(oneShotJitteredNextCronRunMs("bad", Date.now(), "abcdef12")).toBeNull()
  })
})

describe("cronToHuman", () => {
  it("常见模式有可读描述", () => {
    expect(cronToHuman("*/5 * * * *")).toBe("every 5 minutes")
    expect(cronToHuman("0 * * * *")).toBe("every hour")
    expect(cronToHuman("30 14 * * *")).toBe("daily at 14:30")
    expect(cronToHuman("0 9 * * 1-5")).toBe("weekdays at 09:00")
    expect(cronToHuman("0 9 * * 1")).toBe("weekly on Monday at 09:00")
  })

  it("无法识别时回退原文", () => {
    expect(cronToHuman("0 0 1 6 *")).toBe("0 0 1 6 *")
  })
})
