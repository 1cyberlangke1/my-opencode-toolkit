import type { Messages } from "./types.ts"

/** 中文文案。 */
export const zh: Messages = {
  command: {
    title: "工具包设置",
    description: "打开 my-opencode-toolkit 设置",
    group: "插件",
  },
  menu: {
    title: "my-opencode-toolkit",
    enabled: "启用",
    language: "语言",
    notifications: "通知",
    goal: "目标",
    scheduling: "定时任务",
    sidebar: "侧栏",
    on: "开",
    off: "关",
    auto: "自动",
    chinese: "中文",
    english: "English",
    showCache: "缓存",
    showTools: "工具",
    showSubagents: "子代理",
    collapsed: "折叠",
  },
  panel: {
    title: "工具包",
    goal: "目标",
    noGoal: "无",
    loops: "循环",
    jobs: "定时",
    cache: "缓存",
    tools: "工具",
    subagents: "子代理",
    status: {
      active: "进行中",
      paused: "已暂停",
      blocked: "已阻塞",
      budget_limited: "预算用尽",
      complete: "已完成",
    },
  },
  sidebar: {
    title: "工具包",
    on: "已启用",
    off: "已禁用",
  },
  notification: {
    title: "OpenCode",
    completed: "任务完成",
    question: "代理正在提问",
    permission: "需要权限确认",
    user: "用户",
    assistant: "助手",
  },
  tool: {
    pingResult: (enabled, lang) => `my-opencode-toolkit：启用=${enabled ? "是" : "否"}，语言=${lang}`,
  },
}
