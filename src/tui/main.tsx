import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js"

import { localeOf, resolveMessages, type Messages } from "../i18n/index.ts"
import { formatTokens } from "./format.ts"
import { SETTINGS_COMMAND_ID, SETTINGS_SLASH_NAME, TUI_PLUGIN_ID } from "../shared/identity.ts"
import { DEFAULT_SETTINGS, type Lang, type Settings } from "../shared/settings.ts"
import { toolkitRpc, type PanelData, type PanelSubagent, type PanelSubagentDetail } from "../shared/rpc.ts"
import { countdownColor, dim, hitRateColor } from "./color.ts"
import { configFileLayers } from "./config-layers.ts"
import { formatAgo, formatCountdown, padRight, truncate } from "./format.ts"
import { createPanelFeed, createPanelReader, panelRpcOptions as rpcOptions } from "./panel-cache.ts"

/** 主菜单条目。 */
type MenuChoice = "language" | "goal" | "scheduling" | "sidebar" | "contextStats" | "notifications"

/** 侧栏子菜单条目：目标/定时任务的侧栏开关也归到这里。 */
type SidebarChoice = "goal" | "scheduling" | "showTools" | "showSubagents"

/** 上下文统计子菜单条目。 */
type ContextStatsChoice = "enabled" | "showInput" | "showOutput" | "showCache" | "showHitRate"

/** 通知子菜单条目。 */
type NotificationChoice = "enabled" | "onComplete" | "onQuestion" | "onPermission" | "onlyMainSession"

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
  /** 可选的共享面板读取器；不传时自己发 RPC（测试与单独渲染用）。 */
  readonly readPanel?: (context: Context, sessionID: string) => Promise<PanelData>
}) {
  const rpc = toolkitRpc(props.context.client)
  const [now, setNow] = createSignal(Date.now())
  /** 呼吸灯相位：0..PULSE_PERIOD_MS，只在有运行中项时才走。 */
  const [pulse, setPulse] = createSignal(0)
  const feed = createPanelFeed({
    context: props.context,
    sessionID: props.sessionID,
    ...(props.readPanel === undefined ? {} : { readPanel: props.readPanel }),
    onRefresh: () => setNow(Date.now()),
  })
  const panel = feed.panel
  const [goalOpen, setGoalOpen] = createSignal(true)
  const [schedulingOpen, setSchedulingOpen] = createSignal(true)
  const [toolsOpen, setToolsOpen] = createSignal(true)
  const [subagentsOpen, setSubagentsOpen] = createSignal(true)
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())
  const [details, setDetails] = createSignal<
    Readonly<Record<string, PanelSubagentDetail | "loading" | "error">>
  >({})

  // 目标用时每秒递增；面板刷新时也会重置基准，这里只负责走秒。
  onMount(() => {
    const clock = setInterval(() => setNow(Date.now()), 1_000)
    onCleanup(() => {
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

  /** 呼吸灯节奏：80ms 一帧，1.6s 一个来回。 */
  const PULSE_MS = 80
  const PULSE_PERIOD_MS = 1_600

  /**
   * 输入：主题色 + 是否呼吸。
   * 输出：当前帧的灯色。
   * 预期：呼吸时只压亮度（0.45→1.0 正弦来回），不换色相、不改字符宽度。
   */
  const lampColor = (color: ReturnType<typeof success>, breathing: boolean) => {
    if (!breathing) return color
    const phase = (pulse() / PULSE_PERIOD_MS) * Math.PI * 2
    return dim(color, 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(phase)))
  }

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

  /** 输入：子代理 outcome；输出：状态颜色。预期：跑=绿呼吸，成功=青，失败=红，中断=黄。 */
  const subagentStatusColor = (outcome: PanelSubagent["outcome"]) => {
    if (outcome === "succeeded") return info()
    if (outcome === "failed") return error()
    if (outcome === "interrupted") return warning()
    return success()
  }

  /** 输入：标签 + 值 + 颜色；输出：对齐后的单行。预期：冒号后至少留一个空格。 */
  const labelRow = (
    label: string,
    value: string,
    color: string | ReturnType<typeof base> = base(),
  ) => {
    const text = `${label}:`
    const padded = padRight(text, 6)
    // 英文标签本身就够长时不补空格，这里保证冒号后至少一个空格。
    const column = padded.length > text.length ? padded : `${padded} `
    return (
      <text>
        <span style={{ fg: muted() }}>{column}</span>
        <span style={{ fg: color }}>{value}</span>
      </text>
    )
  }

  /** 输入：标题 + 展开状态 + 切换函数 + 尾部元素；输出：可点击的分区标题。 */
  const sectionHeader = (label: string, open: boolean, toggle: () => void, trailing?: JSX.Element) => (
    <box flexDirection="row" height={1} onMouseDown={toggle}>
      <box flexDirection="row" gap={1}>
        <text fg={base()}>{open ? "▼" : "▶"}</text>
        <text fg={base()}>
          <b>{label}</b>
        </text>
        {trailing}
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
  const lastTool = (): string | null => panel()?.stats.lastTool ?? null

  /** 运行中的子代理数：outcome 缺失表示还没结束。 */
  const runningSubagents = (): number => subagents().filter((item) => item.outcome === undefined).length
  /** 完成的子代理数。 */
  const succeededSubagents = (): number => subagents().filter((item) => item.outcome === "succeeded").length
  /** 失败的子代理数。 */
  const failedSubagents = (): number => subagents().filter((item) => item.outcome === "failed").length
  /** 被中断的子代理数。 */
  const interruptedSubagents = (): number =>
    subagents().filter((item) => item.outcome === "interrupted").length

  /**
   * 输入：当前子代理列表。
   * 输出：标题里要画的灯组（颜色 + 是否呼吸 + 数量）。
   * 预期：运行中/完成/失败/中断各一盏，数量为 0 的不出现；
   *       分区只在有子代理时渲染，所以括号里至少有一盏灯。
   */
  const subagentLamps = () => {
    const lamps: { readonly color: ReturnType<typeof success>; readonly breathing: boolean; readonly count: number }[] = []
    if (runningSubagents() > 0) lamps.push({ color: success(), breathing: true, count: runningSubagents() })
    if (succeededSubagents() > 0) lamps.push({ color: info(), breathing: false, count: succeededSubagents() })
    if (failedSubagents() > 0) lamps.push({ color: error(), breathing: false, count: failedSubagents() })
    if (interruptedSubagents() > 0)
      lamps.push({ color: warning(), breathing: false, count: interruptedSubagents() })
    return lamps
  }

  let pulseTimer: ReturnType<typeof setInterval> | undefined

  // 只有存在「运行中」的灯才走帧；全部停下就关掉定时器，不空转。
  createEffect(() => {
    const active = runningSubagents() + (goal()?.status === "active" ? 1 : 0)
    if (active > 0) {
      pulseTimer ??= setInterval(() => setPulse(Date.now() % PULSE_PERIOD_MS), PULSE_MS)
      return
    }
    if (pulseTimer !== undefined) {
      clearInterval(pulseTimer)
      pulseTimer = undefined
      setPulse(0)
    }
  })
  onCleanup(() => {
    if (pulseTimer !== undefined) clearInterval(pulseTimer)
  })

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
            }, (
              <text fg={lampColor(goalStatusColor(goal()?.status ?? ""), goal()?.status === "active")}>●</text>
            ))}
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
                      <span style={{ fg: muted() }}> · {truncate(job.prompt, 14)} · </span>
                      <span style={{ fg: muted() }}>{props.copy().panel.next} </span>
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
              <text fg={muted()}>{`(${String(visibleTools().length)})`}</text>,
            )}
            <Show when={toolsOpen()}>
              <box paddingLeft={2} flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={0}>
                <For each={visibleTools()}>
                  {(tool) => (
                    <text flexShrink={0}>
                      <span style={{ fg: base() }}>[{tool.name}]</span>
                      {/* 最近一次被调用的工具，计数用成功绿；其余保持 muted。 */}
                      <span style={{ fg: tool.name === lastTool() ? success() : muted() }}>
                        ({String(tool.count)})
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
            props.section === "subagents" &&
            props.settings().sidebar.showSubagents &&
            subagents().length > 0
          }
        >
          <box flexDirection="column" gap={0}>
            {sectionHeader(
              props.copy().panel.subagents,
              subagentsOpen(),
              () => {
                setSubagentsOpen(!subagentsOpen())
              },
              <box flexDirection="row" gap={0}>
                <text fg={muted()}>(</text>
                <For each={subagentLamps()}>
                  {(lamp, index) => (
                    <box flexDirection="row" gap={0}>
                      <Show when={index() > 0}>
                        <text fg={muted()}> </text>
                      </Show>
                      <text fg={lampColor(lamp.color, lamp.breathing)}>●</text>
                      <text fg={muted()}>{` ${String(lamp.count)}`}</text>
                    </box>
                  )}
                </For>
                <text fg={muted()}>)</text>
              </box>,
            )}
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
                          <span
                      style={{
                        fg: lampColor(
                          subagentStatusColor(subagent.outcome),
                          subagent.outcome === undefined,
                        ),
                      }}
                    >
                      ●{" "}
                    </span>
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
  /** 可选的共享面板读取器；不传时自己发 RPC（测试与单独渲染用）。 */
  readonly readPanel?: (context: Context, sessionID: string) => Promise<PanelData>
}) {
  const feed = createPanelFeed({
    context: props.context,
    sessionID: props.sessionID,
    ...(props.readPanel === undefined ? {} : { readPanel: props.readPanel }),
  })
  const panel = feed.panel

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
    // 每次调用现算路由：setup 时 context.location 可能还没就绪，不能固化成常量。
    const callOptions = (): ReturnType<typeof rpcOptions> => rpcOptions(context)
    const readPanel = createPanelReader(rpc)
    const layers = await configFileLayers(context)
    const initial = await rpc.settingsGet({ layers }, callOptions()).catch((): Settings => DEFAULT_SETTINGS)
    const [settings, setSettings] = createSignal<Settings>(initial)

    /** 输入：新设置；输出：无；预期：先乐观更新，失败回滚。 */
    const update = async (next: Settings): Promise<void> => {
      const previous = settings()
      setSettings(next)
      try {
        setSettings(await rpc.settingsSet({ ...next, layers }, callOptions()))
      } catch {
        setSettings(previous)
      }
    }

    const copy = (): Messages => resolveMessages(localeOf(settings().lang))

    const offToast = rpc.events.on("toast", (event) => {
      // 事件会广播给所有 location 的 TUI；本 TUI 不认识的会话直接忽略，避免跨目录弹提示。
      if (context.data.session.get(event.data.sessionID) === undefined) return
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
    /** 输入：`goal` 或 `scheduling`；输出：无。预期：循环切换功能开关，取消则退出。 */
    const chooseFeature = async (key: "goal" | "scheduling"): Promise<void> => {
      for (;;) {
        const current = settings()
        const text = copy()
        const choice = await context.ui.dialog.select<"enabled">({
          title: key === "goal" ? text.menu.goal : text.menu.scheduling,
          options: [
            { title: text.menu.function, value: "enabled", footer: onOff(current[key].enabled) },
          ],
        })
        if (choice === undefined) return
        await update(
          key === "goal"
            ? { ...current, goal: { ...current.goal, enabled: !current.goal.enabled } }
            : { ...current, scheduling: { ...current.scheduling, enabled: !current.scheduling.enabled } },
        )
      }
    }

    /** 目标子菜单：只有功能开关；侧栏显示在侧栏子菜单。 */
    const chooseGoal = (): Promise<void> => chooseFeature("goal")

    /** 定时任务子菜单：功能与侧栏显示独立。 */
    const chooseScheduling = (): Promise<void> => chooseFeature("scheduling")

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
            readPanel={readPanel}
          />
        ),
      }),
    )

    const disposeStats = context.ui.slot({
      append: "prompt.footer",
      render: (input) =>
        input.sessionID === undefined ? null : (
          <ContextStats
            context={context}
            sessionID={input.sessionID}
            settings={settings}
            copy={copy}
            readPanel={readPanel}
          />
        ),
    })

    return () => {
      offToast()
      for (const dispose of disposeSections) dispose()
      disposeStats()
    }
  },
})
