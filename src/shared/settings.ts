import { asRecord } from "./json.ts"

/** 界面语言；`auto` 跟随系统。 */
export type Lang = "auto" | "zh" | "en"

/** 系统通知开关。 */
export type NotificationSettings = {
  /** 总开关，关掉后其余字段都不生效。 */
  readonly enabled: boolean
  /** 会话完成（空闲）时通知。 */
  readonly onComplete: boolean
  /** 代理提问时通知。 */
  readonly onQuestion: boolean
  /** 请求权限时通知。 */
  readonly onPermission: boolean
  /** 只通知主会话，忽略子代理。 */
  readonly onlyMainSession: boolean
}

/** 持久目标开关。 */
export type GoalSettings = {
  readonly enabled: boolean
  /** 是否在侧栏显示目标分区；关闭不影响功能。 */
  readonly showInSidebar: boolean
}

/** 定时任务开关。 */
export type SchedulingSettings = {
  readonly enabled: boolean
  /** 是否在侧栏显示定时分区；关闭不影响功能。 */
  readonly showInSidebar: boolean
}

/** TUI 侧栏显示项。 */
export type SidebarSettings = {
  readonly showTools: boolean
  readonly showSubagents: boolean
}

/** 底部上下文统计行。 */
export type ContextStatsSettings = {
  readonly enabled: boolean
  readonly showInput: boolean
  readonly showOutput: boolean
  readonly showCache: boolean
  readonly showHitRate: boolean
}

/** 时间感知：每隔 N 步向会话注入一次当前时间。 */
export type TimeSettings = {
  readonly enabled: boolean
  /** 每隔多少步注入一次；最小 1。 */
  readonly intervalSteps: number
  /** 时间格式模板；token：YYYY MM DD HH mm ss。 */
  readonly format: string
  /** IANA 时区；空 = 宿主时区；非法值回落宿主。 */
  readonly timezone: string
}

/** 插件全部设置。 */
export type Settings = {
  readonly lang: Lang
  /** 插件总开关；关掉后不注册工具、不注入、不通知。 */
  readonly enabled: boolean
  readonly notification: NotificationSettings
  readonly goal: GoalSettings
  readonly scheduling: SchedulingSettings
  readonly sidebar: SidebarSettings
  readonly contextStats: ContextStatsSettings
  readonly time: TimeSettings
}

/**
 * 默认设置。
 *
 * 预期：通知默认开、Goal 默认关（官方 /goal 已内置，本功能弃用）、定时默认开、侧栏默认开；
 *       语言跟随系统；侧栏默认展开。
 */
export const DEFAULT_SETTINGS: Settings = {
  lang: "auto",
  enabled: true,
  notification: {
    enabled: true,
    onComplete: true,
    onQuestion: true,
    onPermission: true,
    onlyMainSession: true,
  },
  goal: { enabled: false, showInSidebar: true },
  scheduling: { enabled: true, showInSidebar: true },
  sidebar: {
    showTools: false,
    showSubagents: true,
  },
  contextStats: {
    enabled: true,
    showInput: true,
    showOutput: true,
    showCache: true,
    showHitRate: true,
  },
  time: {
    enabled: true,
    intervalSteps: 3,
    format: "YYYY-MM-DD HH:mm:ss",
    timezone: "",
  },
}

/**
 * 输入：任意值（通常来自存储或插件 options）。
 * 输出：字段完整、类型合法的设置。
 * 预期：缺失或类型错误的字段回退到默认值；未知字段被丢弃；不抛异常。
 */
export function normalizeSettings(raw: unknown): Settings {
  const record = asRecord(raw) ?? {}
  const notification = asRecord(record["notification"]) ?? {}
  const goal = asRecord(record["goal"]) ?? {}
  const scheduling = asRecord(record["scheduling"]) ?? {}
  const sidebar = asRecord(record["sidebar"]) ?? {}
  const contextStats = asRecord(record["contextStats"]) ?? {}
  const time = asRecord(record["time"]) ?? {}
  const legacyShowCache = typeof sidebar["showCache"] === "boolean" ? sidebar["showCache"] : undefined

  return {
    lang: readLang(record["lang"], DEFAULT_SETTINGS.lang),
    enabled: readBoolean(record["enabled"], DEFAULT_SETTINGS.enabled),
    notification: {
      enabled: readBoolean(notification["enabled"], DEFAULT_SETTINGS.notification.enabled),
      onComplete: readBoolean(notification["onComplete"], DEFAULT_SETTINGS.notification.onComplete),
      onQuestion: readBoolean(notification["onQuestion"], DEFAULT_SETTINGS.notification.onQuestion),
      onPermission: readBoolean(notification["onPermission"], DEFAULT_SETTINGS.notification.onPermission),
      onlyMainSession: readBoolean(
        notification["onlyMainSession"],
        DEFAULT_SETTINGS.notification.onlyMainSession,
      ),
    },
    goal: {
      enabled: readBoolean(goal["enabled"], DEFAULT_SETTINGS.goal.enabled),
      showInSidebar: readBoolean(goal["showInSidebar"], DEFAULT_SETTINGS.goal.showInSidebar),
    },
    scheduling: {
      enabled: readBoolean(scheduling["enabled"], DEFAULT_SETTINGS.scheduling.enabled),
      showInSidebar: readBoolean(scheduling["showInSidebar"], DEFAULT_SETTINGS.scheduling.showInSidebar),
    },
    sidebar: {
      showTools: readBoolean(sidebar["showTools"], DEFAULT_SETTINGS.sidebar.showTools),
      showSubagents: readBoolean(sidebar["showSubagents"], DEFAULT_SETTINGS.sidebar.showSubagents),
    },
    contextStats: {
      enabled: readBoolean(
        contextStats["enabled"],
        legacyShowCache ?? DEFAULT_SETTINGS.contextStats.enabled,
      ),
      showInput: readBoolean(contextStats["showInput"], DEFAULT_SETTINGS.contextStats.showInput),
      showOutput: readBoolean(contextStats["showOutput"], DEFAULT_SETTINGS.contextStats.showOutput),
      showCache: readBoolean(contextStats["showCache"], DEFAULT_SETTINGS.contextStats.showCache),
      showHitRate: readBoolean(contextStats["showHitRate"], DEFAULT_SETTINGS.contextStats.showHitRate),
    },
    time: {
      enabled: readBoolean(time["enabled"], DEFAULT_SETTINGS.time.enabled),
      intervalSteps: readIntervalSteps(time["intervalSteps"], DEFAULT_SETTINGS.time.intervalSteps),
      format: readString(time["format"], DEFAULT_SETTINGS.time.format),
      timezone: readString(time["timezone"], DEFAULT_SETTINGS.time.timezone),
    },
  }
}

/**
 * 输入：任意值 + 默认值。
 * 输出：布尔值，非布尔时用默认值。
 * 预期：不做字符串/数字到布尔的隐式转换。
 */
function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

/**
 * 输入：任意值 + 默认语言。
 * 输出：合法语言枚举，其余回退默认值。
 */
function readLang(value: unknown, fallback: Lang): Lang {
  return value === "auto" || value === "zh" || value === "en" ? value : fallback
}

/**
 * 输入：任意值 + 默认步数。
 * 输出：正整数，向下取整；0、负数、NaN、非数字回退默认值。
 */
function readIntervalSteps(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  const rounded = Math.floor(value)
  return rounded >= 1 ? rounded : fallback
}

/**
 * 输入：任意值 + 默认字符串。
 * 输出：非空字符串原样返回；其余回退默认值。
 * 预期：时间格式与时区都是自由文本，不做语义校验（非法时区在渲染时回落宿主）。
 */
function readString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback
}
