import { describe, expect, it } from "vitest"

import { createStatsTracker, hitRatePercent, trackEvent } from "../src/stats.ts"

const SESSION = "ses_test"

describe("stats tracker", () => {
  it("按 step 累加输入/输出/缓存", () => {
    const tracker = createStatsTracker()
    tracker.recordStep(SESSION, { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 2 } })

    const stats = tracker.get(SESSION)
    expect(stats.steps).toBe(1)
    expect(stats.input).toBe(100)
    expect(stats.output).toBe(20)
    expect(stats.cached).toBe(32)
  })

  it("忽略非法 token 值", () => {
    const tracker = createStatsTracker()
    tracker.recordStep(SESSION, { input: -5, output: "x", cache: { read: Number.NaN } })
    const stats = tracker.get(SESSION)
    expect(stats.input).toBe(0)
    expect(stats.output).toBe(0)
    expect(stats.cached).toBe(0)
    expect(stats.steps).toBe(1)
  })

  it("按工具名计数", () => {
    const tracker = createStatsTracker()
    tracker.recordTool(SESSION, "read")
    tracker.recordTool(SESSION, "read")
    tracker.recordTool(SESSION, "shell")
    expect(tracker.get(SESSION).tools).toEqual({ read: 2, shell: 1 })
  })

  it("子代理记到父会话", () => {
    const tracker = createStatsTracker()
    tracker.recordSubagent(SESSION)
    expect(tracker.get(SESSION).subagents).toBe(1)
  })

  it("未知会话返回空统计", () => {
    const tracker = createStatsTracker()
    expect(tracker.get("ses_missing")).toEqual({
      steps: 0,
      input: 0,
      output: 0,
      cached: 0,
      tools: {},
      subagents: 0,
    })
  })

  it("删除会话后清空", () => {
    const tracker = createStatsTracker()
    tracker.recordTool(SESSION, "read")
    tracker.forget(SESSION)
    expect(tracker.get(SESSION).tools).toEqual({})
  })
})

describe("trackEvent", () => {
  it("step.ended 记账", () => {
    const tracker = createStatsTracker()
    trackEvent(tracker, { type: "session.step.ended", data: { sessionID: SESSION, tokens: { input: 10 } } })
    expect(tracker.get(SESSION).input).toBe(10)
  })

  it("session.created 带 parentID 时给父会话 +1", () => {
    const tracker = createStatsTracker()
    trackEvent(tracker, {
      type: "session.created",
      data: { sessionID: "ses_child", parentID: SESSION },
    })
    expect(tracker.get(SESSION).subagents).toBe(1)
  })

  it("session.deleted 清统计", () => {
    const tracker = createStatsTracker()
    tracker.recordTool(SESSION, "read")
    trackEvent(tracker, { type: "session.deleted", data: { sessionID: SESSION } })
    expect(tracker.get(SESSION).tools).toEqual({})
  })

  it("无关事件不报错", () => {
    const tracker = createStatsTracker()
    trackEvent(tracker, { type: "session.idle", data: { sessionID: SESSION } })
    trackEvent(tracker, { type: "session.idle", data: null })
  })
})

describe("hitRatePercent", () => {
  it("向下截断两位小数", () => {
    expect(hitRatePercent(100, 32)).toBe(24.24)
    expect(hitRatePercent(3, 1)).toBe(25)
  })

  it("全命中才是 100", () => {
    expect(hitRatePercent(0, 100)).toBe(100)
    expect(hitRatePercent(1, 100)).toBe(99)
  })

  it("没有数据时为 0", () => {
    expect(hitRatePercent(0, 0)).toBe(0)
  })
})
