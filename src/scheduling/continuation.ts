import type { Plugin } from "@opencode/plugin"

import { asRecord } from "../shared/json.ts"
import type { SessionRoles } from "../goal/session-role.ts"
import type { SchedulingStore } from "./store.ts"
import { isRecurringTaskAged } from "./store.ts"
import type { ScheduledJob } from "./types.ts"

/** 定时任务触发控制器。 */
export type SchedulingContinuation = {
  /** 输入：会话事件；输出：无。预期：idle 兜底触发，删除会话清任务。 */
  handle(event: { readonly type: string; readonly data: unknown }): Promise<void>
  /** 输入：无；输出：无。预期：给所有未来任务武装 timer。 */
  armTimers(): void
  /** 输入：无；输出：无。预期：清掉全部 timer。 */
  dispose(): void
}

/**
 * 输入：时间。
 * 输出：`Nov 3 2:30pm` 形式的英文时间。
 * 预期：只用于注入文本，固定 en-US 以免跟随系统语言变化。
 */
function formatFireTime(date: Date): string {
  return date
    .toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    .replace(/,? at |, /, " ")
    .replace(/ ([AP]M)/, (_, ampm: string) => ampm.toLowerCase())
}

/** 输入：任务 + 触发时间；输出：注入文本。 */
function buildFirePrompt(job: ScheduledJob, at: Date): string {
  return `Running scheduled task (${formatFireTime(at)})\n\n${job.prompt}`
}

/**
 * 输入：插件上下文、存储、会话角色、让路回调、启用判断。
 * 输出：定时任务触发控制器。
 * 预期：到点先无条件重排/删除，再尽力注入；子代理与让路时不注入。
 */
export function createSchedulingContinuation(args: {
  readonly ctx: Plugin.Context
  readonly store: SchedulingStore
  readonly roles: SessionRoles
  readonly shouldDefer: (sessionID: string) => Promise<boolean>
  readonly enabled: () => Promise<boolean>
  readonly now?: () => number
}): SchedulingContinuation {
  const { ctx, store, roles, shouldDefer, enabled } = args
  const now = args.now ?? Date.now
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const inFlight = new Set<string>()
  const pending = new Set<string>()

  /** 输入：会话 + 文本；输出：是否注入成功。预期：并发或上一条未完成时跳过。 */
  const inject = async (sessionID: string, text: string): Promise<boolean> => {
    if (inFlight.has(sessionID) || pending.has(sessionID)) return false
    if (await roles.isSubagent(sessionID)) return false
    inFlight.add(sessionID)
    try {
      await ctx.session.prompt({ sessionID, text, delivery: "steer" })
      pending.add(sessionID)
      return true
    } catch {
      return false
    } finally {
      inFlight.delete(sessionID)
    }
  }

  /** 输入：无；输出：无。预期：每个未来任务一个 timer，已有 timer 的不重复武装。 */
  const armTimers = (): void => {
    const at = now()
    for (const job of store.listJobs()) {
      if (job.nextRunAt === undefined || timers.has(job.id)) continue
      const delay = job.nextRunAt - at
      if (delay <= 0) continue
      const handle = setTimeout(() => {
        timers.delete(job.id)
        const fresh = store.getJob(job.id)
        if (fresh !== undefined) void handleCronFire(fresh)
      }, delay)
      handle.unref()
      timers.set(job.id, handle)
    }
  }

  /** 输入：任务；输出：无。预期：先重排/删除，再判断是否注入。 */
  const handleCronFire = async (job: ScheduledJob): Promise<void> => {
    const at = now()
    const aged = isRecurringTaskAged(job, at)
    if (aged || job.recurring !== true) {
      await store.removeJobs([job.id])
    } else {
      await store.markFired([job.id], at)
    }
    armTimers()

    if (!(await enabled())) return
    if (await shouldDefer(job.sessionID)) return
    await inject(job.sessionID, buildFirePrompt(job, new Date(at)))
  }

  /** 输入：会话 ID；输出：无。预期：处理该会话已到点的任务，否则补武装 timer。 */
  const handleIdle = async (sessionID: string): Promise<void> => {
    if (!(await enabled())) return
    const at = now()
    const due = store
      .listJobs(sessionID)
      .filter((job) => job.nextRunAt !== undefined && job.nextRunAt <= at)
      .sort((a, b) => (a.nextRunAt ?? Number.POSITIVE_INFINITY) - (b.nextRunAt ?? Number.POSITIVE_INFINITY))
    const job = due[0]
    if (job !== undefined) {
      await handleCronFire(job)
      return
    }
    armTimers()
  }

  return {
    async handle(event) {
      const data = asRecord(event.data)
      const sessionID = data?.["sessionID"]
      if (typeof sessionID !== "string" || sessionID.length === 0) return

      if (event.type === "session.idle") {
        await handleIdle(sessionID)
        return
      }
      if (event.type === "session.deleted") {
        const ids = store.listJobs(sessionID).map((job) => job.id)
        for (const id of ids) {
          const timer = timers.get(id)
          if (timer !== undefined) {
            clearTimeout(timer)
            timers.delete(id)
          }
        }
        await store.removeJobs(ids)
        inFlight.delete(sessionID)
        pending.delete(sessionID)
        return
      }
      if (event.type === "session.step.ended" || event.type === "session.usage.updated") {
        pending.delete(sessionID)
      }
    },

    armTimers,

    dispose() {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      inFlight.clear()
      pending.clear()
    },
  }
}
