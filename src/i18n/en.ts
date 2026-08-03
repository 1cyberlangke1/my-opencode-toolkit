export interface TranslationDict {
  // Notification messages
  "notification.completed": string;
  "notification.question": string;
  "notification.permission": string;
  "notification.title": string;
  "notification.user": string;
  "notification.assistant": string;
  // Todo reminder toast
  "todoReminder.title": string;
  "todoReminder.countdown": string;
  // Goal command feedback
  "goalCommand.title": string;
  "goalCommand.set": string;
  "goalCommand.paused": string;
  "goalCommand.resumed": string;
  "goalCommand.cleared": string;
  "goalCommand.showNone": string;
  "goalCommand.show": string;
  "goalCommand.injected": string;
  "goalCommand.description": string;
  "goalCommand.usage": string;
  "goalCommand.example": string;
  "goalCommand.editPrompt": string;
  // Scheduling command feedback
  "schedulingCommand.loop.desc": string;
  "schedulingCommand.loopStop.desc": string;
  "schedulingCommand.loopStart": string;
  "schedulingCommand.loopStopDone": string;
  "schedulingCommand.loopStopNone": string;
  "schedulingCommand.title": string;
  "schedulingCommand.injected": string;
  "schedulingCommand.loopInjected": string;
  "config.scheduling": string;
  "help.scheduling": string;
  "status.scheduling": string;
  "config.yolo": string;
  "help.yolo": string;
  "status.yolo": string;
  "toast.yoloOn": string;
  "toast.yoloOff": string;
  // Cron human-readable description
  "cron.everyMinute": string;
  "cron.everyNMinutes": string;
  "cron.everyHour": string;
  "cron.everyHourAt": string;
  "cron.everyNHours": string;
  "cron.everyNHoursAt": string;
  "cron.daily": string;
  "cron.weekly": string;
  "cron.weekdays": string;
  // Commands
  "cmd.mot.title": string;
  "cmd.mot.desc": string;
  "cmd.status.title": string;
  "cmd.status.desc": string;
  "cmd.lang.title": string;
  "cmd.lang.desc": string;
  // Config panel
  "config.title": string;
  "config.general": string;
  "config.notificationGroup": string;
  "config.sidebarGroup": string;
  "config.return": string;
  "config.closed": string;
  // Sidebar config items
  "config.sidebar": string;
  "config.sidebarCache": string;
  "config.sidebarTools": string;
  "config.sidebarSubagents": string;
  "config.sidebarCollapsed": string;
  // Config items
  "config.lang": string;
  "config.toggle": string;
  "config.notify": string;
  "config.complete": string;
  "config.question": string;
  "config.permission": string;
  "config.todos": string;
  "config.mainonly": string;
  "config.todoReminder": string;
  "config.todoReminderMax": string;
  "config.todoReminderCountdown": string;
  "config.goal": string;
  // Dialog labels
  "dialog.select.title": string;
  "dialog.select.on": string;
  "dialog.select.off": string;
  "dialog.lang.title": string;
  "dialog.lang.auto": string;
  "dialog.lang.zh": string;
  "dialog.lang.en": string;
  // Toast messages
  "toast.changed": string;
  "toast.lang": string;
  // Status summary
  "status.plugin": string;
  "status.lang": string;
  "status.notification": string;
  "status.complete": string;
  "status.question": string;
  "status.permission": string;
  "status.todos": string;
  "status.mainonly": string;
  "status.todoReminder": string;
  "status.todoReminderMax": string;
  "status.todoReminderCountdown": string;
  "status.goal": string;
  // Help texts shown in the on/off dialogs
  "help.toggle": string;
  "help.notify": string;
  "help.complete": string;
  "help.question": string;
  "help.permission": string;
  "help.todos": string;
  "help.mainonly": string;
  "help.todoReminder": string;
  "help.todoReminderMax": string;
  "help.todoReminderCountdown": string;
  "help.goal": string;
  // Dialog labels
  "dialog.todoReminderMax": string;
  "dialog.todoReminderCountdown": string;
  "dialog.todoReminderInvalid": string;
  "help.sidebar": string;
  "help.sidebarCache": string;
  "help.sidebarTools": string;
  "help.sidebarSubagents": string;
  "help.sidebarCollapsed": string;
  // Misc
  "misc.on": string;
  "misc.off": string;
  // Sidebar panel
  "sidebar.title": string;
  "sidebar.goal.title": string;
  "sidebar.goal.status.active": string;
  "sidebar.goal.status.paused": string;
  "sidebar.goal.status.blocked": string;
  "sidebar.goal.status.budget_limited": string;
  "sidebar.goal.status.complete": string;
  "sidebar.goal.objective": string;
  "sidebar.goal.tokens": string;
  "sidebar.goal.time": string;
  "sidebar.goal.empty": string;
  "sidebar.scheduling.title": string;
  "sidebar.scheduling.cron": string;
  "sidebar.scheduling.loop": string;
  "sidebar.scheduling.recurring": string;
  "sidebar.scheduling.oneShot": string;
  "sidebar.scheduling.dynamic": string;
  "sidebar.scheduling.fixed": string;
  "sidebar.scheduling.empty": string;
  "sidebar.yolo.label": string;
  "sidebar.cache.title": string;
  "sidebar.cache.hitRate": string;
  "sidebar.cache.input": string;
  "sidebar.cache.output": string;
  "sidebar.cache.read": string;
  "sidebar.cache.write": string;
  "sidebar.tools.title": string;
  "sidebar.subagents.title": string;
  "sidebar.subagents.status.running": string;
  "sidebar.subagents.status.done": string;
  "sidebar.subagents.status.error": string;
  "sidebar.subagents.field.agent": string;
  "sidebar.subagents.field.status": string;
  "sidebar.subagents.field.duration": string;
  "sidebar.subagents.field.tokens": string;
  "sidebar.subagents.field.cost": string;
  "sidebar.subagents.field.model": string;
  "sidebar.subagents.field.tools": string;
  "sidebar.subagents.open": string;
  "sidebar.empty": string;
}

export const en: TranslationDict = {
  "notification.completed": "Task completed",
  "notification.question": "Agent is asking a question",
  "notification.permission": "Agent needs permission to continue",
  "notification.title": "OpenCode",
  "notification.user": "User",
  "notification.assistant": "Assistant",

  "todoReminder.title": "Todo continuation",
  "todoReminder.countdown": "Resuming in {seconds}s... ({remaining} tasks left)",

  "goalCommand.title": "Goal",
  "goalCommand.set": "Goal set: {objective}",
  "goalCommand.paused": "Goal paused",
  "goalCommand.resumed": "Goal resumed",
  "goalCommand.cleared": "Goal cleared",
  "goalCommand.showNone": "No active goal",
  "goalCommand.show": "Goal ({status}): {objective}",
  "goalCommand.injected": "Goal continuation injected",
  "goalCommand.description": "set or view the goal for a long-running task",
  "goalCommand.usage": "Usage: /goal [<objective>|clear|edit|pause|resume]",
  "goalCommand.example": "Example: /goal improve benchmark coverage",
  "goalCommand.editPrompt": "Current goal: {objective}. Edit with /goal <new objective>.",

  "schedulingCommand.loop.desc": "run a prompt on a fixed or self-paced loop in this session",
  "schedulingCommand.loopStop.desc": "stop all /loop loops in this session",
  "schedulingCommand.loopStart": "Loop started: {prompt} ({mode})",
  "schedulingCommand.loopStopDone": "Loop stopped",
  "schedulingCommand.loopStopNone": "No active loop to stop",
  "schedulingCommand.title": "Scheduled task",
  "schedulingCommand.injected": "Scheduled task injected",
  "schedulingCommand.loopInjected": "Loop injected",
  "config.scheduling": "Scheduled tasks",

  "help.scheduling": "Scheduled tasks (cron/loop). When off, cron_create/cron_list/cron_delete and the /loop commands are unavailable and no scheduled prompts fire.",
  "status.scheduling": "Scheduled tasks",
  "config.yolo": "YOLO mode",
  "help.yolo": "Auto-approve all tool calls (project-scoped). Existing explicit deny rules are still honored. Restart opencode to apply after toggling.",
  "status.yolo": "YOLO mode",
  "toast.yoloOn": "YOLO mode enabled — restart opencode to apply",
  "toast.yoloOff": "YOLO mode disabled — restart opencode to apply",

  "cron.everyMinute": "Every minute",
  "cron.everyNMinutes": "Every {n} minutes",
  "cron.everyHour": "Every hour",
  "cron.everyHourAt": "Every hour at :{minute}",
  "cron.everyNHours": "Every {n} hours",
  "cron.everyNHoursAt": "Every {n} hours at :{minute}",
  "cron.daily": "Every day at {time}",
  "cron.weekly": "Every {day} at {time}",
  "cron.weekdays": "Weekdays at {time}",

  "cmd.mot.title": "My OpenCode Toolkit: Settings",
  "cmd.mot.desc": "Open toolkit settings",
  "cmd.status.title": "My OpenCode Toolkit: Status",
  "cmd.status.desc": "Show toolkit status",
  "cmd.lang.title": "My OpenCode Toolkit: Language",
  "cmd.lang.desc": "Switch language",

  "config.title": "My OpenCode Toolkit",
  "config.general": "General",
  "config.notificationGroup": "Notifications",
  "config.sidebarGroup": "Session Stats",
  "config.return": "← Back",
  "config.closed": "Settings closed",

  "config.sidebar": "Session stats panel",
  "config.sidebarCache": "Cache section",
  "config.sidebarTools": "Tools section",
  "config.sidebarSubagents": "Subagents section",
  "config.sidebarCollapsed": "Collapsed",

  "config.lang": "Language",
  "config.toggle": "Plugin enabled",
  "config.notify": "Notifications",
  "config.complete": "Notify on task complete",
  "config.question": "Notify on question",
  "config.permission": "Notify on permission",
  "config.todos": "Skip if todos incomplete",
  "config.mainonly": "Main session only",
  "config.todoReminder": "Todo auto-continue",
  "config.todoReminderMax": "Max injections",
  "config.todoReminderCountdown": "Countdown seconds",
  "config.goal": "Goal",

  "dialog.select.title": "Select",
  "dialog.select.on": "On",
  "dialog.select.off": "Off",
  "dialog.lang.title": "Language",
  "dialog.lang.auto": "Auto",
  "dialog.lang.zh": "中文 (Simplified)",
  "dialog.lang.en": "English",

  "toast.changed": "changed to",
  "toast.lang": "Language set to",

  "status.plugin": "Plugin",
  "status.lang": "Language",
  "status.notification": "Notifications",
  "status.complete": "Complete notify",
  "status.question": "Question notify",
  "status.permission": "Permission notify",
  "status.todos": "Skip if todos incomplete",
  "status.mainonly": "Main session only",
  "status.todoReminder": "Todo auto-continue",
  "status.todoReminderMax": "Max injections",
  "status.todoReminderCountdown": "Countdown seconds",
  "status.goal": "Goal",

  "help.toggle": "Master switch for the whole plugin. Turn off to disable all features.",
  "help.notify": "Master switch for notifications. When off, no completion/question/permission toasts are sent.",
  "help.complete": "Show a system notification when a task completes (session becomes idle).",
  "help.question": "Show a system notification when the agent asks you a question.",
  "help.permission": "Show a system notification when the agent needs your permission to continue.",
  "help.todos": "Skip the completion notification while there are unfinished todos.",
  "help.mainonly": "Only notify for the main session; ignore sub-agent completions.",
  "help.todoReminder": "When a session becomes idle with unfinished todos, automatically inject a continuation message so the agent keeps working.",
  "help.todoReminderMax": "Maximum number of continuation injections per session before pausing. Reset when todos make progress.",
  "help.todoReminderCountdown": "Seconds to wait before injecting the continuation message, shown as a countdown toast.",
  "help.goal": "Persistent per-session goal. When active, the agent auto-continues toward it on idle. Disabling also removes the goal tools.",
  "dialog.todoReminderMax": "Enter max injections (positive integer)",
  "dialog.todoReminderCountdown": "Enter countdown seconds (positive integer)",
  "dialog.todoReminderInvalid": "Please enter a positive integer",
  "help.sidebar": "Master switch for the session stats panel.",
  "help.sidebarCache": "Show the cache-hit-rate section in the session stats panel.",
  "help.sidebarTools": "Show the tool-usage counts in the session stats panel.",
  "help.sidebarSubagents": "Show the sub-agent tracking section in the session stats panel.",
  "help.sidebarCollapsed": "Start the session stats panel collapsed (click the header to toggle).",

  "misc.on": "On",
  "misc.off": "Off",

  "sidebar.title": "Session Stats",
  "sidebar.goal.title": "Goal",
  "sidebar.goal.status.active": "active",
  "sidebar.goal.status.paused": "paused",
  "sidebar.goal.status.blocked": "blocked",
  "sidebar.goal.status.budget_limited": "budget limited",
  "sidebar.goal.status.complete": "complete",
  "sidebar.goal.objective": "objective",
  "sidebar.goal.tokens": "tokens",
  "sidebar.goal.time": "time",
  "sidebar.goal.empty": "No active goal",
  "sidebar.scheduling.title": "Scheduled",
  "sidebar.scheduling.cron": "cron",
  "sidebar.scheduling.loop": "loop",
  "sidebar.scheduling.recurring": "recurring",
  "sidebar.scheduling.oneShot": "one-shot",
  "sidebar.scheduling.dynamic": "dynamic",
  "sidebar.scheduling.fixed": "fixed",
  "sidebar.scheduling.empty": "No scheduled tasks",
  "sidebar.yolo.label": "YOLO",
  "sidebar.cache.title": "Cache Hit Rate",
  "sidebar.cache.hitRate": "hit rate",
  "sidebar.cache.input": "input",
  "sidebar.cache.output": "output",
  "sidebar.cache.read": "cache read",
  "sidebar.cache.write": "cache write",
  "sidebar.tools.title": "Tool Usage",
  "sidebar.subagents.title": "Subagents",
  "sidebar.subagents.status.running": "running",
  "sidebar.subagents.status.done": "done",
  "sidebar.subagents.status.error": "error",
  "sidebar.subagents.field.agent": "agent",
  "sidebar.subagents.field.status": "status",
  "sidebar.subagents.field.duration": "duration",
  "sidebar.subagents.field.tokens": "tokens",
  "sidebar.subagents.field.cost": "cost",
  "sidebar.subagents.field.model": "model",
  "sidebar.subagents.field.tools": "tools",
  "sidebar.subagents.open": "Open session",
  "sidebar.empty": "No activity yet",
};
