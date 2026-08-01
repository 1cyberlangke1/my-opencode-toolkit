export interface TranslationDict {
  // Notification messages
  "notification.completed": string;
  "notification.question": string;
  "notification.permission": string;
  "notification.title": string;
  "notification.user": string;
  "notification.assistant": string;
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
  // Help texts shown in the on/off dialogs
  "help.toggle": string;
  "help.notify": string;
  "help.complete": string;
  "help.question": string;
  "help.permission": string;
  "help.todos": string;
  "help.mainonly": string;
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

  "cmd.mot.title": "My OpenCode Toolkit: Settings",
  "cmd.mot.desc": "Open toolkit settings",
  "cmd.status.title": "My OpenCode Toolkit: Status",
  "cmd.status.desc": "Show toolkit status",
  "cmd.lang.title": "My OpenCode Toolkit: Language",
  "cmd.lang.desc": "Switch language",

  "config.title": "My OpenCode Toolkit",
  "config.general": "General",
  "config.notificationGroup": "Notifications",
  "config.sidebarGroup": "Sidebar",
  "config.return": "← Back",
  "config.closed": "Settings closed",

  "config.sidebar": "Sidebar panel",
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

  "help.toggle": "Master switch for the whole plugin. Turn off to disable all features.",
  "help.notify": "Master switch for notifications. When off, no completion/question/permission toasts are sent.",
  "help.complete": "Show a system notification when a task completes (session becomes idle).",
  "help.question": "Show a system notification when the agent asks you a question.",
  "help.permission": "Show a system notification when the agent needs your permission to continue.",
  "help.todos": "Skip the completion notification while there are unfinished todos.",
  "help.mainonly": "Only notify for the main session; ignore sub-agent completions.",
  "help.sidebar": "Master switch for the sidebar stats panel.",
  "help.sidebarCache": "Show the cache-hit-rate section in the sidebar panel.",
  "help.sidebarTools": "Show the tool-usage counts in the sidebar panel.",
  "help.sidebarSubagents": "Show the sub-agent tracking section in the sidebar panel.",
  "help.sidebarCollapsed": "Start the sidebar panel collapsed (click the header to toggle).",

  "misc.on": "On",
  "misc.off": "Off",

  "sidebar.title": "Session Stats",
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
