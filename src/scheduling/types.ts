// scheduling 模块类型与常量（对齐 Claude Code cron 契约，见 PLAN.md §0）。
// 输入：CronCreate/ScheduleWakeup 等工具、store 持久化、scheduler 调度共用同一组形状。

/** 任务 id 长度（`randomUUID().slice(0, 8)`，8 hex 字符）。 */
export const JOB_ID_LENGTH = 8;

/** 每会话定时任务上限（对齐 Claude Code `MAX_JOBS`）。 */
export const MAX_JOBS = 50;

/** recurring 任务自动过期天数（对齐 Claude Code `DEFAULT_MAX_AGE_DAYS`）。 */
export const DEFAULT_MAX_AGE_DAYS = 7;

/** 调度器 tick 间隔毫秒（对齐 Claude Code `CHECK_INTERVAL_MS`）。 */
export const SCHEDULER_TICK_MS = 1000;

/** 定时任务（CronCreate 产物）。 */
export interface ScheduledJob {
  /** 8 hex 字符 id（`randomUUID().slice(0, 8)`）。 */
  id: string;
  /** 所属会话。 */
  sessionID: string;
  /** 5 字段 cron（本地时区）。 */
  cron: string;
  /** 触发时注入的 prompt。 */
  prompt: string;
  /** 创建时刻（epoch ms），7 天过期的锚点。 */
  createdAt: number;
  /** 最近一次 fire 时刻；recurring 重启后重建 nextRunAt 的锚点。 */
  lastFiredAt?: number;
  /** true = 重复触发；缺省/undefined = one-shot（火一次自删）。 */
  recurring?: boolean;
  /** 豁免 7 天过期（系统内部任务预留；CronCreate 不可设置）。 */
  permanent?: boolean;
  /** false = 仅内存（会话结束即失）；写盘时剥离该字段（磁盘上即 durable）。 */
  durable?: boolean;
  /** 内存态：下一次 fire 的实际时刻（含 jitter）；持久化文件不含此字段。 */
  nextRunAt?: number;
}

/** /loop 同会话循环。 */
export interface Loop {
  id: string;
  sessionID: string;
  prompt: string;
  mode: "fixed" | "dynamic";
  /** fixed 模式间隔秒数；dynamic 无此字段。 */
  intervalSeconds?: number;
  createdAt: number;
  /** recurring 7 天过期；dynamic loop 也适用。 */
  expiresAt?: number;
  fires: number;
  /** 下一次 fire 时刻（epoch ms，scheduler 武装 timer 时设置；供 TUI 倒计时）。 */
  nextFireAt?: number;
  /** dynamic 模式：ScheduleWakeup 设定的待唤醒信息。 */
  pendingWakeup?: Wakeup;
}

/** ScheduleWakeup 动态循环的一次唤醒。 */
export interface Wakeup {
  /** 预计唤醒时刻（epoch ms，已向上取整到分钟）。 */
  fireAt: number;
  /** 请求延迟秒数（已 clamp 到 [60, 3600]）。 */
  delaySeconds: number;
  /** 唤醒时注入的 prompt（必须与 loop.prompt 一致）。 */
  prompt: string;
  /** 一句话原因（显示给用户）。 */
  reason: string;
}
