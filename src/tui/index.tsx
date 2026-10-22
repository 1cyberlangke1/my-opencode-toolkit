import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal, onCleanup, onMount } from "solid-js"

import { resolveMessages, type Messages } from "../i18n/index.ts"
import { formatTokens } from "../shared/format.ts"
import { SETTINGS_COMMAND_ID, SETTINGS_SLASH_NAME, TUI_PLUGIN_ID } from "../shared/identity.ts"
import { DEFAULT_SETTINGS, type Lang, type Settings } from "../shared/settings.ts"
import { toolkitRpc, type PanelData } from "../shared/rpc.ts"

/** 主菜单条目。 */
type MenuChoice = "enabled" | "language" | "notifications" | "goal" | "scheduling" | "sidebar"

/** 侧栏子菜单条目。 */
type SidebarChoice = "enabled" | "showCache" | "showTools" | "showSubagents" | "collapsed"

/** 输入：设置里的语言枚举；输出：`resolveMessages` 需要的 locale。 */
function localeOf(lang: Lang): string | undefined {
  return lang === "auto" ? undefined : lang
}

/**
 * 输入：TUI 上下文、会话 ID、设置访问器、文案访问器。
 * 输出：侧栏面板。
 * 预期：挂载时拉一次数据，之后按会话事件节流刷新。
 */
export function Sidebar(props: {
  readonly context: Context
  readonly sessionID: string
  readonly settings: () => Settings
  readonly copy: () => Messages
}) {
  const rpc = toolkitRpc(props.context.client)
  const [panel, setPanel] = createSignal<PanelData | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined

  /** 拉取面板数据；失败保留上一次结果。 */
  const refresh = (): void => {
    void rpc
      .panelGet({ sessionID: props.sessionID })
      .then((data) => {
        setPanel(data)
      })
      .catch(() => undefined)
  }

  onMount(() => {
    refresh()
    const off = props.context.data.listen(({ details }) => {
      if (
        details.type !== "session.idle" &&
        details.type !== "session.step.ended" &&
        details.type !== "session.usage.updated"
      ) {
        return
      }
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(refresh, 300)
    })
    onCleanup(() => {
      off()
      if (timer !== undefined) clearTimeout(timer)
    })
  })

  /** 输入：状态字符串；输出：本地化状态名。 */
  const statusLabel = (text: Messages, status: string): string => text.panel.status[status] ?? status

  const goalLine = (): string => {
    const text = props.copy()
    const goal = panel()?.goal
    if (goal === null || goal === undefined) return `${text.panel.goal}: ${text.panel.noGoal}`
    const budget = goal.tokenBudget === undefined ? "" : ` / ${formatTokens(goal.tokenBudget)}`
    return `${text.panel.goal}: ${goal.objective} · ${statusLabel(text, goal.status)} · ${formatTokens(goal.tokensUsed)}${budget}`
  }

  const cacheLine = (): string => {
    const text = props.copy()
    const stats = panel()?.stats
    if (stats === undefined) return `${text.panel.cache}: --`
    return `${text.panel.cache}: ${stats.hitRate.toFixed(2)}% · ${formatTokens(stats.input)} / ${formatTokens(stats.output)}`
  }

  const toolsLine = (): string => {
    const text = props.copy()
    const stats = panel()?.stats
    if (stats === undefined || stats.tools.length === 0) return `${text.panel.tools}: --`
    const top = stats.tools
      .slice(0, 3)
      .map((tool) => `${tool.name} ${String(tool.count)}`)
      .join(" · ")
    return `${text.panel.tools}: ${top}`
  }

  const subagentsLine = (): string => {
    const text = props.copy()
    return `${text.panel.subagents}: ${String(panel()?.stats.subagents ?? 0)}`
  }

  const scheduleLine = (): string => {
    const text = props.copy()
    const loops = panel()?.loops.length ?? 0
    const jobs = panel()?.jobs.length ?? 0
    return `${text.panel.loops}: ${String(loops)} · ${text.panel.jobs}: ${String(jobs)}`
  }

  return (
    <box flexDirection="column">
      <text>{props.copy().panel.title}</text>
      {props.settings().sidebar.enabled && !props.settings().sidebar.collapsed ? (
        <box flexDirection="column">
          <text>{goalLine()}</text>
          {props.settings().sidebar.showCache ? <text>{cacheLine()}</text> : null}
          {props.settings().sidebar.showTools ? <text>{toolsLine()}</text> : null}
          {props.settings().sidebar.showSubagents ? <text>{subagentsLine()}</text> : null}
          <text>{scheduleLine()}</text>
        </box>
      ) : null}
    </box>
  )
}

/**
 * 输入：TUI 插件上下文（含插件 options）。
 * 输出：侧栏面板 + `/my-opencode-toolkit` 设置命令。
 * 预期：设置以服务端存储为准，启动时通过 RPC 读取；写入失败时回滚本地值。
 *       keymap 层在 setup 作用域注册，生命周期跟随插件，不依赖某个 slot 组件是否挂载。
 */
export default Plugin.define({
  id: TUI_PLUGIN_ID,

  async setup(context) {
    const rpc = toolkitRpc(context.client)
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

    const copy = (): Messages => resolveMessages(localeOf(settings().lang))

    // Plan 模式跳过 cron/loop 时由服务端发 toast 事件；文案在 TUI 侧按当前语言解析。
    const offToast = rpc.events.on("toast", (event) => {
      const text = copy()
      context.ui.toast.show({
        message: event.data.kind === "cron" ? text.toast.planSkippedCron : text.toast.planSkippedLoop,
        variant: "warning",
      })
    })

    /** 选择语言并写回。 */
    const chooseLanguage = async (): Promise<void> => {
      const picked = await context.ui.dialog.select<Lang>({
        title: copy().menu.language,
        current: settings().lang,
        options: [
          { title: copy().menu.auto, value: "auto" },
          { title: copy().menu.chinese, value: "zh" },
          { title: copy().menu.english, value: "en" },
        ],
      })
      if (picked === undefined) return
      await update({ ...settings(), lang: picked })
    }

    /** 侧栏子菜单：逐项切换显示开关。 */
    const chooseSidebar = async (): Promise<void> => {
      for (;;) {
        const current = settings()
        const text = copy()
        const onOff = (value: boolean): string => (value ? text.menu.on : text.menu.off)
        const choice = await context.ui.dialog.select<SidebarChoice>({
          title: text.menu.sidebar,
          options: [
            { title: text.menu.enabled, value: "enabled", footer: onOff(current.sidebar.enabled) },
            { title: text.menu.showCache, value: "showCache", footer: onOff(current.sidebar.showCache) },
            { title: text.menu.showTools, value: "showTools", footer: onOff(current.sidebar.showTools) },
            { title: text.menu.showSubagents, value: "showSubagents", footer: onOff(current.sidebar.showSubagents) },
            { title: text.menu.collapsed, value: "collapsed", footer: onOff(current.sidebar.collapsed) },
          ],
        })
        if (choice === undefined) return
        const next = { ...current.sidebar, [choice]: !current.sidebar[choice] }
        await update({ ...current, sidebar: next })
      }
    }

    /**
     * 输入：要切换的条目。
     * 输出：无。
     * 预期：只改对应字段，其余设置保持不变。
     */
    const toggle = async (choice: Exclude<MenuChoice, "language" | "sidebar">): Promise<void> => {
      const current = settings()
      switch (choice) {
        case "enabled":
          await update({ ...current, enabled: !current.enabled })
          return
        case "notifications":
          await update({
            ...current,
            notification: { ...current.notification, enabled: !current.notification.enabled },
          })
          return
        case "goal":
          await update({ ...current, goal: { enabled: !current.goal.enabled } })
          return
        case "scheduling":
          await update({ ...current, scheduling: { enabled: !current.scheduling.enabled } })
          return
      }
    }

    /** 打开菜单；选择语言/侧栏进入子菜单，其余条目原地切换后重开。 */
    const openMenu = async (): Promise<void> => {
      for (;;) {
        const current = settings()
        const text = copy()
        const onOff = (value: boolean): string => (value ? text.menu.on : text.menu.off)
        const choice = await context.ui.dialog.select<MenuChoice>({
          title: text.menu.title,
          options: [
            { title: text.menu.enabled, value: "enabled", footer: onOff(current.enabled) },
            { title: text.menu.language, value: "language", footer: current.lang },
            { title: text.menu.notifications, value: "notifications", footer: onOff(current.notification.enabled) },
            { title: text.menu.goal, value: "goal", footer: onOff(current.goal.enabled) },
            { title: text.menu.scheduling, value: "scheduling", footer: onOff(current.scheduling.enabled) },
            { title: text.menu.sidebar, value: "sidebar", footer: onOff(current.sidebar.enabled) },
          ],
        })
        if (choice === undefined) return
        if (choice === "language") {
          await chooseLanguage()
          continue
        }
        if (choice === "sidebar") {
          await chooseSidebar()
          continue
        }
        await toggle(choice)
      }
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: SETTINGS_COMMAND_ID,
          title: copy().command.title,
          description: copy().command.description,
          group: copy().command.group,
          slash: { name: SETTINGS_SLASH_NAME },
          palette: true,
          run() {
            void openMenu()
          },
        },
      ],
    }))

    const disposePanel = context.ui.slot({
      append: "sidebar.content",
      render: (input) => (
        <Sidebar context={context} sessionID={input.sessionID} settings={settings} copy={copy} />
      ),
    })

    return () => {
      offToast()
      disposePanel()
    }
  },
})
