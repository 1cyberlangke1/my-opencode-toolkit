import type { Plugin } from "@opencode/plugin"
import { describe, expect, it } from "vitest"

import { MemoryStore } from "./helpers.ts"
import { createSchedulingContinuation } from "../src/scheduling/continuation.ts"
import { createSchedulingStore } from "../src/scheduling/store.ts"

const SESSION = "ses_test"
/** 用真实时间附近的值，避免任务被 7 天过期规则误判。 */
const NOW = Date.now() + 1000

const roles = {
  isSubagent: () => Promise.resolve(false),
  forget: () => undefined,
}

/**
 * 输入：日志数组 + 是否让 prompt 失败 + 当前 agent + 可选 synthetic ID 日志。
 * 输出：只实现 setup 依赖的假上下文。
 */
function fakeCtx(
  log: string[],
  rejectPrompt = false,
  agent = "build",
  ids?: string[],
): Plugin.Context {
  return {
    session: {
      get: () => Promise.resolve({ agent }),
      prompt: (input: { text: string }) => {
        if (rejectPrompt) return Promise.reject(new Error("session busy"))
        log.push(input.text)
        return Promise.resolve()
      },
      synthetic: (input: { text: string; id?: string }) => {
        if (rejectPrompt) return Promise.reject(new Error("session busy"))
        if (ids !== undefined) ids.push(input.id ?? "")
        log.push(input.text)
        return Promise.resolve()
      },
      context: () => Promise.resolve([]),
    },
  } as unknown as Plugin.Context
}

/** 输入：无；输出：绑定内存存储的任务存储。 */
function makeStore() {
  return createSchedulingStore(new MemoryStore())
}

/** 输入：任务 id 列表 + 存储；输出：无。预期：把 nextRunAt 推到过去，制造已到点。 */
function makeDue(store: ReturnType<typeof makeStore>, id: string): void {
  const job = store.getJob(id)
  if (job !== undefined) job.nextRunAt = NOW - 1000
}

describe("scheduling continuation", () => {
  it("idle 时触发已到点任务并注入", async () => {
    const log: string[] = []
    const store = makeStore()
    const added = await store.addJob({ sessionID: SESSION, cron: "* * * * *", prompt: "ping", recurring: true })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    makeDue(store, added.job.id)

    const continuation = createSchedulingContinuation({
      ctx: fakeCtx(log),
      store,
      roles,
      shouldDefer: () => Promise.resolve(false),
      enabled: () => Promise.resolve(true),
      now: () => NOW,
    })
    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })

    expect(log).toHaveLength(1)
    expect(log[0]).toContain("Running scheduled task")
    expect(log[0]).toContain("ping")
    continuation.dispose()
  })

  it("两个会话的到点任务互不影响", async () => {
    const log: string[] = []
    const store = makeStore()
    const a = await store.addJob({ sessionID: "ses_a", cron: "* * * * *", prompt: "job-a", recurring: true })
    const b = await store.addJob({ sessionID: "ses_b", cron: "* * * * *", prompt: "job-b", recurring: true })
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    makeDue(store, a.job.id)
    makeDue(store, b.job.id)

    const continuation = createSchedulingContinuation({
      ctx: fakeCtx(log),
      store,
      roles,
      shouldDefer: () => Promise.resolve(false),
      enabled: () => Promise.resolve(true),
      now: () => NOW,
    })

    await continuation.handle({ type: "session.idle", data: { sessionID: "ses_a" } })
    expect(log).toHaveLength(1)
    expect(log[0]).toContain("job-a")
    // A 是 recurring，触发后重排；B 仍保持到点状态，等自己的会话 idle。
    expect(store.getJob(a.job.id)?.nextRunAt).toBeGreaterThan(NOW)
    expect(store.getJob(b.job.id)?.nextRunAt).toBeLessThanOrEqual(NOW)

    await continuation.handle({ type: "session.idle", data: { sessionID: "ses_b" } })
    expect(log).toHaveLength(2)
    expect(log[1]).toContain("job-b")
    expect(store.getJob(b.job.id)?.nextRunAt).toBeGreaterThan(NOW)
    continuation.dispose()
  })

  it("session.execution.succeeded 也触发已到点任务", async () => {
    const log: string[] = []
    const store = makeStore()
    const added = await store.addJob({ sessionID: SESSION, cron: "* * * * *", prompt: "ping", recurring: true })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    makeDue(store, added.job.id)

    const continuation = createSchedulingContinuation({
      ctx: fakeCtx(log),
      store,
      roles,
      shouldDefer: () => Promise.resolve(false),
      enabled: () => Promise.resolve(true),
      now: () => NOW,
    })
    await continuation.handle({ type: "session.execution.succeeded", data: { sessionID: SESSION } })

    expect(log).toHaveLength(1)
    expect(log[0]).toContain("ping")
    continuation.dispose()
  })

  it("one-shot 触发后自删", async () => {
    const log: string[] = []
    const store = makeStore()
    const added = await store.addJob({ sessionID: SESSION, cron: "* * * * *", prompt: "once", recurring: false })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    makeDue(store, added.job.id)

    const continuation = createSchedulingContinuation({
      ctx: fakeCtx(log),
      store,
      roles,
      shouldDefer: () => Promise.resolve(false),
      enabled: () => Promise.resolve(true),
      now: () => NOW,
    })
    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })

    expect(store.getJob(added.job.id)).toBeUndefined()
    expect(log).toHaveLength(1)
    continuation.dispose()
  })

  it("多个实例触发同一次 one-shot 时使用相同 synthetic id", async () => {
    const shared = new MemoryStore()
    const storeA = createSchedulingStore(shared)
    const added = await storeA.addJob({
      sessionID: SESSION,
      cron: "* * * * *",
      prompt: "once",
      recurring: false,
      durable: true,
    })
    expect(added.ok).toBe(true)
    if (!added.ok) return

    // 模拟热重载后两个插件实例各自持有一份 durable 任务快照。
    const storeB = createSchedulingStore(shared)
    await storeB.load()
    makeDue(storeA, added.job.id)
    makeDue(storeB, added.job.id)

    const idsA: string[] = []
    const idsB: string[] = []
    const a = createSchedulingContinuation({
      ctx: fakeCtx([], false, "build", idsA),
      store: storeA,
      roles,
      shouldDefer: () => Promise.resolve(false),
      enabled: () => Promise.resolve(true),
      now: () => NOW,
    })
    const b = createSchedulingContinuation({
      ctx: fakeCtx([], false, "build", idsB),
      store: storeB,
      roles,
      shouldDefer: () => Promise.resolve(false),
      enabled: () => Promise.resolve(true),
      now: () => NOW,
    })

    await a.handle({ type: "session.idle", data: { sessionID: SESSION } })
    await b.handle({ type: "session.idle", data: { sessionID: SESSION } })

    expect(idsA).toHaveLength(1)
    expect(idsB).toHaveLength(1)
    expect(idsA[0]).toMatch(/^msg_cron_/)
    expect(idsA[0]).toBe(idsB[0])
    a.dispose()
    b.dispose()
  })

  it("recurring 触发后重排，不会重复 fire", async () => {
    const log: string[] = []
    const store = makeStore()
    const added = await store.addJob({ sessionID: SESSION, cron: "0 * * * *", prompt: "hourly", recurring: true })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    makeDue(store, added.job.id)

    const continuation = createSchedulingContinuation({
      ctx: fakeCtx(log),
      store,
      roles,
      shouldDefer: () => Promise.resolve(false),
      enabled: () => Promise.resolve(true),
      now: () => NOW,
    })
    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })

    expect(log).toHaveLength(1)
    expect(store.getJob(added.job.id)?.nextRunAt).toBeGreaterThan(NOW)
    continuation.dispose()
  })

  it("子代理会话不注入", async () => {
    const log: string[] = []
    const store = makeStore()
    const added = await store.addJob({ sessionID: SESSION, cron: "* * * * *", prompt: "ping", recurring: true })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    makeDue(store, added.job.id)

    const continuation = createSchedulingContinuation({
      ctx: fakeCtx(log),
      store,
      roles: { isSubagent: () => Promise.resolve(true), forget: () => undefined },
      shouldDefer: () => Promise.resolve(false),
      enabled: () => Promise.resolve(true),
      now: () => NOW,
    })
    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })

    expect(log).toHaveLength(0)
    continuation.dispose()
  })

  it("goal active 时让路且不消费任务", async () => {
    const log: string[] = []
    const store = makeStore()
    const added = await store.addJob({ sessionID: SESSION, cron: "* * * * *", prompt: "ping", recurring: true })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    makeDue(store, added.job.id)

    const continuation = createSchedulingContinuation({
      ctx: fakeCtx(log),
      store,
      roles,
      shouldDefer: () => Promise.resolve(true),
      enabled: () => Promise.resolve(true),
      now: () => NOW,
    })
    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })

    expect(log).toHaveLength(0)
    const job = store.getJob(added.job.id)
    expect(job).toBeDefined()
    expect(job?.nextRunAt).toBeGreaterThan(NOW)
    continuation.dispose()
  })

  it("plan 模式跳过注入并弹提示，但仍按原计划重排", async () => {
    const log: string[] = []
    const skipped: string[] = []
    const store = makeStore()
    const added = await store.addJob({ sessionID: SESSION, cron: "0 * * * *", prompt: "ping", recurring: true })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    makeDue(store, added.job.id)

    const continuation = createSchedulingContinuation({
      ctx: fakeCtx(log, false, "plan"),
      store,
      roles,
      shouldDefer: () => Promise.resolve(false),
      enabled: () => Promise.resolve(true),
      notifySkipped: (kind) => skipped.push(kind),
      now: () => NOW,
    })
    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })

    expect(log).toHaveLength(0)
    expect(skipped).toEqual(["cron"])
    const job = store.getJob(added.job.id)
    expect(job).toBeDefined()
    expect(job?.nextRunAt).toBeGreaterThan(NOW)
    continuation.dispose()
  })

  it("plan 模式跳过 one-shot 注入并按原计划消费", async () => {
    const log: string[] = []
    const skipped: string[] = []
    const store = makeStore()
    const added = await store.addJob({ sessionID: SESSION, cron: "* * * * *", prompt: "once", recurring: false })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    makeDue(store, added.job.id)

    const continuation = createSchedulingContinuation({
      ctx: fakeCtx(log, false, "plan"),
      store,
      roles,
      shouldDefer: () => Promise.resolve(false),
      enabled: () => Promise.resolve(true),
      notifySkipped: (kind) => skipped.push(kind),
      now: () => NOW,
    })
    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })

    expect(log).toHaveLength(0)
    expect(skipped).toEqual(["cron"])
    expect(store.getJob(added.job.id)).toBeUndefined()
    continuation.dispose()
  })

  it("功能关闭时 one-shot 不被消费", async () => {
    const log: string[] = []
    const store = makeStore()
    const added = await store.addJob({ sessionID: SESSION, cron: "* * * * *", prompt: "once", recurring: false })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    makeDue(store, added.job.id)

    const continuation = createSchedulingContinuation({
      ctx: fakeCtx(log),
      store,
      roles,
      shouldDefer: () => Promise.resolve(false),
      enabled: () => Promise.resolve(false),
      now: () => NOW,
    })
    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })

    expect(log).toHaveLength(0)
    expect(store.getJob(added.job.id)).toBeDefined()
    continuation.dispose()
  })

  it("注入失败时 one-shot 顺延而不是丢失", async () => {
    const log: string[] = []
    const store = makeStore()
    const added = await store.addJob({ sessionID: SESSION, cron: "* * * * *", prompt: "once", recurring: false })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    makeDue(store, added.job.id)

    const continuation = createSchedulingContinuation({
      ctx: fakeCtx(log, true),
      store,
      roles,
      shouldDefer: () => Promise.resolve(false),
      enabled: () => Promise.resolve(true),
      now: () => NOW,
    })
    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })

    expect(log).toHaveLength(0)
    const job = store.getJob(added.job.id)
    expect(job).toBeDefined()
    expect(job?.nextRunAt).toBeGreaterThan(NOW)
    continuation.dispose()
  })

  it("执行失败后清掉 pending，后续任务还能注入", async () => {
    const log: string[] = []
    const store = makeStore()
    const added = await store.addJob({ sessionID: SESSION, cron: "* * * * *", prompt: "ping", recurring: true })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    makeDue(store, added.job.id)

    const continuation = createSchedulingContinuation({
      ctx: fakeCtx(log),
      store,
      roles,
      shouldDefer: () => Promise.resolve(false),
      enabled: () => Promise.resolve(true),
      now: () => NOW,
    })
    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })
    expect(log).toHaveLength(1)

    await continuation.handle({ type: "session.execution.failed", data: { sessionID: SESSION } })
    makeDue(store, added.job.id)
    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })

    expect(log).toHaveLength(2)
    continuation.dispose()
  })

  it("功能关闭时不注入也不推进 lastFiredAt", async () => {
    const log: string[] = []
    const store = makeStore()
    const added = await store.addJob({ sessionID: SESSION, cron: "0 * * * *", prompt: "ping", recurring: true })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    makeDue(store, added.job.id)

    const continuation = createSchedulingContinuation({
      ctx: fakeCtx(log),
      store,
      roles,
      shouldDefer: () => Promise.resolve(false),
      enabled: () => Promise.resolve(false),
      now: () => NOW,
    })
    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })

    expect(log).toHaveLength(0)
    expect(store.getJob(added.job.id)?.lastFiredAt).toBeUndefined()
    continuation.dispose()
  })

  it("删除会话清掉该会话任务", async () => {
    const store = makeStore()
    const added = await store.addJob({ sessionID: SESSION, cron: "0 * * * *", prompt: "ping", recurring: true })
    expect(added.ok).toBe(true)

    const continuation = createSchedulingContinuation({
      ctx: fakeCtx([]),
      store,
      roles,
      shouldDefer: () => Promise.resolve(false),
      enabled: () => Promise.resolve(true),
      now: () => NOW,
    })
    await continuation.handle({ type: "session.deleted", data: { sessionID: SESSION } })

    expect(store.listJobs(SESSION)).toHaveLength(0)
    continuation.dispose()
  })
})
