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
    /** 标记弃用功能的后缀（如 goal）。 */
    readonly deprecatedSuffix: string
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
    /** 主菜单最后一项：打开更新检查。 */
    readonly checkUpdates: string
    /** 主菜单分类：功能开关与详细设置。 */
    readonly features: string
    /** 主菜单分类：界面偏好。 */
    readonly appearance: string
    /** 侧栏子菜单里目标/定时显示项在功能关闭时的提示后缀。 */
    readonly inactiveSuffix: string
    /** 外部编辑器子菜单。 */
    readonly editor: string
    readonly editorEnabled: string
    readonly editorCommand: string
    readonly editorShowHint: string
    readonly editorPromptCommand: string
    readonly editorOpenNow: string
    /** 时间感知子菜单。 */
    readonly time: string
    readonly timeEnabled: string
    readonly timeMode: string
    readonly timeModeInterval: string
    readonly timeModeSteps: string
    readonly timeInterval: string
    readonly timeIntervalPromptSeconds: string
    readonly timeIntervalPromptSteps: string
    readonly timeFormat: string
    readonly timeFormatPrompt: string
    readonly timeTimezone: string
    readonly timeTimezonePrompt: string
    /** 时间设置非法时的提示。 */
    readonly timeInvalidInterval: string
    readonly timeInvalidIntervalSeconds: string
    readonly timeInvalidTimezone: string
    readonly timeStepsSuffix: (steps: number) => string
  }
  /** 更新检查与启动更新的文案。 */
  readonly update: {
    readonly title: string
    readonly latestFooter: (version: string) => string
    readonly upToDate: string
    readonly failed: string
    readonly updateNow: string
    readonly cancel: string
    readonly confirm: (currentVersion: string, latestVersion: string) => string
    readonly running: string
    readonly succeeded: string
    readonly runFailed: string
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
  readonly footer: {
    /** 输入框底栏左侧的外部编辑器按键提示标签。 */
    readonly editorHint: string
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
  /** 自定义提供商管理文案。 */
  readonly provider: {
    readonly commandTitle: string
    readonly commandDescription: string
    readonly menuTitle: string
    readonly addProvider: string
    readonly editTitle: string
    readonly promptBaseUrl: string
    readonly promptApiKey: string
    readonly promptName: string
    readonly fieldBaseUrl: string
    readonly fieldApiKey: string
    readonly fieldName: string
    readonly fieldNpm: string
    readonly notSet: string
    readonly modelsCount: (count: number) => string
    readonly refetchModels: string
    readonly refetching: string
    readonly refetchSuccess: (count: number) => string
    readonly refetchFailed: string
    readonly manageModels: string
    readonly modelsTitle: string
    readonly addModelManual: string
    readonly promptModelId: string
    readonly modelEditTitle: string
    readonly modelEnabled: string
    readonly modelName: string
    readonly modelContextWindow: string
    readonly modelMaxOutput: string
    readonly modelTools: string
    readonly modelVision: string
    readonly modelAudio: string
    readonly modelVideo: string
    readonly modelRematch: string
    readonly deleteModel: string
    readonly delete: string
    readonly confirmDelete: (name: string) => string
    readonly saveSuccess: (name: string) => string
    readonly saveFailed: string
    readonly deleteSuccess: string
  }
}
