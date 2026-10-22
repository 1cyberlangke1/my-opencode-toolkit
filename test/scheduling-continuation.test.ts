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

/** 输入：日志数组；输出：只实现 session.prompt 的假上下文。 */
function fakeCtx(log: string[]): Plugin.Context {
  return {
    session: {
      prompt: (input: { text: string }) => {
        log.push(input.text)
        return Promise.resolve()
      },
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

  it("goal active 时让路", async () => {
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
    continuation.dispose()
  })

  it("功能关闭时不注入但仍重排", async () => {
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
    expect(store.getJob(added.job.id)).toBeDefined()
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
