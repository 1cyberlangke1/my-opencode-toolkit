import type { Plugin } from "@opencode/plugin"

import { isIdleEvent, readEventSessionID } from "../shared/events.ts"
import { scheduleKey } from "../shared/keys.ts"
import type { SessionLocation } from "../shared/session.ts"
import { capTimerDelay } from "../shared/timer.ts"
import type { SessionRoles } from "../goal/session-role.ts"
import { claimCronMessage, releaseCronMessage, releaseSessionClaims } from "./fire-lock.ts"
import { createSyntheticInjector } from "./inject.ts"
import { isPlanSession } from "./plan.ts"
import type { SchedulingStore } from "./store.ts"
import { isRecurringTaskAged } from "./store.ts"
import type { ScheduledJob } from "./types.ts"

/** 注入消息的 metadata 标记。 */
const CRON_MARKER = "cronContinuation"

/** 功能关闭时顺延任务的间隔。 */
const DISABLED_RETRY_MS = 60_000

/** 目标进行中让路后的重试间隔。 */
const DEFERRED_RETRY_MS = 5 * 60_000

/** 注入失败（会话忙或末条是用户输入）后的重试间隔。 */
const DELIVERY_RETRY_MS = 60_000

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
  /** 输入：会话 ID；输出：会话位置。预期：别的 location 的任务只丢内存副本，查询失败只顺延。 */
  readonly locateSession?: (sessionID: string) => Promise<SessionLocation>
  /** 输入：被 Plan 模式跳过的任务类型 + 会话；输出：无。预期：只负责提示，不影响调度。 */
  readonly notifySkipped?: (kind: "cron" | "loop", sessionID: string) => void
  readonly now?: () => number
}): SchedulingContinuation {
  const { ctx, store, roles, shouldDefer, enabled, notifySkipped, locateSession } = args
  const now = args.now ?? Date.now
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const { inject, pending, inFlight } = createSyntheticInjector({
    ctx,
    roles,
    marker: CRON_MARKER,
    // 同一 job 的同一次触发只让一个实例真正调用 synthetic；失败时释放给其他实例重试。
    claim: claimCronMessage,
    release: releaseCronMessage,
  })
  const lifecycle = { disposed: false }

  /** 输入：无；输出：插件是否已卸载。预期：await 之后用它再确认，避免继续注入或武装。 */
  const isDisposed = (): boolean => lifecycle.disposed

  /**
   * 输入：任务 + 触发时刻。
   * 输出：该次触发对应的 synthetic 消息 ID。
   * 预期：同一任务同一次计划触发在多个插件实例里得到相同 ID；OpenCode 按 ID 幂等入队，
   *       避免热重载/多实例重复注入。
   */
  const messageIDFor = (job: ScheduledJob, at: number): string =>
    `msg_cron_${job.id}_${String(job.nextRunAt ?? at)}`

  /** 输入：无；输出：无。预期：每个未来任务一个 timer，已有 timer 的不重复武装。 */
  const armTimers = (): void => {
    if (isDisposed()) return
    const at = now()
    for (const job of store.listJobs()) {
      if (job.nextRunAt === undefined || timers.has(job.id)) continue
      // 已过点的任务也要武装：0 延迟让它在当前 tick 后补跑，而不是干等下一次 idle。
      // 超过 24 小时的延迟分段等待，避免 32 位溢出导致立即触发。
      const delay = capTimerDelay(job.nextRunAt - at)
      const handle = setTimeout(() => {
        timers.delete(job.id)
        const fresh = store.getJob(job.id)
        if (fresh === undefined) return
        // 分段等待提前醒来时还没到点，继续武装剩余时间。
        if (fresh.nextRunAt !== undefined && fresh.nextRunAt > now()) {
          armTimers()
          return
        }
        // timer 回调里必须吞掉异常，否则未处理的 rejection 会打断整个进程。
        void handleCronFire(fresh).catch(() => undefined)
      }, delay)
      handle.unref()
      timers.set(job.id, handle)
    }
  }

  /** 输入：任务 + 延迟；输出：无。预期：顺延并把新时刻落盘（one-shot 重启后仍会重试），再重新武装。 */
  const postpone = async (job: ScheduledJob, delayMs: number): Promise<void> => {
    const at = now() + delayMs
    // 落盘失败也不能丢掉内存里的顺延，否则本次 tick 会重复触发。
    await store.postpone(job.id, at).catch(() => undefined)
    job.nextRunAt = at
    armTimers()
  }

  /** 输入：任务；输出：无。预期：先确认允许投递，成功后才重排/删除。 */
  const handleCronFire = async (job: ScheduledJob): Promise<void> => {
    if (isDisposed()) return
    const at = now()
    const aged = isRecurringTaskAged(job, at)
    const recurring = job.recurring === true && !aged

    // 关闭或让路时先不消费任务：否则 one-shot 会在用户重新开启前被静默丢掉。
    const on = await enabled().catch(() => false)
    if (!on) {
      await postpone(job, DISABLED_RETRY_MS)
      return
    }
    const defer = await shouldDefer(job.sessionID).catch(() => false)
    if (defer) {
      await postpone(job, DEFERRED_RETRY_MS)
      return
    }
    if (isDisposed()) return

    // location 归属：别的实例的会话只丢本实例的内存副本；查询失败顺延，绝不消费任务。
    if (locateSession !== undefined) {
      const located = await locateSession(job.sessionID)
      if (located.kind === "unknown") {
        await postpone(job, DELIVERY_RETRY_MS)
        return
      }
      if (located.kind === "missing" || located.directory !== ctx.location.directory) {
        store.forget([job.id])
        return
      }
    }

    if (await isPlanSession(ctx, job.sessionID)) {
      if (isDisposed()) return
      notifySkipped?.("cron", job.sessionID)
      // 跳过本次注入：recurring 只跳过这一拍；one-shot 必须顺延而不是删除，
      // 否则用户切回 build agent 后这个一次性任务就永远消失了。
      if (recurring) await store.markFired([job.id], at)
      else await postpone(job, DEFERRED_RETRY_MS)
      armTimers()
      return
    }

    const outcome = await inject(job.sessionID, buildFirePrompt(job, new Date(at)), messageIDFor(job, at))
    if (isDisposed()) return
    // 没抢到锁 = 另一个实例已经在投递同一次触发；这里再顺延只会让 ID 变掉、60 秒后二次注入。
    if (outcome === "claim-lost") {
      armTimers()
      return
    }
    if (outcome === "skipped") {
      // 会话忙或末条是用户输入：保留任务稍后重试（one-shot 的顺延时刻会落盘）。
      await postpone(job, DELIVERY_RETRY_MS)
      return
    }

    if (recurring) await store.markFired([job.id], at)
    else await store.removeJobs([job.id])
    armTimers()
  }

  /** 输入：会话 ID；输出：无。预期：处理该会话已到点的任务，否则补武装 timer。 */
  const handleIdle = async (sessionID: string): Promise<void> => {
    // 事件会广播到所有实例；不是自己的会话就丢掉本实例的内存任务，避免重复注入。
    if (locateSession !== undefined) {
      const located = await locateSession(sessionID)
      if (located.kind === "unknown") return
      if (located.kind === "missing" || located.directory !== ctx.location.directory) {
        store.forget(store.listJobs(sessionID).map((job) => job.id))
        pending.delete(sessionID)
        return
      }
    }
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
      const sessionID = readEventSessionID(event)
      if (sessionID === undefined) return

      if (isIdleEvent(event)) {
        // idle 表示上一轮已经结束；清掉 pending 让本轮可以继续注入。
        pending.delete(sessionID)
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
        // 内存里没加载到的孤儿条目（过期/别的实例写的）也要一起清掉，否则 key 永不清。
        await ctx.storage.remove(scheduleKey(sessionID)).catch(() => undefined)
        inFlight.delete(sessionID)
        pending.delete(sessionID)
        roles.forget(sessionID)
        return
      }
      if (event.type === "session.step.ended" || event.type === "session.usage.updated") {
        pending.delete(sessionID)
      }
      // 注入后模型失败/被打断时清掉 pending，并释放本次触发声明，允许同一次任务重试。
      if (event.type === "session.execution.failed" || event.type === "session.execution.interrupted") {
        pending.delete(sessionID)
        releaseSessionClaims(sessionID)
      }
    },

    armTimers,

    dispose() {
      lifecycle.disposed = true
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      inFlight.clear()
      pending.clear()
    },
  }
}
