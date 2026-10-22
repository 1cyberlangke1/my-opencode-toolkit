import type { Plugin } from "@opencode/plugin"
import { describe, expect, it } from "vitest"

import { MemoryStore } from "./helpers.ts"
import { createGoalContinuation } from "../src/goal/continuation.ts"
import { createGoalController } from "../src/goal/controller.ts"
import { DEFAULT_SETTINGS } from "../src/shared/settings.ts"
import { SETTINGS_KEY } from "../src/shared/keys.ts"

const SESSION = "ses_test"

/** 记录注入的续作消息。 */
type PromptLog = { sessionID: string; text: string }[]

/** 输入：注入日志；输出：只实现 session.prompt 的假上下文。 */
function fakeCtx(log: PromptLog): Plugin.Context {
  return {
    session: {
      prompt: (input: { sessionID: string; text: string }) => {
        log.push({ sessionID: input.sessionID, text: input.text })
        return Promise.resolve()
      },
    },
  } as unknown as Plugin.Context
}

/** 输入：无；输出：启用了 goal 的存储。 */
function storeWithGoalEnabled(): MemoryStore {
  const store = new MemoryStore()
  store.values.set(SETTINGS_KEY, DEFAULT_SETTINGS)
  return store
}

describe("goal continuation", () => {
  it("idle 且目标 active 时注入一次续作", async () => {
    const store = storeWithGoalEnabled()
    const controller = createGoalController(store)
    await controller.setGoal(SESSION, "ship it")
    const log: PromptLog = []
    const continuation = createGoalContinuation({ ctx: fakeCtx(log), store, controller })

    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })

    expect(log).toHaveLength(1)
    expect(log[0]?.text).toContain("Continue working toward the active thread goal.")
    expect(log[0]?.text).toContain("ship it")
  })

  it("没有目标或已暂停时不注入", async () => {
    const store = storeWithGoalEnabled()
    const controller = createGoalController(store)
    const log: PromptLog = []
    const continuation = createGoalContinuation({ ctx: fakeCtx(log), store, controller })

    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })
    await controller.setGoal(SESSION, "x")
    await controller.pauseGoal(SESSION)
    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })

    expect(log).toHaveLength(0)
  })

  it("goal 关闭时不注入", async () => {
    const store = new MemoryStore()
    store.values.set(SETTINGS_KEY, { ...DEFAULT_SETTINGS, goal: { enabled: false } })
    const controller = createGoalController(store)
    await controller.setGoal(SESSION, "x")
    const log: PromptLog = []
    const continuation = createGoalContinuation({ ctx: fakeCtx(log), store, controller })

    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })
    expect(log).toHaveLength(0)
  })

  it("注入后没有 step 时不重复注入", async () => {
    const store = storeWithGoalEnabled()
    const controller = createGoalController(store)
    await controller.setGoal(SESSION, "x")
    const log: PromptLog = []
    const continuation = createGoalContinuation({ ctx: fakeCtx(log), store, controller })

    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })
    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })
    expect(log).toHaveLength(1)

    // step 之后允许下一轮续作
    await continuation.handle({
      type: "session.step.ended",
      data: { sessionID: SESSION, tokens: { input: 1, output: 1 } },
    })
    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })
    expect(log).toHaveLength(2)
  })

  it("step.ended 把输入/输出/缓存都计入目标", async () => {
    const store = storeWithGoalEnabled()
    const controller = createGoalController(store)
    await controller.setGoal(SESSION, "x")
    const continuation = createGoalContinuation({
      ctx: fakeCtx([]),
      store,
      controller,
      now: () => 10_000,
    })

    await continuation.handle({
      type: "session.step.ended",
      data: {
        sessionID: SESSION,
        tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 2 } },
      },
    })

    expect((await controller.getGoal(SESSION))?.tokensUsed).toBe(152)
  })

  it("用户打断会暂停目标", async () => {
    const store = storeWithGoalEnabled()
    const controller = createGoalController(store)
    await controller.setGoal(SESSION, "x")
    const log: PromptLog = []
    const continuation = createGoalContinuation({ ctx: fakeCtx(log), store, controller })

    await continuation.handle({
      type: "session.execution.interrupted",
      data: { sessionID: SESSION, reason: "user" },
    })

    expect((await controller.getGoal(SESSION))?.status).toBe("paused")
    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })
    expect(log).toHaveLength(0)
  })

  it("shutdown 打断不暂停", async () => {
    const store = storeWithGoalEnabled()
    const controller = createGoalController(store)
    await controller.setGoal(SESSION, "x")
    const continuation = createGoalContinuation({ ctx: fakeCtx([]), store, controller })

    await continuation.handle({
      type: "session.execution.interrupted",
      data: { sessionID: SESSION, reason: "shutdown" },
    })

    expect((await controller.getGoal(SESSION))?.status).toBe("active")
  })

  it("余额不足暂停并锁死，reset 后恢复", async () => {
    const store = storeWithGoalEnabled()
    const controller = createGoalController(store)
    await controller.setGoal(SESSION, "x")
    const log: PromptLog = []
    const continuation = createGoalContinuation({ ctx: fakeCtx(log), store, controller })

    await continuation.handle({
      type: "session.execution.failed",
      data: { sessionID: SESSION, error: { type: "quota", message: "quota exceeded", status: 402 } },
    })
    expect((await controller.getGoal(SESSION))?.status).toBe("paused")

    await controller.resumeGoal(SESSION)
    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })
    expect(log).toHaveLength(0)

    continuation.resetRunState(SESSION)
    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })
    expect(log).toHaveLength(1)
  })

  it("删除会话清掉运行状态", async () => {
    const store = storeWithGoalEnabled()
    const controller = createGoalController(store)
    await controller.setGoal(SESSION, "x")
    const log: PromptLog = []
    const continuation = createGoalContinuation({ ctx: fakeCtx(log), store, controller })

    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })
    await continuation.handle({ type: "session.deleted", data: { sessionID: SESSION } })
    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })

    expect(log).toHaveLength(2)
  })
})
