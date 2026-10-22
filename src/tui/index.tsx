import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal } from "solid-js"

import { resolveMessages, type Messages } from "../i18n/index.ts"
import { DEFAULT_SETTINGS, type Lang, type Settings } from "../shared/settings.ts"
import { toolkitRpc, type ToolkitRpcClient } from "../shared/rpc.ts"

/** 设置菜单里可选的条目。 */
type MenuChoice = "enabled" | "language" | "notifications" | "goal" | "scheduling" | "sidebar"

/**
 * 输入：设置里的语言枚举。
 * 输出：`resolveMessages` 需要的 locale。
 * 预期：`auto` 传 `undefined`，让它回退到系统 locale。
 */
function localeOf(lang: Lang): string | undefined {
  return lang === "auto" ? undefined : lang
}

/**
 * 输入：设置访问器 + 文案访问器。
 * 输出：侧栏里的一块状态文字。
 * 预期：设置变化时随访问器重新求值。
 */
function Sidebar(props: {
  readonly settings: () => Settings
  readonly copy: () => Messages
}) {
  return (
    <box flexDirection="column">
      <text>{props.copy().sidebar.title}</text>
      <text>{props.settings().enabled ? props.copy().sidebar.on : props.copy().sidebar.off}</text>
    </box>
  )
}

/**
 * 输入：TUI 上下文 + 设置访问器 + 写入函数。
 * 输出：无渲染内容；注册 `/my-opencode-toolkit` 命令。
 * 预期：命令打开循环菜单，每次选择后写回设置并重开菜单；Esc 返回上一级。
 */
function SettingsCommand(props: {
  readonly context: Context
  readonly settings: () => Settings
  readonly update: (next: Settings) => Promise<void>
}) {
  const copy = (): Messages => resolveMessages(localeOf(props.settings().lang))

  /** 选择语言并写回。 */
  const chooseLanguage = async (): Promise<void> => {
    const picked = await props.context.ui.dialog.select<Lang>({
      title: copy().menu.language,
      current: props.settings().lang,
      options: [
        { title: copy().menu.auto, value: "auto" },
        { title: copy().menu.chinese, value: "zh" },
        { title: copy().menu.english, value: "en" },
      ],
    })
    if (picked === undefined) return
    await props.update({ ...props.settings(), lang: picked })
  }

  /**
   * 输入：要切换的条目。
   * 输出：无。
   * 预期：只改对应字段，其余设置保持不变。
   */
  const toggle = async (choice: Exclude<MenuChoice, "language">): Promise<void> => {
    const current = props.settings()
    switch (choice) {
      case "enabled":
        await props.update({ ...current, enabled: !current.enabled })
        return
      case "notifications":
        await props.update({
          ...current,
          notification: { ...current.notification, enabled: !current.notification.enabled },
        })
        return
      case "goal":
        await props.update({ ...current, goal: { enabled: !current.goal.enabled } })
        return
      case "scheduling":
        await props.update({ ...current, scheduling: { enabled: !current.scheduling.enabled } })
        return
      case "sidebar":
        await props.update({ ...current, sidebar: { ...current.sidebar, enabled: !current.sidebar.enabled } })
        return
    }
  }

  /** 打开菜单；选择语言进入子菜单，其余条目原地切换后重开。 */
  const openMenu = async (): Promise<void> => {
    for (;;) {
      const current = props.settings()
      const text = copy()
      const choice = await props.context.ui.dialog.select<MenuChoice>({
        title: text.menu.title,
        options: [
          {
            title: text.menu.enabled,
            value: "enabled",
            footer: current.enabled ? text.menu.on : text.menu.off,
          },
          {
            title: text.menu.language,
            value: "language",
            footer: current.lang,
          },
          {
            title: text.menu.notifications,
            value: "notifications",
            footer: current.notification.enabled ? text.menu.on : text.menu.off,
          },
          {
            title: text.menu.goal,
            value: "goal",
            footer: current.goal.enabled ? text.menu.on : text.menu.off,
          },
          {
            title: text.menu.scheduling,
            value: "scheduling",
            footer: current.scheduling.enabled ? text.menu.on : text.menu.off,
          },
          {
            title: text.menu.sidebar,
            value: "sidebar",
            footer: current.sidebar.enabled ? text.menu.on : text.menu.off,
          },
        ],
      })
      if (choice === undefined) return
      if (choice === "language") {
        await chooseLanguage()
      } else {
        await toggle(choice)
      }
    }
  }

  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "my-opencode-toolkit.settings",
        title: copy().command.title,
        description: copy().command.description,
        group: copy().command.group,
        slash: { name: "my-opencode-toolkit" },
        palette: true,
        run() {
          void openMenu()
        },
      },
    ],
  }))

  return null
}

/**
 * 输入：TUI 插件上下文（含插件 options）。
 * 输出：侧栏状态块 + `/my-opencode-toolkit` 设置命令。
 * 预期：设置以服务端存储为准，启动时通过 RPC 读取；写入失败时回滚本地值。
 */
export default Plugin.define({
  id: "my-opencode-toolkit.tui",

  async setup(context) {
    const rpc: ToolkitRpcClient = toolkitRpc(context.client)

    const initial = await rpc.settingsGet({}).catch((): Settings => DEFAULT_SETTINGS)

    const [settings, setSettings] = createSignal<Settings>(initial)

    /**
     * 输入：新设置。
     * 输出：无。
     * 预期：先乐观更新界面，服务端确认后用返回值覆盖；失败则回滚。
     */
    const update = async (next: Settings): Promise<void> => {
      const previous = settings()
      setSettings(next)
      try {
        setSettings(await rpc.settingsSet(next))
      } catch {
        setSettings(previous)
      }
    }

    const disposePanel = context.ui.slot({
      append: "sidebar.content",
      render: () => <Sidebar settings={settings} copy={() => resolveMessages(localeOf(settings().lang))} />,
    })

    const disposeCommand = context.ui.slot({
      append: "app",
      render: () => <SettingsCommand context={context} settings={settings} update={update} />,
    })

    return () => {
      disposePanel()
      disposeCommand()
    }
  },
})
