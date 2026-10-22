import { randomUUID } from "node:crypto"

import { asRecord, type ScannableStore } from "../shared/json.ts"
import { SCHEDULE_PREFIX, scheduleKey } from "../shared/keys.ts"
import { forEachScannedEntry } from "../shared/scan.ts"
import {
  DEFAULT_CRON_JITTER_CONFIG,
  jitteredNextCronRunMs,
  nextCronRunMs,
  oneShotJitteredNextCronRunMs,
  parseCronExpression,
} from "./cron.ts"
import { JOB_ID_LENGTH, MAX_JOBS, type ScheduledJob } from "./types.ts"

/** 存储格式版本。 */
const STORE_VERSION = 1

/** 磁盘上的任务形状：没有运行时字段。 */
type StoredJob = {
  readonly id: string
  readonly sessionID: string
  readonly cron: string
  readonly prompt: string
  readonly createdAt: number
  readonly lastFiredAt?: number
  readonly recurring?: boolean
  readonly permanent?: boolean
}

type StoredFile = {
  readonly version: number
  readonly jobs: StoredJob[]
}

/** 新增任务的输入。 */
export type AddJobInput = {
  readonly sessionID: string
  readonly cron: string
  readonly prompt: string
  readonly recurring?: boolean
  readonly durable?: boolean
  readonly permanent?: boolean
}

/** 新增任务的结果。 */
export type AddJobResult = { ok: true; job: ScheduledJob } | { ok: false; error: string }

/** 定时任务存储。 */
export type SchedulingStore = {
  /** 输入：无；输出：无。预期：从存储恢复任务并重建 nextRunAt，幂等。 */
  load(): Promise<void>
  /** 输入：任务字段；输出：新任务或错误。预期：校验 cron、匹配性与上限。 */
  addJob(input: AddJobInput): Promise<AddJobResult>
  /** 输入：会话 ID（可省）；输出：任务列表。 */
  listJobs(sessionID?: string): ScheduledJob[]
  /** 输入：任务 id；输出：任务或 undefined。 */
  getJob(id: string): ScheduledJob | undefined
  /** 输入：任务 id 列表；输出：无。预期：删除并同步持久化。 */
  removeJobs(ids: string[]): Promise<void>
  /** 输入：任务 id 列表 + 触发时刻；输出：无。预期：recurring 重排下一次。 */
  markFired(ids: string[], firedAt: number): Promise<void>
  /** 输入：无；输出：内存中任务总数。 */
  count(): number
}

/**
 * 输入：可扫描存储。
 * 输出：定时任务存储。
 * 预期：durable 任务写 `schedule:<sessionID>`；非 durable 只留内存。
 */
export function createSchedulingStore(store: ScannableStore): SchedulingStore {
  const jobs = new Map<string, ScheduledJob>()

  /** 输入：任务；输出：下一次触发毫秒。预期：recurring 带正向抖动，one-shot 带提前量。 */
  const computeNext = (job: ScheduledJob, fromMs: number): number | null =>
    job.recurring === true
      ? jitteredNextCronRunMs(job.cron, fromMs, job.id)
      : oneShotJitteredNextCronRunMs(job.cron, fromMs, job.id)

  /** 输入：任务；输出：可持久化形状。预期：剥离 durable/nextRunAt 等运行时字段。 */
  const toStored = (job: ScheduledJob): StoredJob => ({
    id: job.id,
    sessionID: job.sessionID,
    cron: job.cron,
    prompt: job.prompt,
    createdAt: job.createdAt,
    ...(job.lastFiredAt === undefined ? {} : { lastFiredAt: job.lastFiredAt }),
    ...(job.recurring === true ? { recurring: true } : {}),
    ...(job.permanent === true ? { permanent: true } : {}),
  })

  /** 输入：会话 ID；输出：无。预期：只写 durable 任务；没有 durable 任务时删 key。 */
  const persist = async (sessionID: string): Promise<void> => {
    const durable = [...jobs.values()].filter((job) => job.sessionID === sessionID && job.durable !== false)
    if (durable.length === 0) {
      await store.remove(scheduleKey(sessionID))
      return
    }
    const file: StoredFile = { version: STORE_VERSION, jobs: durable.map(toStored) }
    await store.set(scheduleKey(sessionID), file)
  }

  /** 输入：任意值；输出：合法任务或 null。预期：跳过字段缺失/类型错误的条目。 */
  const parseStored = (value: unknown): StoredJob | null => {
    const record = asRecord(value)
    if (record === undefined) return null
    const { id, sessionID, cron, prompt, createdAt } = record
    if (typeof id !== "string" || id.length === 0) return null
    if (typeof sessionID !== "string" || sessionID.length === 0) return null
    if (typeof cron !== "string" || parseCronExpression(cron) === null) return null
    if (typeof prompt !== "string") return null
    if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null
    const lastFiredAt = record["lastFiredAt"]
    return {
      id,
      sessionID,
      cron,
      prompt,
      createdAt,
      ...(typeof lastFiredAt === "number" && Number.isFinite(lastFiredAt) ? { lastFiredAt } : {}),
      ...(record["recurring"] === true ? { recurring: true } : {}),
      ...(record["permanent"] === true ? { permanent: true } : {}),
    }
  }

  return {
    async load() {
      await forEachScannedEntry(store, SCHEDULE_PREFIX, (entry) => {
        const record = asRecord(entry.value)
        if (record === undefined) return Promise.resolve()
        const rawJobs = record["jobs"]
        if (!Array.isArray(rawJobs)) return Promise.resolve()

        for (const raw of rawJobs) {
          const stored = parseStored(raw)
          if (stored === null) continue
          const job: ScheduledJob = { ...stored, durable: true }
          const next = computeNext(job, job.lastFiredAt ?? job.createdAt)
          if (next !== null) job.nextRunAt = next
          jobs.set(job.id, job)
        }
        return Promise.resolve()
      })
    },

    async addJob(input) {
      const { sessionID, cron, prompt, recurring = false, durable = false, permanent = false } = input
      if (parseCronExpression(cron) === null) {
        return { ok: false, error: `Invalid cron expression '${cron}'. Expected 5 fields: M H DoM Mon DoW.` }
      }
      if (nextCronRunMs(cron, Date.now()) === null) {
        return { ok: false, error: `Cron expression '${cron}' does not match any calendar date in the next year.` }
      }
      const sessionJobs = [...jobs.values()].filter((job) => job.sessionID === sessionID).length
      if (sessionJobs >= MAX_JOBS) {
        return { ok: false, error: `Too many scheduled jobs (max ${String(MAX_JOBS)} per session). Cancel one first.` }
      }

      const now = Date.now()
      const job: ScheduledJob = {
        id: randomUUID().slice(0, JOB_ID_LENGTH),
        sessionID,
        cron,
        prompt,
        createdAt: now,
        ...(recurring ? { recurring: true } : {}),
        ...(permanent ? { permanent: true } : {}),
        durable,
      }
      const next = computeNext(job, now)
      if (next !== null) job.nextRunAt = next
      jobs.set(job.id, job)
      if (durable) await persist(sessionID)
      return { ok: true, job }
    },

    listJobs(sessionID) {
      const all = [...jobs.values()]
      return sessionID === undefined ? all : all.filter((job) => job.sessionID === sessionID)
    },

    getJob(id) {
      return jobs.get(id)
    },

    async removeJobs(ids) {
      const touched = new Set<string>()
      for (const id of ids) {
        const job = jobs.get(id)
        if (job === undefined) continue
        touched.add(job.sessionID)
        jobs.delete(id)
      }
      for (const sessionID of touched) await persist(sessionID)
    },

    async markFired(ids, firedAt) {
      const touched = new Set<string>()
      for (const id of ids) {
        const job = jobs.get(id)
        if (job?.recurring !== true) continue
        touched.add(job.sessionID)
        job.lastFiredAt = firedAt
        const next = computeNext(job, firedAt)
        if (next !== null) job.nextRunAt = next
      }
      for (const sessionID of touched) await persist(sessionID)
    },

    count() {
      return jobs.size
    },
  }
}

/**
 * 输入：任务 + 当前时刻。
 * 输出：是否已过 7 天自动过期。
 * 预期：one-shot、permanent 与 `maxAgeMs === 0` 都不过期。
 */
export function isRecurringTaskAged(
  task: ScheduledJob,
  nowMs: number,
  maxAgeMs: number = DEFAULT_CRON_JITTER_CONFIG.recurringMaxAgeMs,
): boolean {
  if (maxAgeMs === 0) return false
  return task.recurring === true && task.permanent !== true && nowMs - task.createdAt >= maxAgeMs
}
