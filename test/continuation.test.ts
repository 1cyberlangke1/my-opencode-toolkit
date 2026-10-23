import type { Plugin } from "@opencode/plugin"
import { describe, expect, it } from "vitest"

import { MemoryStore } from "./helpers.ts"
import { createGoalContinuation } from "../src/goal/continuation.ts"
import { createGoalController } from "../src/goal/controller.ts"
import { DEFAULT_SETTINGS } from "../src/shared/settings.ts"
import { SETTINGS_KEY } from "../src/shared/keys.ts"

const SESSION = "ses_test"

/** 续作测试里所有会话都当主会话。 */
const roles = {
  isSubagent: () => Promise.resolve(false),
  forget: () => undefined,
}

/** 记录注入的续作消息。 */
type PromptLog = {
  sessionID: string
  text: string
  description?: string
  resume?: boolean
}[]

/** 输入：注入日志 + 可选历史消息；输出：只实现 session 的假上下文。 */
function fakeCtx(log: PromptLog, messages: unknown[] = []): Plugin.Context {
  return {
    location: { directory: "/" },
    session: {
      get: () => Promise.resolve({ location: { directory: "/" } }),
      prompt: (input: { sessionID: string; text: string }) => {
        log.push({ sessionID: input.sessionID, text: input.text })
        return Promise.resolve()
      },
      synthetic: (input: {
        sessionID: string
        text: string
        description?: string
        resume?: boolean
      }) => {
        log.push({
          sessionID: input.sessionID,
          text: input.text,
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.resume === undefined ? {} : { resume: input.resume }),
        })
        return Promise.resolve()
      },
      context: () => Promise.resolve(messages),
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
    const continuation = createGoalContinuation({ ctx: fakeCtx(log), settings: DEFAULT_SETTINGS, controller, roles })

    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })

    expect(log).toHaveLength(1)
    expect(log[0]?.text).toContain("Continue working toward the active thread goal.")
    expect(log[0]?.text).toContain("ship it")
  })

  it("两个会话的目标与 pending 互不影响", async () => {
    const store = storeWithGoalEnabled()
    const controller = createGoalController(store)
    await controller.setGoal("ses_a", "goal-a")
    await controller.setGoal("ses_b", "goal-b")
    const log: PromptLog = []
    const continuation = createGoalContinuation({ ctx: fakeCtx(log), settings: DEFAULT_SETTINGS, controller, roles })

    await continuation.handle({ type: "session.idle", data: { sessionID: "ses_a" } })
    expect(log).toHaveLength(1)
    expect(log[0]?.sessionID).toBe("ses_a")
    expect(log[0]?.text).toContain("goal-a")

    // A 的 pending 只挡 A；B 仍然可以立即注入。
    await continuation.handle({ type: "session.idle", data: { sessionID: "ses_a" } })
    expect(log).toHaveLength(1)
    await continuation.handle({ type: "session.idle", data: { sessionID: "ses_b" } })
    expect(log).toHaveLength(2)
    expect(log[1]?.sessionID).toBe("ses_b")
    expect(log[1]?.text).toContain("goal-b")
  })

  it("session.execution.succeeded 也视为 idle 并注入续作", async () => {
    const store = storeWithGoalEnabled()
    const controller = createGoalController(store)
    await controller.setGoal(SESSION, "ship it")
    const log: PromptLog = []
    const continuation = createGoalContinuation({ ctx: fakeCtx(log), settings: DEFAULT_SETTINGS, controller, roles })

    await continuation.handle({ type: "session.execution.succeeded", data: { sessionID: SESSION } })

    expect(log).toHaveLength(1)
    expect(log[0]?.text).toContain("Continue working toward the active thread goal.")
  })

  it("没有目标或已暂停时不注入", async () => {
    const store = storeWithGoalEnabled()
    const controller = createGoalController(store)
    const log: PromptLog = []
    const continuation = createGoalContinuation({ ctx: fakeCtx(log), settings: DEFAULT_SETTINGS, controller, roles })

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
    const continuation = createGoalContinuation({
      ctx: fakeCtx(log),
      settings: { ...DEFAULT_SETTINGS, goal: { ...DEFAULT_SETTINGS.goal, enabled: false } },
      controller,
      roles,
    })

    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })
    expect(log).toHaveLength(0)
  })

  it("注入后没有 step 时不重复注入", async () => {
    const store = storeWithGoalEnabled()
    const controller = createGoalController(store)
    await controller.setGoal(SESSION, "x")
    const log: PromptLog = []
    const continuation = createGoalContinuation({ ctx: fakeCtx(log), settings: DEFAULT_SETTINGS, controller, roles })

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

  it("执行失败后清掉 pending，下一次 idle 能重试", async () => {
    const store = storeWithGoalEnabled()
    const controller = createGoalController(store)
    await controller.setGoal(SESSION, "x")
    const log: PromptLog = []
    const continuation = createGoalContinuation({ ctx: fakeCtx(log), settings: DEFAULT_SETTINGS, controller, roles })

    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })
    expect(log).toHaveLength(1)

    await continuation.handle({ type: "session.execution.failed", data: { sessionID: SESSION, error: {} } })
    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })

    expect(log).toHaveLength(2)
  })

  it("step.ended 把输入/输出/缓存都计入目标", async () => {
    const store = storeWithGoalEnabled()
    const controller = createGoalController(store)
    await controller.setGoal(SESSION, "x")
    const continuation = createGoalContinuation({
      ctx: fakeCtx([]),
      settings: DEFAULT_SETTINGS,
      controller,
      roles,
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

  it("记账达到 token 预算时发一次收尾提示", async () => {
    const store = storeWithGoalEnabled()
    const controller = createGoalController(store)
    await controller.setGoal(SESSION, "ship it", 100)
    const log: PromptLog = []
    const continuation = createGoalContinuation({
      ctx: fakeCtx(log),
      settings: DEFAULT_SETTINGS,
      controller,
      roles,
      now: () => 10_000,
    })

    await continuation.handle({
      type: "session.step.ended",
      data: { sessionID: SESSION, tokens: { input: 60, output: 50 } },
    })

    expect((await controller.getGoal(SESSION))?.status).toBe("budget_limited")
    expect(log).toHaveLength(1)
    expect(log[0]?.text).toContain("reached its token budget")
    expect(log[0]?.text).toContain("budget_limited")
    expect(log[0]?.text).toContain("ship it")
    // notice 内容必须与发给模型的内容完全一致，且必须唤醒会话。
    expect(log[0]?.description).toBe(log[0]?.text)
    expect(log[0]?.resume).toBe(true)

    // 后续 step 不再重复发收尾提示。
    await continuation.handle({
      type: "session.step.ended",
      data: { sessionID: SESSION, tokens: { input: 10, output: 10 } },
    })
    expect(log).toHaveLength(1)
  })

  it("用户打断会暂停目标", async () => {
    const store = storeWithGoalEnabled()
    const controller = createGoalController(store)
    await controller.setGoal(SESSION, "x")
    const log: PromptLog = []
    const continuation = createGoalContinuation({ ctx: fakeCtx(log), settings: DEFAULT_SETTINGS, controller, roles })

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
    const continuation = createGoalContinuation({ ctx: fakeCtx([]), settings: DEFAULT_SETTINGS, controller, roles })

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
    const continuation = createGoalContinuation({ ctx: fakeCtx(log), settings: DEFAULT_SETTINGS, controller, roles })

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

  it("末条是真实用户输入时跳过注入", async () => {
    const store = storeWithGoalEnabled()
    const controller = createGoalController(store)
    await controller.setGoal(SESSION, "x")
    const log: PromptLog = []
    const continuation = createGoalContinuation({
      ctx: fakeCtx(log, [{ type: "user", text: "等一下", metadata: {} }]),
      settings: DEFAULT_SETTINGS,
      controller,
      roles,
    })

    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })
    expect(log).toHaveLength(0)
  })

  it("末条是我们注入的续作时继续注入", async () => {
    const store = storeWithGoalEnabled()
    const controller = createGoalController(store)
    await controller.setGoal(SESSION, "x")
    const log: PromptLog = []
    const continuation = createGoalContinuation({
      ctx: fakeCtx(log, [{ type: "user", text: "continue", metadata: { goalContinuation: true } }]),
      settings: DEFAULT_SETTINGS,
      controller,
      roles,
    })

    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })
    expect(log).toHaveLength(1)
  })

  it("子代理会话不注入续作", async () => {
    const store = storeWithGoalEnabled()
    const controller = createGoalController(store)
    await controller.setGoal(SESSION, "x")
    const log: PromptLog = []
    const subagentRoles = {
      isSubagent: () => Promise.resolve(true),
      forget: () => undefined,
    }
    const continuation = createGoalContinuation({ ctx: fakeCtx(log), settings: DEFAULT_SETTINGS, controller, roles: subagentRoles })

    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })
    expect(log).toHaveLength(0)
  })

  it("pending 时重复 idle 只发一次，完成后不再续作", async () => {
    const store = storeWithGoalEnabled()
    const controller = createGoalController(store)
    await controller.setGoal(SESSION, "x")
    const log: PromptLog = []
    const continuation = createGoalContinuation({ ctx: fakeCtx(log), settings: DEFAULT_SETTINGS, controller, roles })

    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })
    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })
    expect(log).toHaveLength(1)

    // 真实 step 消费 pending；随后完成目标，下一次 idle 不得再催。
    await continuation.handle({
      type: "session.step.ended",
      data: { sessionID: SESSION, tokens: { input: 1, output: 1, cache: { read: 0, write: 0 } } },
    })
    await controller.markComplete(SESSION)
    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })
    expect(log).toHaveLength(1)
  })

  it("同一 assistant step 重放只记一次 token", async () => {
    const store = storeWithGoalEnabled()
    const controller = createGoalController(store)
    await controller.setGoal(SESSION, "x")
    const continuation = createGoalContinuation({ ctx: fakeCtx([]), settings: DEFAULT_SETTINGS, controller, roles })
    const event = {
      type: "session.step.ended" as const,
      data: {
        sessionID: SESSION,
        assistantMessageID: "msg_same",
        tokens: { input: 100, output: 10, cache: { read: 0, write: 0 } },
      },
    }

    await continuation.handle(event)
    await continuation.handle(event)
    expect((await controller.getGoal(SESSION))?.tokensUsed).toBe(110)
  })

  it("删除会话清掉运行状态与目标", async () => {
    const store = storeWithGoalEnabled()
    const controller = createGoalController(store)
    await controller.setGoal(SESSION, "x")
    const log: PromptLog = []
    const continuation = createGoalContinuation({ ctx: fakeCtx(log), settings: DEFAULT_SETTINGS, controller, roles })

    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })
    await continuation.handle({ type: "session.deleted", data: { sessionID: SESSION } })

    // 会话删除后目标 key 也删掉，后续 idle 不再续作。
    expect(await controller.getGoal(SESSION)).toBeNull()
    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })

    expect(log).toHaveLength(1)
  })
})
