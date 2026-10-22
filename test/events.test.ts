import { describe, expect, it } from "vitest"

import { dispatchEvent, readEventData, readEventSessionID, type PluginEvent } from "../src/shared/events.ts"

const EVENT: PluginEvent = { type: "session.idle", data: { sessionID: "ses_a" } }

describe("readEventSessionID", () => {
  it("读取 data.sessionID", () => {
    expect(readEventSessionID(EVENT)).toBe("ses_a")
  })

  it("缺失或类型错误返回 undefined", () => {
    expect(readEventSessionID({ type: "x", data: {} })).toBeUndefined()
    expect(readEventSessionID({ type: "x", data: { sessionID: 42 } })).toBeUndefined()
    expect(readEventSessionID({ type: "x", data: null })).toBeUndefined()
    expect(readEventSessionID({ type: "x", data: "text" })).toBeUndefined()
  })
})

describe("readEventData", () => {
  it("对象返回自身，非对象返回 undefined", () => {
    expect(readEventData(EVENT)).toEqual({ sessionID: "ses_a" })
    expect(readEventData({ type: "x", data: [1] })).toBeUndefined()
  })
})

describe("dispatchEvent", () => {
  it("单个 handler 抛错不影响后续 handler", async () => {
    const called: string[] = []
    await dispatchEvent(
      [
        () => Promise.reject(new Error("boom")),
        () => {
          called.push("second")
          return Promise.resolve()
        },
      ],
      EVENT,
    )
    expect(called).toEqual(["second"])
  })

  it("抛错后仍能处理下一条事件", async () => {
    const called: string[] = []
    const handlers = [
      (event: PluginEvent) => {
        if (event.type === "session.idle") throw new Error("boom")
        called.push(event.type)
        return Promise.resolve()
      },
    ]

    await dispatchEvent(handlers, EVENT)
    await dispatchEvent(handlers, { type: "session.step.ended", data: {} })
    expect(called).toEqual(["session.step.ended"])
  })
})
