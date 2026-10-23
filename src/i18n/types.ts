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
    readonly enabled: string
    readonly language: string
    readonly notifications: string
    readonly goal: string
    readonly scheduling: string
    readonly sidebar: string
    readonly contextStats: string
    readonly function: string
    readonly showInSidebar: string
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
    readonly title: string
    readonly context: string
    readonly goal: string
    readonly noGoal: string
    readonly scheduling: string
    readonly loops: string
    readonly jobs: string
    readonly next: string
    readonly cache: string
    readonly hitRate: string
    readonly input: string
    readonly output: string
    readonly cached: string
    readonly steps: string
    readonly tools: string
    readonly subagents: string
    readonly state: string
    readonly usage: string
    readonly time: string
    readonly ago: string
    readonly loading: string
    readonly error: string
    readonly status: Readonly<Record<string, string>>
  }
  readonly sidebar: {
    readonly title: string
    readonly on: string
    readonly off: string
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
  readonly tool: {
    readonly pingResult: (enabled: boolean, lang: string) => string
  }
}
