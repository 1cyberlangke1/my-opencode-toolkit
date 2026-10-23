import { describe, expect, it } from "vitest"

import { MemoryStore } from "./helpers.ts"
import { createGoalController } from "../src/goal/controller.ts"
import { parseGoalCommand } from "../src/goal/parse-command.ts"
import { buildContinuationPrompt } from "../src/goal/prompts.ts"
import { classifyGoalFailure } from "../src/goal/error.ts"
import { clearGoal, createGoal, readGoal, setGoalStatus } from "../src/goal/store.ts"
import { parseGoal } from "../src/goal/types.ts"
import { goalKey } from "../src/shared/keys.ts"

const SESSION = "ses_test"

/** 输入：存储；输出：绑定该存储的控制器。 */
function controller(store: MemoryStore) {
  return createGoalController(store)
}

describe("parseGoalCommand", () => {
  it("空参数是 show", () => {
    expect(parseGoalCommand("  ")).toEqual({ kind: "show" })
  })

  it("精确匹配控制词，忽略大小写", () => {
    expect(parseGoalCommand("PAUSE")).toEqual({ kind: "pause" })
    expect(parseGoalCommand("resume")).toEqual({ kind: "resume" })
    expect(parseGoalCommand("clear")).toEqual({ kind: "clear" })
    expect(parseGoalCommand("edit")).toEqual({ kind: "edit" })
  })

  it("其余整段作为新目标", () => {
    expect(parseGoalCommand("  ship the release  ")).toEqual({ kind: "set", objective: "ship the release" })
    expect(parseGoalCommand("pause the deploy")).toEqual({ kind: "set", objective: "pause the deploy" })
  })
})

describe("goal store", () => {
  it("创建后可读回", async () => {
    const store = new MemoryStore()
    const created = await createGoal(store, SESSION, "ship it")
    expect(created.status).toBe("active")
    expect(created.tokensUsed).toBe(0)
    expect(await readGoal(store, SESSION)).toEqual(created)
    expect(store.values.has(goalKey(SESSION))).toBe(true)
  })

  it("不同会话互不影响", async () => {
    const store = new MemoryStore()
    await createGoal(store, "ses_a", "a")
    await createGoal(store, "ses_b", "b")
    expect((await readGoal(store, "ses_a"))?.objective).toBe("a")
    expect((await readGoal(store, "ses_b"))?.objective).toBe("b")
  })

  it("清除返回是否存在", async () => {
    const store = new MemoryStore()
    expect(await clearGoal(store, SESSION)).toBe(false)
    await createGoal(store, SESSION, "x")
    expect(await clearGoal(store, SESSION)).toBe(true)
    expect(await readGoal(store, SESSION)).toBeNull()
  })

  it("存储损坏时读回 null", async () => {
    const store = new MemoryStore()
    store.values.set(goalKey(SESSION), "not a goal")
    expect(await readGoal(store, SESSION)).toBeNull()
  })
})

describe("parseGoal", () => {
  it("拒绝缺字段或非法状态", () => {
    expect(parseGoal(undefined)).toBeNull()
    expect(parseGoal({})).toBeNull()
    expect(parseGoal({ goalId: "g", sessionID: "s", objective: "o", status: "running" })).toBeNull()
  })

  it("保留合法可选字段", () => {
    const goal = parseGoal({
      goalId: "g",
      sessionID: "s",
      objective: "o",
      status: "active",
      tokensUsed: 1,
      timeUsedSeconds: 2,
      createdAt: 3,
      updatedAt: 4,
      tokenBudget: 100,
      blockedStreak: 2,
    })
    expect(goal?.tokenBudget).toBe(100)
    expect(goal?.blockedStreak).toBe(2)
  })
})

describe("goal controller", () => {
  it("setGoal 覆盖旧目标并重置计数", async () => {
    const store = new MemoryStore()
    const c = controller(store)
    await c.setGoal(SESSION, "first")
    await c.accountUsage(SESSION, { tokens: 50, elapsedSeconds: 5 })
    const next = await c.setGoal(SESSION, "second", 1000)
    expect(next.objective).toBe("second")
    expect(next.tokensUsed).toBe(0)
    expect(next.tokenBudget).toBe(1000)
  })

  it("pause 只允许 active", async () => {
    const store = new MemoryStore()
    const c = controller(store)
    expect(await c.pauseGoal(SESSION)).toBeNull()

    await c.setGoal(SESSION, "x")
    await c.markComplete(SESSION)
    expect(await c.pauseGoal(SESSION)).toBeNull()
    expect((await c.getGoal(SESSION))?.status).toBe("complete")
  })

  it("resume 把 paused 拉回 active", async () => {
    const store = new MemoryStore()
    const c = controller(store)
    await c.setGoal(SESSION, "x")
    await c.pauseGoal(SESSION)
    const resumed = await c.resumeGoal(SESSION)
    expect(resumed?.status).toBe("active")
  })

  it("同一阻塞原因连续三次才 blocked", async () => {
    const store = new MemoryStore()
    const c = controller(store)
    await c.setGoal(SESSION, "x")

    expect((await c.markBlocked(SESSION, "no network"))?.status).toBe("active")
    expect((await c.markBlocked(SESSION, "no network"))?.status).toBe("active")
    const third = await c.markBlocked(SESSION, "no network")
    expect(third?.status).toBe("blocked")
    expect(third?.blockedStreak).toBe(3)
  })

  it("不同阻塞原因重置计数", async () => {
    const store = new MemoryStore()
    const c = controller(store)
    await c.setGoal(SESSION, "x")
    await c.markBlocked(SESSION, "a")
    await c.markBlocked(SESSION, "a")
    const other = await c.markBlocked(SESSION, "b")
    expect(other?.status).toBe("active")
    expect(other?.blockedStreak).toBe(1)
  })

  it("完成后清掉阻塞记录", async () => {
    const store = new MemoryStore()
    const c = controller(store)
    await c.setGoal(SESSION, "x")
    await c.markBlocked(SESSION, "a")
    const done = await c.markComplete(SESSION)
    expect(done?.lastBlockedReason).toBeUndefined()
    expect(done?.blockedStreak).toBeUndefined()
  })

  it("只给 active 目标记账", async () => {
    const store = new MemoryStore()
    const c = controller(store)
    await c.setGoal(SESSION, "x")
    await c.pauseGoal(SESSION)
    const after = await c.accountUsage(SESSION, { tokens: 100, elapsedSeconds: 10 })
    expect(after?.tokensUsed).toBe(0)
  })

  it("达到预算转 budget_limited", async () => {
    const store = new MemoryStore()
    const c = controller(store)
    await c.setGoal(SESSION, "x", 100)
    const after = await c.accountUsage(SESSION, { tokens: 120, elapsedSeconds: 3 })
    expect(after?.status).toBe("budget_limited")
    expect(after?.tokensUsed).toBe(120)
  })

  it("负数增量被忽略", async () => {
    const store = new MemoryStore()
    const c = controller(store)
    await c.setGoal(SESSION, "x")
    const after = await c.accountUsage(SESSION, { tokens: -5, elapsedSeconds: -2 })
    expect(after?.tokensUsed).toBe(0)
    expect(after?.timeUsedSeconds).toBe(0)
  })

  it("非有限增量被忽略", async () => {
    const store = new MemoryStore()
    const c = controller(store)
    await c.setGoal(SESSION, "x")
    const after = await c.accountUsage(SESSION, {
      tokens: Number.NaN,
      elapsedSeconds: Number.POSITIVE_INFINITY,
    })
    expect(after?.tokensUsed).toBe(0)
    expect(after?.timeUsedSeconds).toBe(0)
  })

  it("非法预算被忽略，不会一创建就 budget_limited", async () => {
    const store = new MemoryStore()
    const c = controller(store)
    for (const budget of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const goal = await c.setGoal(SESSION, "x", budget)
      expect(goal.tokenBudget).toBeUndefined()
    }
  })

  it("setGoalStatus 对不存在的目标返回 null", async () => {
    const store = new MemoryStore()
    expect(await setGoalStatus(store, SESSION, "paused")).toBeNull()
  })
})

describe("classifyGoalFailure", () => {
  it("402 视为余额不足", () => {
    expect(classifyGoalFailure({ type: "provider", message: "nope", status: 402 })).toBe("insufficient_funds")
  })

  it("关键词识别余额不足", () => {
    expect(classifyGoalFailure({ type: "quota", message: "quota exceeded" })).toBe("insufficient_funds")
  })

  it("关键词识别上下文超长", () => {
    expect(classifyGoalFailure({ message: "prompt is too long" })).toBe("token_limit")
    expect(classifyGoalFailure({ type: "ContextLengthError", message: "boom" })).toBe("token_limit")
  })

  it("其余归为 other", () => {
    expect(classifyGoalFailure(new Error("boom"))).toBe("other")
    expect(classifyGoalFailure(undefined)).toBe("other")
  })
})

describe("buildContinuationPrompt", () => {
  it("转义目标并带上预算", async () => {
    const store = new MemoryStore()
    const goal = await createGoal(store, SESSION, "a < b & c")
    const text = buildContinuationPrompt({ ...goal, tokensUsed: 10, tokenBudget: 100 })
    expect(text).toContain("a &lt; b &amp; c")
    expect(text).toContain("Budget: used 10 / 100; remaining 90.")
    expect(text).toContain('update_goal with status "complete"')
  })
})
