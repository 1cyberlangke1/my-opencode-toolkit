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
}

/** 定时任务开关。 */
export type SchedulingSettings = {
  readonly enabled: boolean
}

/** TUI 侧栏显示项。 */
export type SidebarSettings = {
  readonly enabled: boolean
  readonly showCache: boolean
  readonly showTools: boolean
  readonly showSubagents: boolean
  readonly collapsed: boolean
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
}

/**
 * 默认设置。
 *
 * 预期：通知默认开、Goal 默认开、定时默认开、侧栏默认开；
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
  goal: { enabled: true },
  scheduling: { enabled: true },
  sidebar: {
    enabled: true,
    showCache: true,
    showTools: true,
    showSubagents: true,
    collapsed: false,
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
    },
    scheduling: {
      enabled: readBoolean(scheduling["enabled"], DEFAULT_SETTINGS.scheduling.enabled),
    },
    sidebar: {
      enabled: readBoolean(sidebar["enabled"], DEFAULT_SETTINGS.sidebar.enabled),
      showCache: readBoolean(sidebar["showCache"], DEFAULT_SETTINGS.sidebar.showCache),
      showTools: readBoolean(sidebar["showTools"], DEFAULT_SETTINGS.sidebar.showTools),
      showSubagents: readBoolean(sidebar["showSubagents"], DEFAULT_SETTINGS.sidebar.showSubagents),
      collapsed: readBoolean(sidebar["collapsed"], DEFAULT_SETTINGS.sidebar.collapsed),
    },
  }
}

/**
 * 输入：当前设置 + 局部补丁。
 * 输出：合并后的完整设置。
 * 预期：顶层字段直接覆盖，四个子对象逐字段合并；补丁不是对象时原样返回当前设置。
 */
export function patchSettings(current: Settings, patch: unknown): Settings {
  const record = asRecord(patch)
  if (record === undefined) return current

  const merged: Record<string, unknown> = { ...current }
  for (const [key, value] of Object.entries(record)) merged[key] = value

  for (const section of ["notification", "goal", "scheduling", "sidebar"] as const) {
    const nested = asRecord(record[section])
    if (nested !== undefined) merged[section] = { ...current[section], ...nested }
  }

  return normalizeSettings(merged)
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
