/** 任务 id 长度（`randomUUID().slice(0, 8)`，8 个 hex 字符）。 */
export const JOB_ID_LENGTH = 8

/** 每会话定时任务上限。 */
export const MAX_JOBS = 50

/** recurring 任务自动过期天数。 */
export const DEFAULT_MAX_AGE_DAYS = 7

/** 定时任务（cron）。 */
export type ScheduledJob = {
  readonly id: string
  readonly sessionID: string
  /** 5 字段 cron（本地时区）。 */
  readonly cron: string
  /** 触发时注入的 prompt。 */
  readonly prompt: string
  readonly createdAt: number
  lastFiredAt?: number
  /** true = 重复触发；缺省 = one-shot（火一次自删）。 */
  readonly recurring?: boolean
  /** 豁免过期（系统内部任务预留）。 */
  readonly permanent?: boolean
  /** false = 仅内存；缺省 = 写存储。 */
  readonly durable?: boolean
  /** 运行时字段：下一次 fire 时刻，不写存储。 */
  nextRunAt?: number
}

/** 固定间隔循环。 */
export type Loop = {
  readonly id: string
  readonly sessionID: string
  readonly prompt: string
  readonly mode: "fixed" | "dynamic"
  /** fixed 模式间隔秒数。 */
  readonly intervalSeconds?: number
  readonly createdAt: number
  readonly expiresAt: number
  /** 已触发次数（运行时）。 */
  fires: number
  /** 下一次 fire 时刻（运行时，供 TUI 倒计时）。 */
  nextFireAt?: number
  /** dynamic 模式：`schedule_wakeup` 设定的待唤醒信息。 */
  pendingWakeup?: Wakeup
}

/** `schedule_wakeup` 的一次唤醒。 */
export type Wakeup = {
  readonly fireAt: number
  readonly delaySeconds: number
  readonly prompt: string
  readonly reason: string
}