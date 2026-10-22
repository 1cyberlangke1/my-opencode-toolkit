import type { Messages } from "./types.ts"

/** 英文文案。 */
export const en: Messages = {
  command: {
    title: "Toolkit settings",
    description: "Open my-opencode-toolkit settings",
    group: "Plugins",
  },
  menu: {
    title: "my-opencode-toolkit",
    enabled: "Enabled",
    language: "Language",
    notifications: "Notifications",
    goal: "Goal",
    scheduling: "Scheduling",
    sidebar: "Sidebar",
    on: "on",
    off: "off",
    auto: "auto",
    chinese: "Chinese",
    english: "English",
    showCache: "Cache",
    showTools: "Tools",
    showSubagents: "Subagents",
    collapsed: "Collapsed",
  },
  panel: {
    title: "Toolkit",
    goal: "Goal",
    noGoal: "none",
    loops: "Loops",
    jobs: "Jobs",
    cache: "Cache",
    tools: "Tools",
    subagents: "Subagents",
    status: {
      active: "active",
      paused: "paused",
      blocked: "blocked",
      budget_limited: "budget limited",
      complete: "complete",
    },
  },
  sidebar: {
    title: "Toolkit",
    on: "enabled",
    off: "disabled",
  },
  notification: {
    title: "OpenCode",
    completed: "Task completed",
    question: "The agent is asking a question",
    permission: "Permission required",
    user: "User",
    assistant: "Assistant",
  },
  tool: {
    pingResult: (enabled, lang) => `my-opencode-toolkit: enabled=${String(enabled)}, lang=${lang}`,
  },
}
