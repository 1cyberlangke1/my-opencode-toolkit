/**
 * 界面文案。
 *
 * 源码里只引用键名，所有用户可见文字都来自语言文件。
 */
export type Messages = {
  readonly command: {
    readonly title: string
    readonly description: string
    readonly group: string
    readonly goal: string
    readonly loop: string
    readonly cron: string
  }
  readonly menu: {
    readonly title: string
    readonly language: string
    readonly notifications: string
    readonly goal: string
    readonly scheduling: string
    readonly sidebar: string
    readonly contextStats: string
    readonly function: string
    readonly showLine: string
    readonly showInput: string
    readonly showOutput: string
    readonly showHitRate: string
    readonly notificationEnabled: string
    readonly onComplete: string
    readonly onQuestion: string
    readonly onPermission: string
    readonly onlyMainSession: string
    readonly on: string
    readonly off: string
    readonly auto: string
    readonly chinese: string
    readonly english: string
    readonly showCache: string
    readonly showTools: string
    readonly showSubagents: string
  }
  readonly panel: {
    readonly goal: string
    readonly noGoal: string
    readonly scheduling: string
    readonly next: string
    readonly hitRate: string
    readonly input: string
    readonly output: string
    readonly cached: string
    readonly tools: string
    readonly subagents: string
    readonly state: string
    readonly usage: string
    readonly time: string
    readonly ago: string
    readonly loading: string
    readonly error: string
    readonly status: Readonly<Record<string, string>>
    /** 循环任务剩余天数；到期后会被自动清理。 */
    readonly expires: (days: string) => string
  }
  readonly toast: {
    /** Plan 模式跳过 cron 注入时的提示。 */
    readonly planSkippedCron: string
    /** Plan 模式跳过 loop 注入时的提示。 */
    readonly planSkippedLoop: string
  }
  readonly notification: {
    readonly title: string
    readonly completed: string
    readonly question: string
    readonly permission: string
    readonly user: string
    readonly assistant: string
  }
  /** cron 的人类可读描述；days 是周日到周六的短名。 */
  readonly cron: {
    readonly everyMinute: string
    readonly everyNMinutes: (n: string) => string
    readonly everyHour: string
    readonly everyHourAt: (minute: string) => string
    readonly everyNHours: (n: string) => string
    readonly everyNHoursAt: (n: string, minute: string) => string
    readonly daily: (time: string) => string
    readonly weekly: (day: string, time: string) => string
    readonly weekdays: (time: string) => string
    readonly oneShot: (time: string) => string
    readonly days: readonly string[]
  }
}