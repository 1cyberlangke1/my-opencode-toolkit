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
  }
  readonly menu: {
    readonly title: string
    readonly enabled: string
    readonly language: string
    readonly notifications: string
    readonly goal: string
    readonly scheduling: string
    readonly sidebar: string
    readonly on: string
    readonly off: string
    readonly auto: string
    readonly chinese: string
    readonly english: string
    readonly showCache: string
    readonly showTools: string
    readonly showSubagents: string
    readonly collapsed: string
  }
  readonly panel: {
    readonly title: string
    readonly goal: string
    readonly noGoal: string
    readonly loops: string
    readonly jobs: string
    readonly cache: string
    readonly tools: string
    readonly subagents: string
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
