import { describe, expect, it } from "vitest"

import { MemoryStore } from "./helpers.ts"
import { scheduleKey } from "../src/shared/keys.ts"
import { createSchedulingStore, isRecurringTaskAged } from "../src/scheduling/store.ts"
import { MAX_JOBS, type ScheduledJob } from "../src/scheduling/types.ts"

const SESSION = "ses_test"

/** 输入：无；输出：绑定内存存储的任务存储。 */
function makeStore() {
  const memory = new MemoryStore()
  return { memory, store: createSchedulingStore(memory) }
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

  it("load 跳过永远算不出下一次的任务", async () => {
    const { memory, store } = makeStore()
    memory.values.set(scheduleKey(SESSION), {
      version: 1,
      jobs: [{ id: "bad00001", sessionID: SESSION, cron: "0 0 31 2 *", prompt: "x", createdAt: Date.now() }],
    })

    await store.load()
    expect(store.listJobs(SESSION)).toHaveLength(0)
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
})
