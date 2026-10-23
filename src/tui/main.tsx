import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"

import { resolveMessages, type Messages } from "../i18n/index.ts"
import { formatTokens } from "../shared/format.ts"
import { SETTINGS_COMMAND_ID, SETTINGS_SLASH_NAME, TUI_PLUGIN_ID } from "../shared/identity.ts"
import { DEFAULT_SETTINGS, type Lang, type Settings } from "../shared/settings.ts"
import { toolkitRpc, type PanelData, type PanelSubagent, type PanelSubagentDetail } from "../shared/rpc.ts"
import { countdownColor, hitRateColor } from "./color.ts"
import { configFileLayers } from "./config-layers.ts"
import { formatAgo, formatCountdown, padRight, truncate } from "./format.ts"

/** 主菜单条目。 */
type MenuChoice = "language" | "goal" | "scheduling" | "sidebar" | "contextStats" | "notifications"

/** RPC 路由选项：必须带上本插件 location，请求才会打到正确实例。 */
const rpcOptions = (context: Context): { readonly location?: { readonly directory: string } } =>
  context.location?.directory === undefined ? {} : { location: { directory: context.location.directory } }

/** 目标子菜单条目。 */
type GoalChoice = "enabled" | "showInSidebar"

/** 定时任务子菜单条目。 */
type SchedulingChoice = "enabled" | "showInSidebar"

/** 侧栏子菜单条目：目标/定时任务的侧栏开关也归到这里。 */
type SidebarChoice = "goal" | "scheduling" | "showTools" | "showSubagents"

/** 上下文统计子菜单条目。 */
type ContextStatsChoice = "enabled" | "showInput" | "showOutput" | "showCache" | "showHitRate"

/** 通知子菜单条目。 */
type NotificationChoice = "enabled" | "onComplete" | "onQuestion" | "onPermission" | "onlyMainSession"

/** 输入：设置里的语言枚举；输出：`resolveMessages` 需要的 locale。 */
function localeOf(lang: Lang): string | undefined {
  return lang === "auto" ? undefined : lang
}

/** 侧栏分区；每个分区注册成独立 slot，由宿主 gap 产生空行。 */
export type SidebarSection = "goal" | "scheduling" | "tools" | "subagents"

/** 输入：TUI 上下文、会话 ID、设置访问器、文案访问器、要渲染的分区。
 * 输出：侧栏分区。
 * 预期：挂载时拉一次数据，之后按会话事件节流刷新；子代理详情只在展开时请求。
 */
export function Sidebar(props: {
  readonly context: Context
  readonly sessionID: string
  readonly settings: () => Settings
  readonly copy: () => Messages
  readonly section: SidebarSection
}) {
  const rpc = toolkitRpc(props.context.client)
  const [panel, setPanel] = createSignal<PanelData | null>(null)
  const [now, setNow] = createSignal(Date.now())
  const [goalOpen, setGoalOpen] = createSignal(true)
  const [schedulingOpen, setSchedulingOpen] = createSignal(true)
  const [toolsOpen, setToolsOpen] = createSignal(true)
  const [subagentsOpen, setSubagentsOpen] = createSignal(true)
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())
  const [details, setDetails] = createSignal<
    Readonly<Record<string, PanelSubagentDetail | "loading" | "error">>
  >({})
  let timer: ReturnType<typeof setTimeout> | undefined

  /** 拉取面板数据；失败保留上一次结果。 */
  const refresh = (): void => {
    void rpc
      .panelGet({ sessionID: props.sessionID }, rpcOptions(props.context))
      .then((data) => {
        setPanel(data)
        setNow(Date.now())
      })
      .catch(() => undefined)
  }

  onMount(() => {
    refresh()
    const off = props.context.data.listen(({ details: event }) => {
      if (
        event.type !== "session.idle" &&
        event.type !== "session.step.ended" &&
        event.type !== "session.usage.updated"
      ) {
        return
      }
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(refresh, 50)
    })
    const offPanel = rpc.events.on("panelUpdated", () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(refresh, 50)
    })
    const clock = setInterval(() => setNow(Date.now()), 1_000)
    onCleanup(() => {
      off()
      offPanel()
      if (timer !== undefined) clearTimeout(timer)
      clearInterval(clock)
    })
  })

  const theme = props.context.theme
  const base = () => theme.text.base
  const muted = () => theme.text.muted
  const success = () => theme.text.feedback.success.base
  const warning = () => theme.text.feedback.warning.base
  const error = () => theme.text.feedback.error.base
  const info = () => theme.text.feedback.info.base

  /** 输入：状态字符串；输出：本地化状态名。 */
  const statusLabel = (text: Messages, status: string): string => text.panel.status[status] ?? status

  /** 输入：状态字符串；输出：目标状态颜色。 */
  const goalStatusColor = (status: string) => {
    if (status === "active") return success()
    if (status === "complete") return info()
    if (status === "paused" || status === "budget_limited") return warning()
    if (status === "blocked") return error()
    return base()
  }

  /** 输入：子代理 outcome；输出：状态颜色。 */
  const subagentStatusColor = (outcome: PanelSubagent["outcome"]) => {
    if (outcome === "succeeded") return success()
    if (outcome === "failed" || outcome === "interrupted") return error()
    return warning()
  }

  /** 输入：标签 + 值 + 颜色；输出：对齐后的单行。 */
  const labelRow = (
    label: string,
    value: string,
    color: string | ReturnType<typeof base> = base(),
  ) => (
    <text>
      <span style={{ fg: muted() }}>{padRight(`${label}:`, 8)}</span>
      <span style={{ fg: color }}>{value}</span>
    </text>
  )

  /** 输入：标题 + 展开状态 + 切换函数 + 可选计数；输出：可点击的分区标题。 */
  const sectionHeader = (label: string, open: boolean, toggle: () => void, count?: number) => (
    <box flexDirection="row" height={1} onMouseDown={toggle}>
      <box flexDirection="row" gap={1}>
        <text fg={base()}>{open ? "▼" : "▶"}</text>
        <text fg={base()}>
          <b>{label}</b>
        </text>
        <Show when={count !== undefined}>
          <text fg={muted()}>{`(${String(count)})`}</text>
        </Show>
      </box>
    </box>
  )

  /** 输入：子代理；输出：无；预期：切换折叠，首次展开时拉详情。 */
  const toggleSubagent = (subagent: PanelSubagent): void => {
    const wasOpen = expanded().has(subagent.id)
    const next = new Set(expanded())
    if (wasOpen) next.delete(subagent.id)
    else next.add(subagent.id)
    setExpanded(next)

    if (!wasOpen && details()[subagent.id] === undefined) {
      setDetails((current) => ({ ...current, [subagent.id]: "loading" }))
      void rpc
        .subagentGet({ sessionID: subagent.id }, rpcOptions(props.context))
        .then((detail) => {
          setDetails((current) => ({ ...current, [subagent.id]: detail }))
        })
        .catch(() => {
          setDetails((current) => ({ ...current, [subagent.id]: "error" }))
        })
    }
  }

  const goal = (): PanelData["goal"] => panel()?.goal ?? null
  /** 输入：无；输出：目标已用毫秒。预期：active 时按 updatedAt 每秒递增。 */
  const goalTimeMs = (): number => {
    const current = goal()
    if (current === null) return 0
    const base = current.timeUsedSeconds * 1000
    const extra = current.status === "active" ? Math.max(0, now() - current.updatedAt * 1000) : 0
    return base + extra
  }
  /** 输入：无；输出：目标用量文本。预期：有拆分时用 ↑/↓/♻ 紧凑格式；♻ 后两个空格。 */
  const goalUsageText = (): string => {
    const current = goal()
    if (current === null) return ""
    const budget = current.tokenBudget === undefined ? "" : ` / ${formatTokens(current.tokenBudget)}`
    if (
      current.inputTokens === undefined ||
      current.outputTokens === undefined ||
      current.cachedTokens === undefined
    ) {
      return `${formatTokens(current.tokensUsed)}${budget}`
    }
    return `↑ ${formatTokens(current.inputTokens)} ↓ ${formatTokens(current.outputTokens)} ♻  ${formatTokens(current.cachedTokens)}${budget}`
  }
  const subagents = (): readonly PanelSubagent[] => panel()?.subagents ?? []
  const visibleTools = (): readonly { readonly name: string; readonly count: number }[] =>
    (panel()?.stats.tools ?? []).filter((tool) => tool.count > 0)

  return (
    <>
        <Show
          when={
            props.section === "goal" &&
            props.settings().goal.enabled &&
            props.settings().goal.showInSidebar &&
            goal() !== null
          }
        >
          <box flexDirection="column" gap={0}>
            {sectionHeader(props.copy().panel.goal, goalOpen(), () => {
              setGoalOpen(!goalOpen())
            })}
            <Show when={goalOpen()}>
              <box paddingLeft={2} flexDirection="column" gap={0}>
                {labelRow(props.copy().panel.goal, truncate(goal()?.objective ?? "", 22))}
                {labelRow(
                  props.copy().panel.state,
                  statusLabel(props.copy(), goal()?.status ?? ""),
                  goalStatusColor(goal()?.status ?? ""),
                )}
                {labelRow(props.copy().panel.usage, goalUsageText())}
                {labelRow(props.copy().panel.time, formatCountdown(goalTimeMs()))}
              </box>
            </Show>
          </box>
        </Show>

        <Show
          when={
            props.section === "scheduling" &&
            props.settings().scheduling.enabled &&
            props.settings().scheduling.showInSidebar &&
            ((panel()?.jobs.length ?? 0) > 0 || (panel()?.loops.length ?? 0) > 0)
          }
        >
          <box flexDirection="column" gap={0}>
            {sectionHeader(props.copy().panel.scheduling, schedulingOpen(), () => {
              setSchedulingOpen(!schedulingOpen())
            })}
            <Show when={schedulingOpen()}>
              <box paddingLeft={2} flexDirection="column" gap={0}>
                <For each={panel()?.jobs ?? []}>
                  {(job) => (
                    <text>
                      <span style={{ fg: muted() }}>⏰ </span>
                      <span style={{ fg: base() }}>{truncate(job.cron, 12)}</span>
                      <span style={{ fg: muted() }}> · {props.copy().panel.next} </span>
                      <span style={{ fg: countdownColor((job.nextRunAt ?? now()) - now()) }}>
                        {formatCountdown((job.nextRunAt ?? now()) - now())}
                      </span>
                    </text>
                  )}
                </For>
                <For each={panel()?.loops ?? []}>
                  {(loop) => (
                    <text>
                      <span style={{ fg: muted() }}>🔁 </span>
                      <span style={{ fg: base() }}>{truncate(loop.prompt, 12)}</span>
                      <span style={{ fg: muted() }}> · {props.copy().panel.next} </span>
                      <span style={{ fg: countdownColor((loop.nextFireAt ?? now()) - now()) }}>
                        {formatCountdown((loop.nextFireAt ?? now()) - now())}
                      </span>
                    </text>
                  )}
                </For>
              </box>
            </Show>
          </box>
        </Show>

        <Show
          when={
            props.section === "tools" &&
            props.settings().sidebar.showTools &&
            visibleTools().length > 0
          }
        >
          <box flexDirection="column" gap={0}>
            {sectionHeader(
              props.copy().panel.tools,
              toolsOpen(),
              () => {
                setToolsOpen(!toolsOpen())
              },
              visibleTools().length,
            )}
            <Show when={toolsOpen()}>
              <box paddingLeft={2} flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={0}>
                <For each={visibleTools()}>
                  {(tool) => (
                    <text flexShrink={0}>
                      <span style={{ fg: base() }}>[{tool.name}]</span>
                      <span style={{ fg: muted() }}>({String(tool.count)})</span>
                    </text>
                  )}
                </For>
              </box>
            </Show>
          </box>
        </Show>

        <Show
          when={
            props.section === "subagents" &&
            props.settings().sidebar.showSubagents &&
            subagents().length > 0
          }
        >
          <box flexDirection="column" gap={0}>
            {sectionHeader(props.copy().panel.subagents, subagentsOpen(), () => {
              setSubagentsOpen(!subagentsOpen())
            })}
            <Show when={subagentsOpen()}>
              <box paddingLeft={2} flexDirection="column" gap={0}>
                <For each={subagents()}>
                  {(subagent) => {
                    const open = (): boolean => expanded().has(subagent.id)
                    return (
                      <box flexDirection="column" gap={0}>
                        <text
                          onMouseUp={() => {
                            toggleSubagent(subagent)
                          }}
                        >
                          <span style={{ fg: base() }}>{open() ? "▼ " : "▶ "}</span>
                          <span style={{ fg: subagentStatusColor(subagent.outcome) }}>● </span>
                          <span style={{ fg: base() }}>{truncate(subagent.title, 16)}</span>
                          <span style={{ fg: muted() }}>
                            {" "}
                            · {formatAgo(subagent.updatedAt, now())} {props.copy().panel.ago}
                          </span>
                        </text>
                        <Show when={open()}>
                          <box paddingLeft={2} flexDirection="column" gap={0}>
                            {labelRow(props.copy().panel.input, formatTokens(subagent.input))}
                            {labelRow(props.copy().panel.output, formatTokens(subagent.output))}
                            {labelRow(props.copy().panel.cached, formatTokens(subagent.cached))}
                            {(() => {
                              const detail = details()[subagent.id]
                              if (detail === undefined || detail === "loading") {
                                return <text fg={muted()}>{props.copy().panel.loading}</text>
                              }
                              if (detail === "error") {
                                return <text fg={error()}>{props.copy().panel.error}</text>
                              }
                              return (
                                <box flexDirection="column" gap={0}>
                                  {labelRow(props.copy().panel.hitRate, `${detail.hitRate.toFixed(2)}%`, hitRateColor(detail.hitRate))}
                                  <Show
                                    when={detail.tools.length > 0}
                                    fallback={<text fg={muted()}>{props.copy().panel.noGoal}</text>}
                                  >
                                    <For each={detail.tools.filter((tool) => tool.count > 0)}>
                                      {(tool) => labelRow(tool.name, String(tool.count))}
                                    </For>
                                  </Show>
                                </box>
                              )
                            })()}
                          </box>
                        </Show>
                      </box>
                    )
                  }}
                </For>
              </box>
            </Show>
          </box>
        </Show>
    </>
  )
}

/**
 * 输入：TUI 上下文 + 会话 ID + 设置访问器 + 文案访问器。
 * 输出：prompt footer 的上下文统计单行。
 * 预期：只有命中率染色；字段由 contextStats 设置逐项开关。
 */
export function ContextStats(props: {
  readonly context: Context
  readonly sessionID: string
  readonly settings: () => Settings
  readonly copy: () => Messages
}) {
  const rpc = toolkitRpc(props.context.client)
  const [panel, setPanel] = createSignal<PanelData | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined

  const refresh = (): void => {
    void rpc.panelGet({ sessionID: props.sessionID }, rpcOptions(props.context)).then(setPanel).catch(() => undefined)
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
      timer = setTimeout(refresh, 50)
    })
    const offPanel = rpc.events.on("panelUpdated", () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(refresh, 50)
    })
    onCleanup(() => {
      off()
      offPanel()
      if (timer !== undefined) clearTimeout(timer)
    })
  })

  const theme = props.context.theme
  const base = () => theme.text.base
  const muted = () => theme.text.muted

  const parts = (): readonly { readonly text: string; readonly color?: string }[] => {
    const settings = props.settings().contextStats
    if (!settings.enabled) return []
    const stats = panel()?.stats
    const result: { text: string; color?: string }[] = []
    if (settings.showInput) result.push({ text: `↑ ${formatTokens(stats?.input ?? 0)}` })
    if (settings.showOutput) result.push({ text: `↓ ${formatTokens(stats?.output ?? 0)}` })
    if (settings.showCache) result.push({ text: `♻  ${formatTokens(stats?.cached ?? 0)}` })
    if (settings.showHitRate) {
      result.push({
        text: `🎯 ${(stats?.hitRate ?? 0).toFixed(2)}%`,
        color: hitRateColor(stats?.hitRate ?? 0),
      })
    }
    return result
  }

  return (
    <Show when={props.settings().contextStats.enabled && parts().length > 0}>
      <text wrapMode="none">
        <For each={parts()}>
          {(part, index) => (
            <>
              <Show when={index() > 0}>
                <span style={{ fg: muted() }}> </span>
              </Show>
              <span style={{ fg: part.color ?? base() }}>{part.text}</span>
            </>
          )}
        </For>
      </text>
    </Show>
  )
}

/**
 * 输入：TUI 插件上下文（含插件 options）。
 * 输出：侧栏面板 + `/my-opencode-toolkit` 设置命令。
 * 预期：设置以服务端存储为准，启动时通过 RPC 读取；写入失败时回滚本地值。
 */
export default Plugin.define({
  id: TUI_PLUGIN_ID,

  async setup(context) {
    const rpc = toolkitRpc(context.client)
    const callOptions = rpcOptions(context)
    const layers = await configFileLayers(context)
    const initial = await rpc.settingsGet({ layers }, callOptions).catch((): Settings => DEFAULT_SETTINGS)
    const [settings, setSettings] = createSignal<Settings>(initial)

    /** 输入：新设置；输出：无；预期：先乐观更新，失败回滚。 */
    const update = async (next: Settings): Promise<void> => {
      const previous = settings()
      setSettings(next)
      try {
        setSettings(await rpc.settingsSet({ ...next, layers }, callOptions))
      } catch {
        setSettings(previous)
      }
    }

    const copy = (): Messages => resolveMessages(localeOf(settings().lang))

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

    const onOff = (value: boolean): string => (value ? copy().menu.on : copy().menu.off)

    /** 目标子菜单：功能与侧栏显示独立。 */
    const chooseGoal = async (): Promise<void> => {
      for (;;) {
        const current = settings()
        const text = copy()
        const choice = await context.ui.dialog.select<GoalChoice>({
          title: text.menu.goal,
          options: [
            { title: text.menu.function, value: "enabled", footer: onOff(current.goal.enabled) },
          ],
        })
        if (choice === undefined) return
        await update({
          ...current,
          goal: { ...current.goal, [choice]: !current.goal[choice] },
        })
      }
    }

    /** 定时任务子菜单：功能与侧栏显示独立。 */
    const chooseScheduling = async (): Promise<void> => {
      for (;;) {
        const current = settings()
        const text = copy()
        const choice = await context.ui.dialog.select<SchedulingChoice>({
          title: text.menu.scheduling,
          options: [
            { title: text.menu.function, value: "enabled", footer: onOff(current.scheduling.enabled) },
          ],
        })
        if (choice === undefined) return
        await update({
          ...current,
          scheduling: { ...current.scheduling, [choice]: !current.scheduling[choice] },
        })
      }
    }

    /** 侧栏显示子菜单。 */
    const chooseSidebar = async (): Promise<void> => {
      for (;;) {
        const current = settings()
        const text = copy()
        const choice = await context.ui.dialog.select<SidebarChoice>({
          title: text.menu.sidebar,
          options: [
            { title: text.menu.goal, value: "goal", footer: onOff(current.goal.showInSidebar) },
            { title: text.menu.scheduling, value: "scheduling", footer: onOff(current.scheduling.showInSidebar) },
            { title: text.menu.showTools, value: "showTools", footer: onOff(current.sidebar.showTools) },
            { title: text.menu.showSubagents, value: "showSubagents", footer: onOff(current.sidebar.showSubagents) },
          ],
        })
        if (choice === undefined) return
        if (choice === "goal") {
          await update({ ...current, goal: { ...current.goal, showInSidebar: !current.goal.showInSidebar } })
          continue
        }
        if (choice === "scheduling") {
          await update({
            ...current,
            scheduling: { ...current.scheduling, showInSidebar: !current.scheduling.showInSidebar },
          })
          continue
        }
        await update({ ...current, sidebar: { ...current.sidebar, [choice]: !current.sidebar[choice] } })
      }
    }

    /** 底部上下文统计子菜单。 */
    const chooseContextStats = async (): Promise<void> => {
      for (;;) {
        const current = settings()
        const text = copy()
        const choice = await context.ui.dialog.select<ContextStatsChoice>({
          title: text.menu.contextStats,
          options: [
            { title: text.menu.showLine, value: "enabled", footer: onOff(current.contextStats.enabled) },
            { title: text.menu.showInput, value: "showInput", footer: onOff(current.contextStats.showInput) },
            { title: text.menu.showOutput, value: "showOutput", footer: onOff(current.contextStats.showOutput) },
            { title: text.menu.showCache, value: "showCache", footer: onOff(current.contextStats.showCache) },
            { title: text.menu.showHitRate, value: "showHitRate", footer: onOff(current.contextStats.showHitRate) },
          ],
        })
        if (choice === undefined) return
        await update({
          ...current,
          contextStats: { ...current.contextStats, [choice]: !current.contextStats[choice] },
        })
      }
    }

    /** 通知子菜单。 */
    const chooseNotifications = async (): Promise<void> => {
      for (;;) {
        const current = settings()
        const text = copy()
        const choice = await context.ui.dialog.select<NotificationChoice>({
          title: text.menu.notifications,
          options: [
            { title: text.menu.notificationEnabled, value: "enabled", footer: onOff(current.notification.enabled) },
            { title: text.menu.onComplete, value: "onComplete", footer: onOff(current.notification.onComplete) },
            { title: text.menu.onQuestion, value: "onQuestion", footer: onOff(current.notification.onQuestion) },
            { title: text.menu.onPermission, value: "onPermission", footer: onOff(current.notification.onPermission) },
            {
              title: text.menu.onlyMainSession,
              value: "onlyMainSession",
              footer: onOff(current.notification.onlyMainSession),
            },
          ],
        })
        if (choice === undefined) return
        await update({
          ...current,
          notification: { ...current.notification, [choice]: !current.notification[choice] },
        })
      }
    }

    /** 主菜单：进入分类子菜单。 */
    const openMenu = async (): Promise<void> => {
      for (;;) {
        const current = settings()
        const text = copy()
        const choice = await context.ui.dialog.select<MenuChoice>({
          title: text.menu.title,
          options: [
            { title: text.menu.language, value: "language", footer: current.lang },
            { title: text.menu.goal, value: "goal", footer: onOff(current.goal.enabled) },
            { title: text.menu.scheduling, value: "scheduling", footer: onOff(current.scheduling.enabled) },
            { title: text.menu.sidebar, value: "sidebar" },
            { title: text.menu.contextStats, value: "contextStats", footer: onOff(current.contextStats.enabled) },
            { title: text.menu.notifications, value: "notifications", footer: onOff(current.notification.enabled) },
          ],
        })
        if (choice === undefined) return
        if (choice === "language") {
          await chooseLanguage()
          continue
        }
        if (choice === "goal") await chooseGoal()
        else if (choice === "scheduling") await chooseScheduling()
        else if (choice === "sidebar") await chooseSidebar()
        else if (choice === "contextStats") await chooseContextStats()
        else await chooseNotifications()
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

    const sections: readonly SidebarSection[] = ["goal", "scheduling", "tools", "subagents"]
    const disposeSections = sections.map((section) =>
      context.ui.slot({
        append: "sidebar.content",
        render: (input) => (
          <Sidebar
            context={context}
            sessionID={input.sessionID}
            settings={settings}
            copy={copy}
            section={section}
          />
        ),
      }),
    )

    const disposeStats = context.ui.slot({
      append: "prompt.footer",
      render: (input) =>
        input.sessionID === undefined ? null : (
          <ContextStats context={context} sessionID={input.sessionID} settings={settings} copy={copy} />
        ),
    })

    return () => {
      offToast()
      for (const dispose of disposeSections) dispose()
      disposeStats()
    }
  },
})
