import type { Plugin } from "@opencode/plugin"
import { describe, expect, it } from "vitest"

import { MemoryStore, captureTimers, flushMicrotasks } from "./helpers.ts"
import { createSchedulingContinuation } from "../src/scheduling/continuation.ts"
import { createSchedulingStore } from "../src/scheduling/store.ts"
import { scheduleKey } from "../src/shared/keys.ts"

const SESSION = "ses_test"
/** 用真实时间附近的值，避免任务被 7 天过期规则误判。 */
const NOW = Date.now() + 1000

const roles = {
  isSubagent: () => Promise.resolve(false),
  forget: () => undefined,
}

/**
 * 输入：日志数组 + 是否让 prompt 失败 + 当前 agent + 可选 synthetic ID 日志 + 本实例位置。
 * 输出：只实现 setup 依赖的假上下文。
 */
function fakeCtx(
  log: string[],
  rejectPrompt = false,
  agent = "build",
  ids?: string[],
  location: { readonly directory: string; readonly workspaceID?: string } = { directory: "/work" },
): Plugin.Context {
  return {
    location,
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
    storage: {
      get: () => Promise.resolve(undefined),
      set: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      scan: () => Promise.resolve([]),
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

  it("多个实例触发同一次 one-shot 时只注入一次", async () => {
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

    expect(idsA.length + idsB.length).toBe(1)
    const injected = idsA[0] ?? idsB[0]
    expect(injected).toMatch(/^msg_cron_/)
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

  it("plan 模式跳过 one-shot 注入并顺延而不是删除", async () => {
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
    // 切回 build agent 后这次性任务还要能跑：只顺延，不删除。
    const kept = store.getJob(added.job.id)
    expect(kept).toBeDefined()
    expect(kept?.nextRunAt ?? 0).toBeGreaterThan(NOW)
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

  it("会话属于别的 location 时不注入，只丢本实例的内存任务", async () => {
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
      locateSession: () => Promise.resolve({ kind: "found", directory: "/other" }),
      now: () => NOW,
    })
    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })

    expect(log).toHaveLength(0)
    expect(store.count()).toBe(0)
    continuation.dispose()
  })

  it("同目录不同 workspaceID 时不注入，只丢本实例的内存任务", async () => {
    const log: string[] = []
    const store = makeStore()
    const added = await store.addJob({ sessionID: SESSION, cron: "* * * * *", prompt: "ping", recurring: true })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    makeDue(store, added.job.id)

    const continuation = createSchedulingContinuation({
      ctx: fakeCtx(log, false, "build", undefined, { directory: "/work", workspaceID: "ws_a" }),
      store,
      roles,
      shouldDefer: () => Promise.resolve(false),
      enabled: () => Promise.resolve(true),
      locateSession: () =>
        Promise.resolve({ kind: "found", directory: "/work", workspaceID: "ws_b" } as const),
      now: () => NOW,
    })
    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })

    expect(log).toHaveLength(0)
    expect(store.count()).toBe(0)
    continuation.dispose()
  })

  it("会话已不存在时丢掉内存任务", async () => {
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
      locateSession: () => Promise.resolve({ kind: "missing" }),
      now: () => NOW,
    })
    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })

    expect(log).toHaveLength(0)
    expect(store.count()).toBe(0)
    continuation.dispose()
  })

  it("timer 触发时先查归属：非归属实例不因功能关闭而顺延共享任务", async () => {
    const captured = captureTimers()
    try {
      const memory = new MemoryStore()
      const store = createSchedulingStore(memory)
      const added = await store.addJob({
        sessionID: SESSION,
        cron: "* * * * *",
        prompt: "ping",
        recurring: true,
        durable: true,
      })
      expect(added.ok).toBe(true)
      if (!added.ok) return
      makeDue(store, added.job.id)

      const continuation = createSchedulingContinuation({
        ctx: fakeCtx([], false, "build", undefined, { directory: "/work", workspaceID: "ws_a" }),
        store,
        roles,
        shouldDefer: () => Promise.resolve(false),
        // 旧实现先看 enabled 并 postpone；归属检查必须抢在它前面。
        enabled: () => Promise.resolve(false),
        locateSession: () =>
          Promise.resolve({ kind: "found", directory: "/work", workspaceID: "ws_b" } as const),
        now: () => NOW,
      })
      continuation.armTimers()
      captured.timers[0]?.run()
      await flushMicrotasks()

      expect(store.count()).toBe(0)
      const saved = memory.values.get(scheduleKey(SESSION)) as { jobs?: { retryAt?: number }[] } | undefined
      expect(saved?.jobs?.[0]?.retryAt).toBeUndefined()
      continuation.dispose()
    } finally {
      captured.restore()
    }
  })

  it("归属查询失败时 timer 触发不写共享任务", async () => {
    const captured = captureTimers()
    try {
      const memory = new MemoryStore()
      const store = createSchedulingStore(memory)
      const added = await store.addJob({
        sessionID: SESSION,
        cron: "* * * * *",
        prompt: "ping",
        recurring: true,
        durable: true,
      })
      expect(added.ok).toBe(true)
      if (!added.ok) return
      makeDue(store, added.job.id)

      const continuation = createSchedulingContinuation({
        ctx: fakeCtx([], false, "build", undefined, { directory: "/work", workspaceID: "ws_a" }),
        store,
        roles,
        shouldDefer: () => Promise.resolve(false),
        enabled: () => Promise.resolve(false),
        locateSession: () => Promise.resolve({ kind: "unknown" } as const),
        now: () => NOW,
      })
      continuation.armTimers()
      captured.timers[0]?.run()
      await flushMicrotasks()

      expect(store.getJob(added.job.id)).toBeDefined()
      const saved = memory.values.get(scheduleKey(SESSION)) as { jobs?: { retryAt?: number }[] } | undefined
      expect(saved?.jobs?.[0]?.retryAt).toBeUndefined()
      continuation.dispose()
    } finally {
      captured.restore()
    }
  })

  it("session.moved 到本实例时改写 durable 任务位置并恢复任务", async () => {
    const memory = new MemoryStore()
    memory.values.set(scheduleKey(SESSION), {
      version: 1,
      jobs: [
        {
          id: "a0000001",
          sessionID: SESSION,
          cron: "0 * * * *",
          prompt: "moved",
          createdAt: Date.now(),
          recurring: true,
          directory: "/old",
          workspaceID: "ws_a",
        },
      ],
    })
    const store = createSchedulingStore(memory, { directory: "/new", workspaceID: "ws_b" })
    const continuation = createSchedulingContinuation({
      ctx: fakeCtx([], false, "build", undefined, { directory: "/new", workspaceID: "ws_b" }),
      store,
      roles,
      shouldDefer: () => Promise.resolve(false),
      enabled: () => Promise.resolve(true),
      now: () => NOW,
    })

    await continuation.handle({
      type: "session.moved",
      data: { sessionID: SESSION, location: { directory: "/new", workspaceID: "ws_b" } },
    })

    expect(store.listJobs(SESSION)).toHaveLength(1)
    const saved = memory.values.get(scheduleKey(SESSION)) as
      | { jobs?: { directory?: string; workspaceID?: string }[] }
      | undefined
    expect(saved?.jobs?.[0]).toMatchObject({ directory: "/new", workspaceID: "ws_b" })
    continuation.dispose()
  })

  it("session.moved 离开本实例时只丢内存副本，不改写共享任务", async () => {
    const memory = new MemoryStore()
    memory.values.set(scheduleKey(SESSION), {
      version: 1,
      jobs: [
        {
          id: "a0000001",
          sessionID: SESSION,
          cron: "0 * * * *",
          prompt: "moved",
          createdAt: Date.now(),
          recurring: true,
          directory: "/old",
          workspaceID: "ws_a",
        },
      ],
    })
    const store = createSchedulingStore(memory, { directory: "/old", workspaceID: "ws_a" })
    await store.load()
    expect(store.count()).toBe(1)

    const continuation = createSchedulingContinuation({
      ctx: fakeCtx([], false, "build", undefined, { directory: "/old", workspaceID: "ws_a" }),
      store,
      roles,
      shouldDefer: () => Promise.resolve(false),
      enabled: () => Promise.resolve(true),
      now: () => NOW,
    })

    await continuation.handle({
      type: "session.moved",
      data: { sessionID: SESSION, location: { directory: "/new", workspaceID: "ws_b" } },
    })

    expect(store.count()).toBe(0)
    const saved = memory.values.get(scheduleKey(SESSION)) as
      | { jobs?: { directory?: string; workspaceID?: string }[] }
      | undefined
    expect(saved?.jobs?.[0]).toMatchObject({ directory: "/old", workspaceID: "ws_a" })
    continuation.dispose()
  })

  it("同目录 workspaceID 变化时新实例接管，旧实例不误写", async () => {
    const memory = new MemoryStore()
    memory.values.set(scheduleKey(SESSION), {
      version: 1,
      jobs: [
        {
          id: "a0000001",
          sessionID: SESSION,
          cron: "0 * * * *",
          prompt: "moved",
          createdAt: Date.now(),
          recurring: true,
          directory: "/work",
          workspaceID: "ws_a",
        },
      ],
    })
    const oldStore = createSchedulingStore(memory, { directory: "/work", workspaceID: "ws_a" })
    await oldStore.load()
    const newStore = createSchedulingStore(memory, { directory: "/work", workspaceID: "ws_b" })

    const oldContinuation = createSchedulingContinuation({
      ctx: fakeCtx([], false, "build", undefined, { directory: "/work", workspaceID: "ws_a" }),
      store: oldStore,
      roles,
      shouldDefer: () => Promise.resolve(false),
      enabled: () => Promise.resolve(true),
      now: () => NOW,
    })
    const newContinuation = createSchedulingContinuation({
      ctx: fakeCtx([], false, "build", undefined, { directory: "/work", workspaceID: "ws_b" }),
      store: newStore,
      roles,
      shouldDefer: () => Promise.resolve(false),
      enabled: () => Promise.resolve(true),
      now: () => NOW,
    })

    const moved = {
      type: "session.moved",
      data: { sessionID: SESSION, location: { directory: "/work", workspaceID: "ws_b" } },
    }
    await oldContinuation.handle(moved)
    expect(oldStore.count()).toBe(0)
    const beforeOwner = memory.values.get(scheduleKey(SESSION)) as
      | { jobs?: { workspaceID?: string }[] }
      | undefined
    expect(beforeOwner?.jobs?.[0]?.workspaceID).toBe("ws_a")

    await newContinuation.handle(moved)
    expect(newStore.count()).toBe(1)
    const afterOwner = memory.values.get(scheduleKey(SESSION)) as
      | { jobs?: { workspaceID?: string }[] }
      | undefined
    expect(afterOwner?.jobs?.[0]?.workspaceID).toBe("ws_b")

    oldContinuation.dispose()
    newContinuation.dispose()
  })

  it("会话查询失败时顺延，不消费任务", async () => {
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
      locateSession: () => Promise.resolve({ kind: "unknown" }),
      now: () => NOW,
    })
    await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })

    expect(log).toHaveLength(0)
    // 任务既没有被注入，也没有被删掉。
    expect(store.getJob(added.job.id)).toBeDefined()
    expect(store.getJob(added.job.id)?.lastFiredAt).toBeUndefined()
    continuation.dispose()
  })
})
