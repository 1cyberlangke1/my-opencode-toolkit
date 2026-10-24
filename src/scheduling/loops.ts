import { randomUUID } from "node:crypto"

import type { Plugin } from "@opencode/plugin"

import { isIdleEvent, readEventData } from "../shared/events.ts"
import { lastMessageIsUserInput } from "../shared/messages.ts"
import { capTimerDelay, MAX_TIMER_DELAY_MS } from "../shared/timer.ts"
import { DEFAULT_MAX_AGE_DAYS, type Loop } from "./types.ts"
import { isPlanSession } from "./plan.ts"
import type { SessionRoles } from "../goal/session-role.ts"

/** 注入消息的 metadata 标记。 */
const LOOP_MARKER = "loopContinuation"

/** dynamic 模式没有 `schedule_wakeup` 时的兜底唤醒（20 分钟）。 */
const FALLBACK_WAKEUP_MS = 20 * 60 * 1000
/** 被功能开关 / 让路 / Plan 模式跳过的 tick，隔一分钟再试，不能销毁循环。 */
const SKIPPED_RETRY_MS = 60 * 1000
const WAKEUP_MIN_S = 60
const WAKEUP_MAX_S = 3600

/** fixed 循环的最大间隔：与 7 天过期对齐，避免 setTimeout 超出 32 位范围。 */
const MAX_LOOP_INTERVAL_SECONDS = 7 * 24 * 60 * 60

/** `schedule_wakeup` 的结果。 */
export type ScheduleWakeupResult =
  | { readonly ok: true; readonly id: string; readonly fireAt: number }
  | { readonly ok: false; readonly error: string }

/** 循环调度器。 */
export type LoopScheduler = {
  /** 输入：会话 + prompt + 可选间隔；输出：新循环。预期：立即触发一次。 */
  startLoop(sessionID: string, prompt: string, intervalSeconds?: number): Loop
  /** 输入：会话 + 可选 id；输出：是否停止。 */
  stopLoop(sessionID: string, id?: string): boolean
  /** 输入：会话 + prompt；输出：是否停止。 */
  stopLoopByPrompt(sessionID: string, prompt: string): boolean
  /** 输入：会话；输出：停止数量。 */
  stopAllLoops(sessionID: string): number
  /** 输入：会话；输出：该会话的循环。 */
  listLoops(sessionID: string): Loop[]
  /** 输入：会话 + prompt + 延迟 + 原因；输出：唤醒结果。 */
  scheduleWakeup(sessionID: string, prompt: string, delaySeconds: number, reason: string): ScheduleWakeupResult
  /** 输入：会话事件；输出：无。预期：step 结束清 pending，删除会话清循环。 */
  handleEvent(event: { readonly type: string; readonly data: unknown }): Promise<void>
  /** 输入：会话；输出：无。预期：停掉该会话全部循环。 */
  clearSession(sessionID: string): void
  /** 输入：无；输出：无。预期：清掉所有定时器。 */
  dispose(): void
}

/**
 * 输入：插件上下文、会话角色、是否让路回调。
 * 输出：循环调度器。
 * 预期：fixed 按间隔重复，dynamic 等 `schedule_wakeup`，都不给子代理注入。
 */
export function createLoopScheduler(args: {
  readonly ctx: Plugin.Context
  readonly roles: SessionRoles
  readonly shouldDefer: (sessionID: string) => Promise<boolean>
  /** 输入：被 Plan 模式跳过的任务类型 + 会话；输出：无。预期：只负责提示，不影响调度。 */
  readonly notifySkipped?: (kind: "cron" | "loop", sessionID: string) => void
  /** 输入：无；输出：scheduling 是否启用。缺省视为启用（测试与旧调用兼容）。 */
  readonly enabled?: () => Promise<boolean>
}): LoopScheduler {
  const { ctx, roles, shouldDefer, notifySkipped } = args
  const isEnabled = args.enabled ?? ((): Promise<boolean> => Promise.resolve(true))
  const loops = new Map<string, Loop>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const inFlight = new Set<string>()
  const pending = new Set<string>()
  const lifecycle = { disposed: false }

  /** 输入：会话 + prompt；输出：匹配的循环。预期：同一 prompt 只保留一个。 */
  const findLoop = (sessionID: string, prompt: string): Loop | undefined =>
    [...loops.values()].find((loop) => loop.sessionID === sessionID && loop.prompt === prompt)

  /**
   * 输入：会话 + 文本。
   * 输出：是否注入成功。
   * 预期：以 synthetic 消息注入并唤醒会话；`description` 与正文一致，TUI 灰字 notice
   *       显示的就是模型收到的内容。子代理、并发、上一条未完成、末条是用户输入时跳过。
   */
  const inject = async (sessionID: string, text: string): Promise<boolean> => {
    if (inFlight.has(sessionID) || pending.has(sessionID)) return false
    if (await roles.isSubagent(sessionID)) return false
    if (await lastMessageIsUserInput(ctx, sessionID, LOOP_MARKER)) return false
    inFlight.add(sessionID)
    try {
      await ctx.session.synthetic({
        sessionID,
        text,
        description: text,
        delivery: "steer",
        resume: true,
        metadata: { [LOOP_MARKER]: true },
      })
      pending.add(sessionID)
      return true
    } catch {
      return false
    } finally {
      inFlight.delete(sessionID)
    }
  }

  /**
   * 输入：循环。
   * 输出：这一 tick 是否已消费（注入过，或过期后主动销毁）。
   * 预期：功能关闭、让路、Plan 模式都算「未消费」，调用方必须保留循环稍后再试，不能销毁。
   */
  const fireLoop = async (loop: Loop): Promise<boolean> => {
    if (Date.now() >= loop.expiresAt) {
      stopLoop(loop.sessionID, loop.id)
      return true
    }
    // 功能关闭时循环暂停，但不销毁；重新开启后下一个 timer 继续。
    if (!(await isEnabled().catch(() => false))) return false
    if (await shouldDefer(loop.sessionID).catch(() => false)) return false
    if (await isPlanSession(ctx, loop.sessionID)) {
      notifySkipped?.("loop", loop.sessionID)
      return false
    }
    loop.fires += 1
    await inject(loop.sessionID, loop.prompt)
    return true
  }

  /** 输入：循环 + 延迟毫秒；输出：无。预期：重设 timer，`unref` 不阻止进程退出。 */
  const armLoop = (loop: Loop, delayMs: number): void => {
    if (lifecycle.disposed) return
    const existing = timers.get(loop.id)
    if (existing !== undefined) clearTimeout(existing)
    const target = Number.isFinite(delayMs) ? Math.max(0, delayMs) : MAX_TIMER_DELAY_MS
    loop.nextFireAt = Date.now() + target
    const handle = setTimeout(() => {
      timers.delete(loop.id)
      // 24 小时上限导致提前醒来时继续等剩余时间，而不是提前触发。
      const remaining = (loop.nextFireAt ?? 0) - Date.now()
      if (remaining > 0) {
        armLoop(loop, remaining)
        return
      }
      // timer 回调里必须吞掉异常，否则未处理的 rejection 会打断整个进程。
      void handleFire(loop).catch(() => undefined)
    }, capTimerDelay(target))
    handle.unref()
    timers.set(loop.id, handle)
  }

  /** 输入：循环；输出：无。预期：触发后按模式决定下一次；跳过的 tick 不销毁 dynamic 循环。 */
  const handleFire = async (loop: Loop): Promise<void> => {
    if (lifecycle.disposed) return
    const hadWakeup = loop.pendingWakeup
    const consumed = await fireLoop(loop)
    if (!loops.has(loop.id)) return

    if (loop.mode === "fixed" && loop.intervalSeconds !== undefined) {
      armLoop(loop, loop.intervalSeconds * 1000)
      return
    }

    if (!consumed) {
      // 功能关闭 / 让路 / Plan 模式：保留 pendingWakeup，过一会儿再试，绝不销毁循环。
      armLoop(loop, SKIPPED_RETRY_MS)
      return
    }

    if (hadWakeup !== undefined) {
      if (loop.pendingWakeup === hadWakeup) {
        delete loop.pendingWakeup
        armLoop(loop, FALLBACK_WAKEUP_MS)
      }
      return
    }
    if (loop.pendingWakeup !== undefined) return
    stopLoop(loop.sessionID, loop.id)
  }

  const startLoop = (sessionID: string, prompt: string, intervalSeconds?: number): Loop => {
    const existing = findLoop(sessionID, prompt)
    if (existing !== undefined) stopLoop(sessionID, existing.id)

    // 非法/非正间隔退化为 dynamic，避免 0 或负数把 setTimeout 变成忙循环。
    const interval =
      intervalSeconds !== undefined && Number.isFinite(intervalSeconds) && intervalSeconds > 0
        ? Math.min(intervalSeconds, MAX_LOOP_INTERVAL_SECONDS)
        : undefined

    const now = Date.now()
    const loop: Loop = {
      id: randomUUID().slice(0, 8),
      sessionID,
      prompt,
      mode: interval === undefined ? "dynamic" : "fixed",
      ...(interval === undefined ? {} : { intervalSeconds: interval }),
      createdAt: now,
      expiresAt: now + DEFAULT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000,
      fires: 0,
    }
    loops.set(loop.id, loop)
    void fireLoop(loop).catch(() => undefined)
    armLoop(loop, interval === undefined ? FALLBACK_WAKEUP_MS : interval * 1000)
    return loop
  }

  const stopLoop = (sessionID: string, id?: string): boolean => {
    const target = id === undefined ? [...loops.values()].find((loop) => loop.sessionID === sessionID) : loops.get(id)
    if (target?.sessionID !== sessionID) return false
    const timer = timers.get(target.id)
    if (timer !== undefined) {
      clearTimeout(timer)
      timers.delete(target.id)
    }
    loops.delete(target.id)
    return true
  }

  const stopLoopByPrompt = (sessionID: string, prompt: string): boolean => {
    const loop = findLoop(sessionID, prompt)
    return loop === undefined ? false : stopLoop(sessionID, loop.id)
  }

  const stopAllLoops = (sessionID: string): number => {
    let count = 0
    for (const loop of [...loops.values()].filter((item) => item.sessionID === sessionID)) {
      if (stopLoop(sessionID, loop.id)) count += 1
    }
    return count
  }

  const listLoops = (sessionID: string): Loop[] => [...loops.values()].filter((loop) => loop.sessionID === sessionID)

  const scheduleWakeup = (
    sessionID: string,
    prompt: string,
    delaySeconds: number,
    reason: string,
  ): ScheduleWakeupResult => {
    const loop = findLoop(sessionID, prompt)
    if (loop?.mode !== "dynamic") {
      return {
        ok: false,
        error: "schedule_wakeup is only available inside an active dynamic /loop for this session and prompt.",
      }
    }
    const requested = Number.isFinite(delaySeconds) ? delaySeconds : WAKEUP_MIN_S
    const clamped = Math.min(Math.max(Math.round(requested), WAKEUP_MIN_S), WAKEUP_MAX_S)
    const now = Date.now()
    const fireAt = Math.ceil((now + clamped * 1000) / 60_000) * 60_000
    loop.pendingWakeup = { fireAt, delaySeconds: clamped, prompt, reason }
    armLoop(loop, fireAt - now)
    return { ok: true, id: loop.id, fireAt }
  }

  const clearSession = (sessionID: string): void => {
    for (const loop of listLoops(sessionID)) stopLoop(sessionID, loop.id)
    inFlight.delete(sessionID)
    pending.delete(sessionID)
  }

  return {
    startLoop,
    stopLoop,
    stopLoopByPrompt,
    stopAllLoops,
    listLoops,
    scheduleWakeup,
    clearSession,

    handleEvent(event) {
      const data = readEventData(event)
      const sessionID = data?.["sessionID"]
      if (typeof sessionID !== "string" || sessionID.length === 0) return Promise.resolve()

      if (event.type === "session.deleted") {
        clearSession(sessionID)
        return Promise.resolve()
      }
      if (event.type === "session.step.ended" || event.type === "session.usage.updated") {
        pending.delete(sessionID)
      }
      // 注入后模型失败/被打断/直接 idle 时清掉 pending，否则循环会被永久卡住。
      if (
        event.type === "session.execution.failed" ||
        event.type === "session.execution.interrupted" ||
        isIdleEvent(event)
      ) {
        pending.delete(sessionID)
      }
      return Promise.resolve()
    },

    dispose() {
      lifecycle.disposed = true
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      loops.clear()
      inFlight.clear()
      pending.clear()
    },
  }
}
