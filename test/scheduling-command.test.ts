import { describe, expect, it } from "vitest"

import { parseIntervalSeconds, parseLoopCommand } from "../src/scheduling/command.ts"

describe("parseIntervalSeconds", () => {
  it("秒向上取整到分钟，最小 60", () => {
    expect(parseIntervalSeconds("30s")).toBe(60)
    expect(parseIntervalSeconds("90s")).toBe(120)
  })

  it("分/时/天换算", () => {
    expect(parseIntervalSeconds("5m")).toBe(300)
    expect(parseIntervalSeconds("2h")).toBe(7200)
    expect(parseIntervalSeconds("1d")).toBe(86_400)
  })

  it("非法值返回 undefined", () => {
    expect(parseIntervalSeconds("0m")).toBeUndefined()
    expect(parseIntervalSeconds("5x")).toBeUndefined()
    expect(parseIntervalSeconds("m")).toBeUndefined()
    expect(parseIntervalSeconds("-5m")).toBeUndefined()
  })
})

describe("parseLoopCommand", () => {
  it("首个 token 是间隔时剥离", () => {
    expect(parseLoopCommand("5m check the deploy")).toEqual({
      kind: "start",
      prompt: "check the deploy",
      intervalSeconds: 300,
    })
  })

  it("省略间隔时是动态循环", () => {
    expect(parseLoopCommand("check the deploy")).toEqual({ kind: "start", prompt: "check the deploy" })
  })

  it("只有间隔时 prompt 为空", () => {
    expect(parseLoopCommand("10m")).toEqual({ kind: "start", prompt: "", intervalSeconds: 600 })
  })

  it("stop 单独识别", () => {
    expect(parseLoopCommand("stop")).toEqual({ kind: "stop" })
    expect(parseLoopCommand("STOP")).toEqual({ kind: "stop" })
  })

  it("空参数启动空 prompt", () => {
    expect(parseLoopCommand("  ")).toEqual({ kind: "start", prompt: "" })
  })
})
