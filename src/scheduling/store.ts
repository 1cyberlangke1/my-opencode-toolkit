import { randomUUID } from "node:crypto"

import { asRecord, type ScannableStore } from "../shared/json.ts"
import { SCHEDULE_PREFIX, scheduleKey } from "../shared/keys.ts"
import { forEachScannedEntry } from "../shared/scan.ts"
import { globalSerialRegistry, runSerial } from "../shared/serial.ts"
import { sameLocation, type SessionIdentity } from "../shared/session.ts"
import {
  DEFAULT_CRON_JITTER_CONFIG,
  jitteredNextCronRunMs,
  nextCronRunMs,
  oneShotJitteredNextCronRunMs,
  parseCronExpression,
} from "./cron.ts"
import { DEFAULT_MAX_AGE_DAYS, JOB_ID_LENGTH, MAX_JOBS, type ScheduledJob } from "./types.ts"

/** 存储格式版本。 */
const STORE_VERSION = 1

/**
 * 进程级写队列：键是 `schedule:<sessionID>`。
 * 同一份存档的「读最新 → 改 → 写回」必须串行，否则两个实例并发写会丢任务。
 * 挂到 globalThis，热重载后仍然共享。
 */
const writeChains = globalSerialRegistry(Symbol.for("my-opencode-toolkit.schedule-writes"))

/** 磁盘上的任务形状：没有运行时字段。 */
type StoredJob = {
  readonly id: string
  readonly sessionID: string
  readonly cron: string
  readonly prompt: string
  readonly createdAt: number
  readonly lastFiredAt?: number
  readonly fireAt?: number
  readonly retryAt?: number
  readonly requestedAt?: number
  readonly lastAttemptAt?: number
  readonly recurring?: boolean
  readonly permanent?: boolean
  /** 创建任务时的 location 目录；旧数据没有这个字段。 */
  readonly directory?: string
  /** 创建任务时的 workspaceID；旧数据没有这个字段。 */
  readonly workspaceID?: string
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
  /** 输入：任务 id + 尝试时刻；输出：无。预期：投递前落盘，崩溃重启后不重复同一次。 */
  markAttempted(id: string, at: number): Promise<void>
  /** 输入：任务 id + 顺延时刻；输出：无。预期：落盘 retryAt，重启后仍按这个时间重试。 */
  postpone(id: string, at: number): Promise<void>
  /**
   * 输入：会话 ID + 新 location；输出：无。
   * 预期：把该会话 durable 任务的位置字段改到新 location，并载入本实例内存；旧存档照常可读。
   *       调用方必须先确认本实例是新 location 的归属者。
   */
  relocate(sessionID: string, location: SessionIdentity): Promise<void>
  /** 输入：任务 id 列表；输出：无。预期：只丢内存副本，不碰存储（任务属于别的 location）。 */
  forget(ids: readonly string[]): void
  /** 输入：无；输出：内存中任务总数。 */
  count(): number
}

/** 存储的 location 归属检查。 */
export type SchedulingStoreOptions = {
  /** 本实例 location；写入任务时记录目录，读取时丢弃别的目录的任务。 */
  readonly directory?: string
  /** 本实例 workspaceID；缺省表示旧版按目录归属。 */
  readonly workspaceID?: string
  /** 输入：会话 ID；输出：会话当前 location、`null`（已不存在）或 `undefined`（查询失败）。 */
  readonly sessionLocation?: (sessionID: string) => Promise<SessionIdentity | null | undefined>
}

/**
 * 输入：可扫描存储 + 可选 location 归属。
 * 输出：定时任务存储。
 * 预期：durable 任务写 `schedule:<sessionID>`；非 durable 只留内存。
 *       记账一律「读最新存档 → 改 → 写回」，不再用实例内存里的陈旧快照整体覆盖共享存储。
 */
export function createSchedulingStore(
  store: ScannableStore,
  options: SchedulingStoreOptions = {},
): SchedulingStore {
  const jobs = new Map<string, ScheduledJob>()
  const directory = options.directory
  const sessionLocation = options.sessionLocation
  const instanceLocation: SessionIdentity | undefined =
    directory === undefined
      ? undefined
      : { directory, ...(options.workspaceID === undefined ? {} : { workspaceID: options.workspaceID }) }

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
    ...(job.fireAt === undefined ? {} : { fireAt: job.fireAt }),
    ...(job.retryAt === undefined ? {} : { retryAt: job.retryAt }),
    ...(job.requestedAt === undefined ? {} : { requestedAt: job.requestedAt }),
    ...(job.lastAttemptAt === undefined ? {} : { lastAttemptAt: job.lastAttemptAt }),
    ...(job.recurring === true ? { recurring: true } : {}),
    ...(job.permanent === true ? { permanent: true } : {}),
    ...(directory === undefined ? {} : { directory }),
    ...(options.workspaceID === undefined ? {} : { workspaceID: options.workspaceID }),
  })

  /**
   * 输入：会话 ID。
   * 输出：存储里的 durable 任务（不含运行时字段）。
   * 预期：每次从存储现读，避免用实例内存里的陈旧视图覆盖别的实例刚写入的任务。
   */
  const readStored = async (sessionID: string): Promise<StoredJob[]> => {
    const record = asRecord(await store.get(scheduleKey(sessionID)))
    const rawJobs = record?.["jobs"]
    if (!Array.isArray(rawJobs)) return []
    const result: StoredJob[] = []
    for (const raw of rawJobs) {
      const parsed = parseStored(raw)
      if (parsed !== null) result.push(parsed)
    }
    return result
  }

  /** 输入：会话 ID + durable 任务；输出：无。预期：空列表删 key，否则整体写回。 */
  const writeStored = async (sessionID: string, list: readonly StoredJob[]): Promise<void> => {
    if (list.length === 0) {
      await store.remove(scheduleKey(sessionID))
      return
    }
    const file: StoredFile = { version: STORE_VERSION, jobs: [...list] }
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
    const fireAt = record["fireAt"]
    const retryAt = record["retryAt"]
    const requestedAt = record["requestedAt"]
    const lastAttemptAt = record["lastAttemptAt"]
    const directory = record["directory"]
    const workspaceID = record["workspaceID"]
    return {
      id,
      sessionID,
      cron,
      prompt,
      createdAt,
      ...(typeof lastFiredAt === "number" && Number.isFinite(lastFiredAt) ? { lastFiredAt } : {}),
      ...(typeof fireAt === "number" && Number.isFinite(fireAt) ? { fireAt } : {}),
      ...(typeof retryAt === "number" && Number.isFinite(retryAt) ? { retryAt } : {}),
      ...(typeof requestedAt === "number" && Number.isFinite(requestedAt) ? { requestedAt } : {}),
      ...(typeof lastAttemptAt === "number" && Number.isFinite(lastAttemptAt) ? { lastAttemptAt } : {}),
      ...(record["recurring"] === true ? { recurring: true } : {}),
      ...(record["permanent"] === true ? { permanent: true } : {}),
      ...(typeof directory === "string" && directory.length > 0 ? { directory } : {}),
      ...(typeof workspaceID === "string" && workspaceID.length > 0 ? { workspaceID } : {}),
    }
  }

  /** 输入：持久化任务 + 目标 location；输出：位置字段已改写的副本。预期：不丢其它字段。 */
  const relocateStored = (stored: StoredJob, location: SessionIdentity): StoredJob => ({
    id: stored.id,
    sessionID: stored.sessionID,
    cron: stored.cron,
    prompt: stored.prompt,
    createdAt: stored.createdAt,
    ...(stored.lastFiredAt === undefined ? {} : { lastFiredAt: stored.lastFiredAt }),
    ...(stored.fireAt === undefined ? {} : { fireAt: stored.fireAt }),
    ...(stored.retryAt === undefined ? {} : { retryAt: stored.retryAt }),
    ...(stored.requestedAt === undefined ? {} : { requestedAt: stored.requestedAt }),
    ...(stored.lastAttemptAt === undefined ? {} : { lastAttemptAt: stored.lastAttemptAt }),
    ...(stored.recurring === true ? { recurring: true } : {}),
    ...(stored.permanent === true ? { permanent: true } : {}),
    directory: location.directory,
    ...(location.workspaceID === undefined ? {} : { workspaceID: location.workspaceID }),
  })

  /**
   * 输入：持久化任务。
   * 输出：运行时任务；算不出下次触发或已过点的一次性任务返回 `null`。
   * 预期：`keepPast` 用于会话 move 恢复——已到点的一次性任务应立即补跑，而不是静默丢弃。
   */
  const toRuntime = (stored: StoredJob, keepPast: boolean): ScheduledJob | null => {
    const job: ScheduledJob = { ...stored, durable: true }
    const next =
      stored.retryAt ??
      (job.recurring === true
        ? computeNext(job, Math.max(job.lastFiredAt ?? job.createdAt, job.lastAttemptAt ?? 0))
        : (stored.fireAt ?? computeNext(job, job.createdAt)))
    if (next === null) return null
    if (!keepPast && job.recurring !== true && next <= Date.now()) return null
    if (job.recurring !== true) job.fireAt = next
    job.nextRunAt = next
    return job
  }

  return {
    async load() {
      await forEachScannedEntry(store, SCHEDULE_PREFIX, async (entry) => {
        const sessionID = entry.key.slice(SCHEDULE_PREFIX.length)
        if (sessionID.length === 0) return

        // 会话当前位置是权威来源：别的 location 的会话不加载、不改写；
        // 本实例的会话则允许存档里的旧位置（session.moved 前写入）被就地更新。
        let authoritative: SessionIdentity | undefined
        if (sessionLocation !== undefined) {
          const located = await sessionLocation(sessionID).catch(() => undefined)
          // null = 结构化确认会话已不存在：清掉孤儿 key，否则每个实例都会永远重试。
          if (located === null) {
            await store.remove(entry.key)
            return
          }
          if (located !== undefined) {
            if (instanceLocation === undefined || !sameLocation(located, instanceLocation)) return
            authoritative = located
          }
          // undefined = 查询失败：保留数据，按存档位置继续过滤，下个 tick 再说。
        }

        const record = asRecord(entry.value)
        if (record === undefined) return
        const rawJobs = record["jobs"]
        if (!Array.isArray(rawJobs)) return

        const kept: StoredJob[] = []
        let changed = false
        for (const raw of rawJobs) {
          let stored = parseStored(raw)
          if (stored === null) continue
          if (authoritative !== undefined) {
            // 位置字段与会话当前位置不一致 = move 后残留的旧值；直接改写，旧存档也能读。
            if (
              stored.directory !== authoritative.directory ||
              stored.workspaceID !== authoritative.workspaceID
            ) {
              stored = relocateStored(stored, authoritative)
              changed = true
            }
          } else if (instanceLocation !== undefined) {
            // 没有权威位置时按存档过滤；旧数据缺字段时放行，保证旧存档可读。
            if (stored.directory !== undefined && stored.directory !== instanceLocation.directory) continue
            if (stored.workspaceID !== undefined && stored.workspaceID !== instanceLocation.workspaceID) continue
          }
          // 算不出下一次的任务不会再触发；one-shot 过点也不补跑，避免重启后把同一次触发算成下一次。
          const job = toRuntime(stored, false)
          if (job === null) continue
          jobs.set(job.id, job)
          kept.push(stored)
        }
        // 过期/损坏/位置变化的条目必须写回：否则 key 只增不减，move 后仍绑定旧位置。
        if (changed || kept.length !== rawJobs.length) await writeStored(sessionID, kept)
      })
    },

    async relocate(sessionID, location) {
      await runSerial(writeChains, scheduleKey(sessionID), async () => {
        const stored = await readStored(sessionID)
        if (stored.length === 0) return
        const state = { changed: false }
        const next = stored.map((item) => {
          if (item.directory === location.directory && item.workspaceID === location.workspaceID) return item
          state.changed = true
          return relocateStored(item, location)
        })
        if (state.changed) await writeStored(sessionID, next)
        // 本实例是新归属者：把恢复的任务放进内存，armTimers 才能重新武装。
        for (const item of next) {
          const job = toRuntime(item, true)
          if (job !== null) jobs.set(job.id, job)
        }
      })
    },

    async addJob(input) {
      const { sessionID, cron, prompt, recurring = false, durable = false, permanent = false } = input
      if (parseCronExpression(cron) === null) {
        return { ok: false, error: `Invalid cron expression '${cron}'. Expected 5 fields: M H DoM Mon DoW.` }
      }
      if (nextCronRunMs(cron, Date.now()) === null) {
        return { ok: false, error: `Cron expression '${cron}' does not match any calendar date in the next 4 years.` }
      }
      const sessionJobs = [...jobs.values()].filter((job) => job.sessionID === sessionID).length
      if (sessionJobs >= MAX_JOBS) {
        return { ok: false, error: `Too many scheduled jobs (max ${String(MAX_JOBS)} per session). Cancel one first.` }
      }

      const now = Date.now()
      // 8 位 hex 理论上会碰撞；撞了就换一个，避免静默覆盖已有任务。
      let id = randomUUID().slice(0, JOB_ID_LENGTH)
      while (jobs.has(id)) id = randomUUID().slice(0, JOB_ID_LENGTH)
      const job: ScheduledJob = {
        id,
        sessionID,
        cron,
        prompt,
        createdAt: now,
        ...(recurring ? { recurring: true } : {}),
        ...(permanent ? { permanent: true } : {}),
        durable,
      }
      const next = computeNext(job, now)
      if (next === null) {
        return { ok: false, error: `Cron expression '${cron}' did not produce a future execution time.` }
      }
      if (!recurring) {
        // 跨年本身不是「已过期」的证据：12-29 建 1 月 1 日的任务完全合法。
        // 真正的上限由下面的 7 天窗口负责，这里不再用「跨年 + 24h」的启发式误伤。
        const maxAgeMs = DEFAULT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
        if (next - now > maxAgeMs) {
          const days = Math.round((next - now) / (24 * 60 * 60 * 1000))
          return {
            ok: false,
            error: `One-shot task cannot be scheduled more than ${String(DEFAULT_MAX_AGE_DAYS)} days in advance (calculated ${String(days)} days away).`,
          }
        }
        job.fireAt = next
        // 展示用：用户请求的准点时刻，提前量只影响实际 fireAt。
        job.requestedAt = nextCronRunMs(cron, now) ?? next
      }
      job.nextRunAt = next
      jobs.set(job.id, job)
      if (durable) {
        // 读最新存档再追加：别的实例可能刚给同一会话加了任务；
        // 同一存档的读改写走进程级串行队列，避免并发写丢任务。
        await runSerial(writeChains, scheduleKey(sessionID), async () => {
          const stored = await readStored(sessionID)
          await writeStored(sessionID, [...stored.filter((item) => item.id !== job.id), toStored(job)])
        })
      }
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
      const targets = new Set(ids)
      const touched = new Set<string>()
      for (const id of ids) {
        const job = jobs.get(id)
        if (job === undefined) continue
        touched.add(job.sessionID)
        jobs.delete(id)
      }
      for (const sessionID of touched) {
        await runSerial(writeChains, scheduleKey(sessionID), async () => {
          const stored = await readStored(sessionID)
          const remaining = stored.filter((item) => !targets.has(item.id))
          if (remaining.length !== stored.length) await writeStored(sessionID, remaining)
        })
      }
    },

    /**
     * 输入：任务 id + 顺延到的时刻。
     * 输出：无。
     * 预期：只改这一个任务的 retryAt/nextRunAt 并落盘；one-shot 重启后仍按顺延时刻重试，
     *       不会被 load() 当成「已过点」静默丢弃。
     */
    async postpone(id, at) {
      const job = jobs.get(id)
      if (job === undefined) return
      job.retryAt = at
      job.nextRunAt = at
      if (job.durable !== true) return
      await runSerial(writeChains, scheduleKey(job.sessionID), async () => {
        const stored = await readStored(job.sessionID)
        if (!stored.some((item) => item.id === id)) return
        await writeStored(
          job.sessionID,
          stored.map((item) => (item.id === id ? { ...item, retryAt: at } : item)),
        )
      })
    },

    /**
     * 输入：任务 id + 尝试时刻。
     * 输出：无。
     * 预期：投递前先落盘 lastAttemptAt；崩溃重启后据此跳过同一次触发，避免重复注入。
     */
    async markAttempted(id, at) {
      const job = jobs.get(id)
      if (job === undefined) return
      job.lastAttemptAt = at
      if (job.durable !== true) return
      await runSerial(writeChains, scheduleKey(job.sessionID), async () => {
        const stored = await readStored(job.sessionID)
        if (!stored.some((item) => item.id === id)) return
        await writeStored(
          job.sessionID,
          stored.map((item) => (item.id === id ? { ...item, lastAttemptAt: at } : item)),
        )
      })
    },

    async markFired(ids, firedAt) {
      const fired = new Set<string>()
      const removed = new Set<string>()
      const touched = new Set<string>()
      for (const id of ids) {
        const job = jobs.get(id)
        if (job?.recurring !== true) continue
        touched.add(job.sessionID)
        job.lastFiredAt = firedAt
        const next = computeNext(job, firedAt)
        if (next === null) {
          // 再也没有下一次：删掉任务，避免 nextRunAt 永远停在过去、每次 idle 都重复触发。
          removed.add(id)
          jobs.delete(id)
          continue
        }
        job.nextRunAt = next
        fired.add(id)
      }
      for (const sessionID of touched) {
        await runSerial(writeChains, scheduleKey(sessionID), async () => {
          const stored = await readStored(sessionID)
          const next: StoredJob[] = []
          let changed = false
          for (const item of stored) {
            if (removed.has(item.id)) {
              changed = true
              continue
            }
            if (!fired.has(item.id)) {
              next.push(item)
              continue
            }
            changed = true
            next.push({ ...item, lastFiredAt: firedAt })
          }
          if (changed) await writeStored(sessionID, next)
        })
      }
    },

    forget(ids) {
      // 只丢内存副本：存储里的任务属于别的 location 实例。
      for (const id of ids) jobs.delete(id)
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
