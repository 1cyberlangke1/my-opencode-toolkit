import type { Lang } from "../i18n";

export interface NotificationConfig {
  /** Master toggle for all notifications (default: true) */
  enabled: boolean;
  /** Notify when a task completes (session.idle) (default: true) */
  onComplete: boolean;
  /** Notify when the agent asks a question (default: true) */
  onQuestion: boolean;
  /** Notify when permission is requested (default: true) */
  onPermission: boolean;
  /** Delay in ms before sending to confirm the session is still idle (default: 1500) */
  idleConfirmationDelay: number;
  /** Skip notification when there are incomplete todos (default: true) */
  skipIfIncompleteTodos: boolean;
  /** Only notify for main (non-subagent) sessions (default: true) */
  onlyMainSession: boolean;
}

export interface SidebarConfig {
  /** Master toggle for the sidebar panel (default: true) */
  enabled: boolean;
  /** Show the cache-hit-rate section (default: true) */
  showCache: boolean;
  /** Show the tool-usage section (default: true) */
  showTools: boolean;
  /** Show the subagent section (default: true) */
  showSubagents: boolean;
  /** Collapsed state of the whole panel (default: false) */
  collapsed: boolean;
}

export interface ToolkitConfig {
  lang: Lang;
  /** Master toggle for the whole plugin (default: true) */
  enabled: boolean;
  notification: NotificationConfig;
  sidebar: SidebarConfig;
}

export const DEFAULT_CONFIG: ToolkitConfig = {
  lang: "auto",
  enabled: true,
  notification: {
    enabled: true,
    onComplete: true,
    onQuestion: true,
    onPermission: true,
    idleConfirmationDelay: 1500,
    skipIfIncompleteTodos: true,
    onlyMainSession: true,
  },
  sidebar: {
    enabled: true,
    showCache: true,
    showTools: true,
    showSubagents: true,
    collapsed: false,
  },
};

export function isLang(value: unknown): value is Lang {
  return value === "zh" || value === "en" || value === "auto";
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

export function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
