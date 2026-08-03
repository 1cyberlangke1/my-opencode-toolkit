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
  /** Skip notification when there are incomplete todos (default: true) */
  skipIfIncompleteTodos: boolean;
  /** Only notify for main (non-subagent) sessions (default: true) */
  onlyMainSession: boolean;
}

export interface TodoReminderConfig {
  /** Master toggle for auto-continue on idle with incomplete todos (default: true) */
  enabled: boolean;
  /** Only inject into the main (non-subagent) session (default: true) */
  onlyMainSession: boolean;
  /** Max injections per session before pausing (reset when todos progress) (default: 3) */
  maxInjections: number;
  /** Countdown seconds before injecting the continuation message (default: 5) */
  countdownSeconds: number;
  /** Injection message template; {todos} is replaced with the remaining todo list (default: English) */
  message: string;
}

export interface GoalConfig {
  /** Master toggle for the goal feature (default: true). When off, goal tools are not registered. */
  enabled: boolean;
}

export interface SchedulingConfig {
  /** Master toggle for scheduled tasks (cron/loop, default: true). Equivalent to CLAUDE_CODE_DISABLE_CRON. */
  enabled: boolean;
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
  todoReminder: TodoReminderConfig;
  goal: GoalConfig;
  scheduling: SchedulingConfig;
  sidebar: SidebarConfig;
}

export const DEFAULT_TODO_REMINDER_MESSAGE = `> **[SYSTEM] Todo continuation**
>
> Incomplete tasks remain in your todo list. Continue working on the next pending task.
>
> - Proceed without asking for permission.
> - Mark each task complete when finished.
> - **Do not stop until all tasks are done.**
>
> Remaining tasks:
> {todos}`;

export const DEFAULT_CONFIG: ToolkitConfig = {
  lang: "auto",
  enabled: true,
  notification: {
    enabled: true,
    onComplete: true,
    onQuestion: true,
    onPermission: true,
    skipIfIncompleteTodos: true,
    onlyMainSession: true,
  },
  todoReminder: {
    enabled: true,
    onlyMainSession: true,
    maxInjections: 3,
    countdownSeconds: 5,
    message: DEFAULT_TODO_REMINDER_MESSAGE,
  },
  goal: {
    enabled: true,
  },
  scheduling: {
    enabled: true,
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

export function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
