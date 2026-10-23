import type { Plugin } from "@opencode/plugin"
import { describe, expect, it } from "vitest"

import { createLoopScheduler } from "../src/scheduling/loops.ts"

const SESSION = "ses_test"

const roles = {
  isSubagent: () => Promise.resolve(false),
  forget: () => undefined,
}

/** 输入：日志数组 + 当前 agent；输出：只实现 setup 依赖的假上下文。 */
function fakeCtx(log: string[], agent = "build"): Plugin.Context {
  return {
    session: {
      get: () => Promise.resolve({ agent }),
      prompt: (input: { text: string }) => {
        log.push(input.text)
        return Promise.resolve()
      },
      synthetic: (input: { text: string }) => {
        log.push(input.text)
        return Promise.resolve()
      },
      context: () => Promise.resolve([]),
    },
  } as unknown as Plugin.Context
}

/** 输入：无；输出：让出事件循环，等待即时 fire 完成。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe("loop scheduler", () => {
  it("fixed 模式立即注入并按间隔武装", async () => {
    const log: string[] = []
    const scheduler = createLoopScheduler({ ctx: fakeCtx(log), roles, shouldDefer: () => Promise.resolve(false) })

    const loop = scheduler.startLoop(SESSION, "keep going", 5)
    await flush()

    expect(loop.mode).toBe("fixed")
    expect(loop.intervalSeconds).toBe(5)
    expect(log).toEqual(["keep going"])
    expect(loop.nextFireAt).toBeGreaterThan(Date.now())
    scheduler.dispose()
  })

  it("dynamic 模式立即注入并等 schedule_wakeup", async () => {
    const log: string[] = []
    const scheduler = createLoopScheduler({ ctx: fakeCtx(log), roles, shouldDefer: () => Promise.resolve(false) })

    const loop = scheduler.startLoop(SESSION, "check", undefined)
    await flush()

    expect(loop.mode).toBe("dynamic")
    expect(log).toEqual(["check"])
    scheduler.dispose()
  })

  it("同一 prompt 只保留一个循环", () => {
    const log: string[] = []
    const scheduler = createLoopScheduler({ ctx: fakeCtx(log), roles, shouldDefer: () => Promise.resolve(false) })

    const first = scheduler.startLoop(SESSION, "same", 5)
    const second = scheduler.startLoop(SESSION, "same", 5)

    expect(scheduler.listLoops(SESSION)).toHaveLength(1)
    expect(first.id).not.toBe(second.id)
    scheduler.dispose()
  })

  it("schedule_wakeup 把延迟夹到 60 秒并向上取整到分钟", () => {
    const log: string[] = []
    const scheduler = createLoopScheduler({ ctx: fakeCtx(log), roles, shouldDefer: () => Promise.resolve(false) })
    const loop = scheduler.startLoop(SESSION, "check", undefined)

    const result = scheduler.scheduleWakeup(SESSION, "check", 10, "retry later")

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.id).toBe(loop.id)
    expect(result.fireAt % 60_000).toBe(0)
    expect(loop.pendingWakeup?.delaySeconds).toBe(60)
    scheduler.dispose()
  })

  it("fixed 循环不接受 schedule_wakeup", () => {
    const log: string[] = []
    const scheduler = createLoopScheduler({ ctx: fakeCtx(log), roles, shouldDefer: () => Promise.resolve(false) })
    scheduler.startLoop(SESSION, "check", 5)

    const result = scheduler.scheduleWakeup(SESSION, "check", 60, "x")
    expect(result.ok).toBe(false)
    scheduler.dispose()
  })

  it("停止后不再注入", async () => {
    const log: string[] = []
    const scheduler = createLoopScheduler({ ctx: fakeCtx(log), roles, shouldDefer: () => Promise.resolve(false) })
    scheduler.startLoop(SESSION, "check", 5)
    await flush()

    expect(scheduler.stopLoopByPrompt(SESSION, "check")).toBe(true)
    expect(scheduler.listLoops(SESSION)).toHaveLength(0)
    expect(scheduler.stopAllLoops(SESSION)).toBe(0)
    scheduler.dispose()
  })

  it("子代理会话不注入", async () => {
    const log: string[] = []
    const subagentRoles = { isSubagent: () => Promise.resolve(true), forget: () => undefined }
    const scheduler = createLoopScheduler({ ctx: fakeCtx(log), roles: subagentRoles, shouldDefer: () => Promise.resolve(false) })

    scheduler.startLoop(SESSION, "check", 5)
    await flush()

    expect(log).toHaveLength(0)
    scheduler.dispose()
  })

  it("让路时不注入但仍保留循环", async () => {
    const log: string[] = []
    const scheduler = createLoopScheduler({ ctx: fakeCtx(log), roles, shouldDefer: () => Promise.resolve(true) })

    scheduler.startLoop(SESSION, "check", 5)
    await flush()

    expect(log).toHaveLength(0)
    expect(scheduler.listLoops(SESSION)).toHaveLength(1)
    scheduler.dispose()
  })

  it("plan 模式跳过注入并弹提示，循环保留", async () => {
    const log: string[] = []
    const skipped: string[] = []
    const scheduler = createLoopScheduler({
      ctx: fakeCtx(log, "plan"),
      roles,
      shouldDefer: () => Promise.resolve(false),
      notifySkipped: (kind) => skipped.push(kind),
    })

    scheduler.startLoop(SESSION, "check", 5)
    await flush()

    expect(log).toHaveLength(0)
    expect(skipped).toEqual(["loop"])
    expect(scheduler.listLoops(SESSION)).toHaveLength(1)
    scheduler.dispose()
  })

  it("非正间隔退化为 dynamic，不会忙循环", async () => {
    const log: string[] = []
    const scheduler = createLoopScheduler({ ctx: fakeCtx(log), roles, shouldDefer: () => Promise.resolve(false) })

    const loop = scheduler.startLoop(SESSION, "zero", 0)
    await flush()

    expect(loop.mode).toBe("dynamic")
    expect(loop.intervalSeconds).toBeUndefined()
    scheduler.dispose()
  })

  it("NaN 唤醒延迟夹到 60 秒", () => {
    const log: string[] = []
    const scheduler = createLoopScheduler({ ctx: fakeCtx(log), roles, shouldDefer: () => Promise.resolve(false) })
    const loop = scheduler.startLoop(SESSION, "check", undefined)

    const result = scheduler.scheduleWakeup(SESSION, "check", Number.NaN, "retry later")

    expect(result.ok).toBe(true)
    expect(loop.pendingWakeup?.delaySeconds).toBe(60)
    scheduler.dispose()
  })

  it("超大固定间隔夹到 7 天", () => {
    const log: string[] = []
    const scheduler = createLoopScheduler({ ctx: fakeCtx(log), roles, shouldDefer: () => Promise.resolve(false) })

    const loop = scheduler.startLoop(SESSION, "long", 30 * 24 * 3600)

    expect(loop.mode).toBe("fixed")
    expect(loop.intervalSeconds).toBe(7 * 24 * 3600)
    scheduler.dispose()
  })

  it("执行失败后清掉 pending，循环能继续注入", async () => {
    const log: string[] = []
    const scheduler = createLoopScheduler({ ctx: fakeCtx(log), roles, shouldDefer: () => Promise.resolve(false) })

    scheduler.startLoop(SESSION, "a", 5)
    await flush()
    expect(log).toEqual(["a"])

    await scheduler.handleEvent({ type: "session.execution.failed", data: { sessionID: SESSION } })

    scheduler.startLoop(SESSION, "b", 5)
    await flush()
    expect(log).toEqual(["a", "b"])
    scheduler.dispose()
  })

  it("功能关闭时循环暂停，重新开启后恢复", async () => {
    const log: string[] = []
    let on = false
    const scheduler = createLoopScheduler({
      ctx: fakeCtx(log),
      roles,
      shouldDefer: () => Promise.resolve(false),
      enabled: () => Promise.resolve(on),
    })

    scheduler.startLoop(SESSION, "paused", 5)
    await flush()
    expect(log).toHaveLength(0)

    on = true
    scheduler.startLoop(SESSION, "resumed", 5)
    await flush()
    expect(log).toEqual(["resumed"])
    scheduler.dispose()
  })
})
