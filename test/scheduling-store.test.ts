import { describe, expect, it } from "vitest"

import { MemoryStore } from "./helpers.ts"
import { scheduleKey } from "../src/shared/keys.ts"
import { createSchedulingStore, isRecurringTaskAged, type SchedulingStoreOptions } from "../src/scheduling/store.ts"
import { MAX_JOBS, type ScheduledJob } from "../src/scheduling/types.ts"

const SESSION = "ses_test"

/** 输入：可选 location 归属；输出：绑定内存存储的任务存储。 */
function makeStore(options: SchedulingStoreOptions = {}) {
  const memory = new MemoryStore()
  return { memory, store: createSchedulingStore(memory, options) }
}

describe("scheduling store", () => {
  it("新增 durable 任务会写存储", async () => {
    const { memory, store } = makeStore()
    const result = await store.addJob({
      sessionID: SESSION,
      cron: "*/5 * * * *",
      prompt: "check deploy",
      recurring: true,
      durable: true,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.job.nextRunAt).toBeGreaterThan(Date.now())
    expect(memory.values.has(scheduleKey(SESSION))).toBe(true)
    expect(store.listJobs(SESSION)).toHaveLength(1)
  })

  it("非 durable 任务不写存储", async () => {
    const { memory, store } = makeStore()
    await store.addJob({ sessionID: SESSION, cron: "*/5 * * * *", prompt: "x" })
    expect(memory.values.size).toBe(0)
    expect(store.listJobs(SESSION)).toHaveLength(1)
  })

  it("拒绝非法 cron 与空匹配", async () => {
    const { store } = makeStore()
    const bad = await store.addJob({ sessionID: SESSION, cron: "bad", prompt: "x" })
    expect(bad.ok).toBe(false)
  })

  it("重启后从存储恢复 durable 任务", async () => {
    const { memory, store } = makeStore()
    const added = await store.addJob({
      sessionID: SESSION,
      cron: "0 * * * *",
      prompt: "hourly",
      recurring: true,
      durable: true,
    })
    expect(added.ok).toBe(true)

    const restored = createSchedulingStore(memory)
    await restored.load()
    const jobs = restored.listJobs(SESSION)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.prompt).toBe("hourly")
    expect(jobs[0]?.durable).toBe(true)
    expect(jobs[0]?.nextRunAt).toBeGreaterThan(Date.now())
  })

  it("one-shot durable 保存稳定 fireAt，重启不重算 occurrence", async () => {
    const { memory, store } = makeStore()
    const added = await store.addJob({
      sessionID: SESSION,
      cron: "* * * * *",
      prompt: "喵",
      recurring: false,
      durable: true,
    })
    expect(added.ok).toBe(true)
    if (!added.ok) return

    const stored = memory.values.get(scheduleKey(SESSION)) as { jobs?: { fireAt?: number }[] } | undefined
    expect(stored?.jobs?.[0]?.fireAt).toBe(added.job.nextRunAt)

    const restored = createSchedulingStore(memory)
    await restored.load()
    expect(restored.getJob(added.job.id)?.nextRunAt).toBe(added.job.nextRunAt)
  })

  it("删除最后一个 durable 任务会清掉 key", async () => {
    const { memory, store } = makeStore()
    const added = await store.addJob({
      sessionID: SESSION,
      cron: "0 * * * *",
      prompt: "x",
      recurring: true,
      durable: true,
    })
    expect(added.ok).toBe(true)
    if (!added.ok) return

    await store.removeJobs([added.job.id])
    expect(memory.values.has(scheduleKey(SESSION))).toBe(false)
    expect(store.count()).toBe(0)
  })

  it("markFired 只重排 recurring 任务", async () => {
    const { store } = makeStore()
    const added = await store.addJob({
      sessionID: SESSION,
      cron: "0 * * * *",
      prompt: "x",
      recurring: true,
      durable: true,
    })
    expect(added.ok).toBe(true)
    if (!added.ok) return

    const before = added.job.nextRunAt
    // 用一个明显不同的时刻触发，保证落在下一个 cron 窗口。
    await store.markFired([added.job.id], Date.now() + 3_600_000)
    const job = store.getJob(added.job.id)
    expect(job?.lastFiredAt).toBeTypeOf("number")
    expect(job?.nextRunAt).not.toBe(before)
  })

  it("超过上限拒绝新增", async () => {
    const { store } = makeStore()
    for (let i = 0; i < MAX_JOBS; i += 1) {
      const result = await store.addJob({ sessionID: SESSION, cron: "0 * * * *", prompt: `job ${String(i)}` })
      expect(result.ok).toBe(true)
    }
    const overflow = await store.addJob({ sessionID: SESSION, cron: "0 * * * *", prompt: "one more" })
    expect(overflow.ok).toBe(false)
  })

  it("one-shot 过点后重启不补跑", async () => {
    const { memory, store } = makeStore()
    const now = Date.now()
    memory.values.set(scheduleKey(SESSION), {
      version: 1,
      jobs: [
        {
          id: "meow0001",
          sessionID: SESSION,
          cron: "* * * * *",
          prompt: "喵",
          createdAt: now - 120_000,
          fireAt: now - 60_000,
        },
      ],
    })

    await store.load()
    expect(store.listJobs(SESSION)).toHaveLength(0)
  })

  it("load 跳过永远算不出下一次的任务", async () => {
    const { memory, store } = makeStore()
    memory.values.set(scheduleKey(SESSION), {
      version: 1,
      jobs: [{ id: "bad00001", sessionID: SESSION, cron: "0 0 31 2 *", prompt: "x", createdAt: Date.now() }],
    })

    await store.load()
    expect(store.listJobs(SESSION)).toHaveLength(0)
  })

  it("近期一次性任务正常接受（跨年不再被启发式误拒）", async () => {
    const { store } = makeStore()
    // 旧实现用「跨年 + 距离 > 24h」判定过期，会把 12-29 建的 1 月 1 日任务误拒。
    // 现在只保留 7 天窗口，这里验证近期任务不会再被误杀。
    const soon = new Date(Date.now() + 120_000)
    const cron = `${String(soon.getMinutes())} ${String(soon.getHours())} ${String(soon.getDate())} ${String(soon.getMonth() + 1)} *`
    const result = await store.addJob({ sessionID: SESSION, cron, prompt: "soon", recurring: false })
    expect(result.ok).toBe(true)
  })

  it("一次性任务超过 7 天上限返回语义化错误", async () => {
    const { store } = makeStore()
    const now = new Date()
    const future = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000)
    if (future.getFullYear() === now.getFullYear()) {
      const cron = `${String(future.getMinutes())} ${String(future.getHours())} ${String(future.getDate())} ${String(future.getMonth() + 1)} *`
      const result = await store.addJob({ sessionID: SESSION, cron, prompt: "far", recurring: false })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain("cannot be scheduled more than 7 days in advance")
      }
    }
  })

  it("recurring 任务不受一次性任务跨度限制", async () => {
    const { store } = makeStore()
    const result = await store.addJob({ sessionID: SESSION, cron: "0 0 1 1 *", prompt: "yearly", recurring: true })
    expect(result.ok).toBe(true)
  })
})

describe("location 归属与并发写入", () => {
  /** 输入：目录/工作区；输出：一条可持久化的 recurring 任务。 */
  function storedJob(
    directory?: string,
    workspaceID?: string,
  ): {
    id: string
    sessionID: string
    cron: string
    prompt: string
    createdAt: number
    recurring: true
    directory?: string
    workspaceID?: string
  } {
    return {
      id: "a0000001",
      sessionID: SESSION,
      cron: "0 * * * *",
      prompt: "x",
      createdAt: Date.now(),
      recurring: true,
      ...(directory === undefined ? {} : { directory }),
      ...(workspaceID === undefined ? {} : { workspaceID }),
    }
  }

  /** 输入：内存存储；输出：存档里第一条任务的位置字段。 */
  function savedLocation(memory: MemoryStore): { directory?: string; workspaceID?: string } | undefined {
    const file = memory.values.get(scheduleKey(SESSION)) as
      | { jobs?: { directory?: string; workspaceID?: string }[] }
      | undefined
    return file?.jobs?.[0]
  }

  it("不加载别的 location 写入的任务", async () => {
    const { memory, store } = makeStore({ directory: "/mine" })
    memory.values.set(scheduleKey(SESSION), { version: 1, jobs: [storedJob("/other")] })

    await store.load()

    expect(store.listJobs(SESSION)).toHaveLength(0)
  })

  it("旧数据没有 directory 时照常加载", async () => {
    const { memory, store } = makeStore({ directory: "/mine" })
    memory.values.set(scheduleKey(SESSION), { version: 1, jobs: [storedJob()] })

    await store.load()

    expect(store.listJobs(SESSION)).toHaveLength(1)
  })

  it("会话 move 后按新位置恢复旧 durable 任务并改写存档位置", async () => {
    const memory = new MemoryStore()
    memory.values.set(scheduleKey(SESSION), { version: 1, jobs: [storedJob("/old", "ws_a")] })
    const store = createSchedulingStore(memory, {
      directory: "/new",
      workspaceID: "ws_b",
      sessionLocation: () => Promise.resolve({ directory: "/new", workspaceID: "ws_b" }),
    })

    await store.load()

    expect(store.listJobs(SESSION)).toHaveLength(1)
    expect(savedLocation(memory)).toMatchObject({ directory: "/new", workspaceID: "ws_b" })
  })

  it("非归属实例不加载也不改写 move 走的任务", async () => {
    const memory = new MemoryStore()
    memory.values.set(scheduleKey(SESSION), { version: 1, jobs: [storedJob("/old", "ws_a")] })
    const store = createSchedulingStore(memory, {
      directory: "/old",
      workspaceID: "ws_a",
      sessionLocation: () => Promise.resolve({ directory: "/new", workspaceID: "ws_b" }),
    })

    await store.load()

    expect(store.listJobs(SESSION)).toHaveLength(0)
    expect(savedLocation(memory)).toMatchObject({ directory: "/old", workspaceID: "ws_a" })
  })

  it("同目录 workspaceID 变化时新实例接管并改写工作区", async () => {
    const memory = new MemoryStore()
    memory.values.set(scheduleKey(SESSION), { version: 1, jobs: [storedJob("/work", "ws_a")] })
    const store = createSchedulingStore(memory, {
      directory: "/work",
      workspaceID: "ws_b",
      sessionLocation: () => Promise.resolve({ directory: "/work", workspaceID: "ws_b" }),
    })

    await store.load()

    expect(store.listJobs(SESSION)).toHaveLength(1)
    expect(savedLocation(memory)).toMatchObject({ directory: "/work", workspaceID: "ws_b" })
  })

  it("同目录旧工作区实例不加载也不改写已换工作区的任务", async () => {
    const memory = new MemoryStore()
    memory.values.set(scheduleKey(SESSION), { version: 1, jobs: [storedJob("/work", "ws_a")] })
    const store = createSchedulingStore(memory, {
      directory: "/work",
      workspaceID: "ws_a",
      sessionLocation: () => Promise.resolve({ directory: "/work", workspaceID: "ws_b" }),
    })

    await store.load()

    expect(store.listJobs(SESSION)).toHaveLength(0)
    expect(savedLocation(memory)).toMatchObject({ directory: "/work", workspaceID: "ws_a" })
  })

  it("旧存档没有 workspaceID 时仍按目录加载", async () => {
    const memory = new MemoryStore()
    memory.values.set(scheduleKey(SESSION), { version: 1, jobs: [storedJob("/work")] })
    const store = createSchedulingStore(memory, {
      directory: "/work",
      workspaceID: "ws_b",
      sessionLocation: () => Promise.resolve({ directory: "/work", workspaceID: "ws_b" }),
    })

    await store.load()

    expect(store.listJobs(SESSION)).toHaveLength(1)
  })

  it("会话已不存在时清掉孤儿 key", async () => {
    const { memory, store } = makeStore({
      directory: "/mine",
      sessionLocation: () => Promise.resolve(null),
    })
    memory.values.set(scheduleKey("ses_gone"), { version: 1, jobs: [storedJob("/mine")] })

    await store.load()

    expect(memory.values.has(scheduleKey("ses_gone"))).toBe(false)
  })

  it("会话查询失败时不删数据", async () => {
    const { memory, store } = makeStore({
      directory: "/mine",
      sessionLocation: () => Promise.resolve(undefined),
    })
    memory.values.set(scheduleKey(SESSION), { version: 1, jobs: [storedJob("/mine")] })

    await store.load()

    expect(memory.values.has(scheduleKey(SESSION))).toBe(true)
  })

  it("新增任务不会覆盖别的实例刚写入的任务", async () => {
    // 两个实例共享同一份存储；第二个实例从未 load，内存视图是空的。
    const memory = new MemoryStore()
    const first = createSchedulingStore(memory, { directory: "/mine" })
    const second = createSchedulingStore(memory, { directory: "/mine" })

    const addedFirst = await first.addJob({
      sessionID: SESSION,
      cron: "0 * * * *",
      prompt: "from first",
      recurring: true,
      durable: true,
    })
    const addedSecond = await second.addJob({
      sessionID: SESSION,
      cron: "0 * * * *",
      prompt: "from second",
      recurring: true,
      durable: true,
    })
    expect(addedFirst.ok).toBe(true)
    expect(addedSecond.ok).toBe(true)

    const stored = memory.values.get(scheduleKey(SESSION)) as { jobs?: { prompt?: string }[] } | undefined
    expect(stored?.jobs?.map((job) => job.prompt).sort()).toEqual(["from first", "from second"])
  })

  it("两个实例并发新增不会互相覆盖", async () => {
    // 同一份存储、两个实例同时「读最新 → 追加 → 写回」；没有进程级串行时后写会吞掉前一个。
    const memory = new MemoryStore()
    const first = createSchedulingStore(memory, { directory: "/mine" })
    const second = createSchedulingStore(memory, { directory: "/mine" })

    const [addedFirst, addedSecond] = await Promise.all([
      first.addJob({ sessionID: SESSION, cron: "0 * * * *", prompt: "first", recurring: true, durable: true }),
      second.addJob({ sessionID: SESSION, cron: "0 * * * *", prompt: "second", recurring: true, durable: true }),
    ])
    expect(addedFirst.ok).toBe(true)
    expect(addedSecond.ok).toBe(true)

    const stored = memory.values.get(scheduleKey(SESSION)) as { jobs?: { prompt?: string }[] } | undefined
    expect(stored?.jobs?.map((job) => job.prompt).sort()).toEqual(["first", "second"])
  })

  it("forget 只丢内存副本，不动存储", async () => {
    const { memory, store } = makeStore({ directory: "/mine" })
    const added = await store.addJob({
      sessionID: SESSION,
      cron: "0 * * * *",
      prompt: "x",
      recurring: true,
      durable: true,
    })
    expect(added.ok).toBe(true)
    if (!added.ok) return

    store.forget([added.job.id])

    expect(store.count()).toBe(0)
    expect(memory.values.has(scheduleKey(SESSION))).toBe(true)
  })
})

describe("isRecurringTaskAged", () => {
  const base: ScheduledJob = {
    id: "abcdef12",
    sessionID: SESSION,
    cron: "0 * * * *",
    prompt: "x",
    createdAt: 0,
  }

  it("recurring 超过 7 天算过期", () => {
    const aged = { ...base, recurring: true }
    expect(isRecurringTaskAged(aged, 8 * 24 * 60 * 60 * 1000)).toBe(true)
    expect(isRecurringTaskAged(aged, 24 * 60 * 60 * 1000)).toBe(false)
  })

  it("one-shot 与 permanent 不过期", () => {
    expect(isRecurringTaskAged({ ...base }, 8 * 24 * 60 * 60 * 1000)).toBe(false)
    expect(isRecurringTaskAged({ ...base, recurring: true, permanent: true }, 8 * 24 * 60 * 60 * 1000)).toBe(false)
  })

  it("一次性任务记录准点 requestedAt，提前量只改 fireAt", async () => {
    const { store } = makeStore()
    // 分钟为 0 时 one-shot 会带提前量；requestedAt 必须是用户请求的准点。
    const result = await store.addJob({ sessionID: SESSION, cron: "0 9 * * *", prompt: "standup", recurring: false })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const requested = new Date(result.job.requestedAt ?? 0)
    expect(requested.getHours()).toBe(9)
    expect(requested.getMinutes()).toBe(0)
    expect(result.job.fireAt ?? 0).toBeLessThanOrEqual(result.job.requestedAt ?? 0)
  })

  it("投递前落盘的 lastAttemptAt 让重启后不重复同一次触发", async () => {
    const { memory, store } = makeStore()
    const added = await store.addJob({
      sessionID: SESSION,
      cron: "*/5 * * * *",
      prompt: "ping",
      recurring: true,
      durable: true,
    })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    const fired = Date.now()
    await store.markAttempted(added.job.id, fired)
    const restarted = createSchedulingStore(memory)
    await restarted.load()
    // 没有 lastAttemptAt 时旧逻辑会按旧 lastFiredAt 把同一次再排出来；这里至少不能早于尝试时刻。
    const next = restarted.getJob(added.job.id)?.nextRunAt ?? 0
    expect(next).toBeGreaterThan(fired)
  })
})
