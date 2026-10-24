import type { Context } from "@opencode/plugin/tui/context"
import { createSignal, onCleanup, onMount, type Accessor } from "solid-js"

import { readEventSessionID } from "../shared/events.ts"
import { toolkitRpc, type PanelData, type ToolkitRpcClient } from "../shared/rpc.ts"

/** 面板请求合并窗口：同一会话的重复刷新只发一次 RPC。 */
const PANEL_CACHE_MS = 150

/** 事件到刷新之间的合并窗口；连续 step 事件只刷新一次。 */
const REFRESH_DEBOUNCE_MS = 50

/** 输入：TUI 上下文；输出：RPC 路由选项。 */
export function panelRpcOptions(context: Context): { readonly location?: { readonly directory: string } } {
  return context.location?.directory === undefined
    ? {}
    : { location: { directory: context.location.directory } }
}

/** 输入：类型化 RPC 客户端；输出：带短缓存的面板读取函数。 */
export function createPanelReader(
  rpc: ToolkitRpcClient,
): (context: Context, sessionID: string) => Promise<PanelData> {
  const cache = new Map<string, { readonly at: number; readonly value: Promise<PanelData> }>()

  return (context, sessionID) => {
    // 四个分区加底栏都会刷新；同一个 tick 内的请求必须合并，否则一次事件打五份 panelGet。
    const key = `${context.location?.directory ?? ""}\n${sessionID}`
    const hit = cache.get(key)
    if (hit !== undefined && Date.now() - hit.at < PANEL_CACHE_MS) return hit.value

    const value = rpc.panelGet({ sessionID }, panelRpcOptions(context))
    cache.set(key, { at: Date.now(), value })
    // 失败不能缓存，否则一次网络抖动会让面板永远停在旧数据上。
    void value.catch(() => {
      if (cache.get(key)?.value === value) cache.delete(key)
    })
    return value
  }
}

/** 输入：事件 + 当前会话；输出：是否该刷新当前会话的面板。预期：别的会话/子代理的事件一律忽略。 */
export function isOwnSessionEvent(
  event: { readonly type: string; readonly data: unknown },
  sessionID: string,
): boolean {
  if (
    event.type !== "session.idle" &&
    event.type !== "session.step.ended" &&
    event.type !== "session.step.failed" &&
    event.type !== "session.usage.updated"
  ) {
    return false
  }
  return readEventSessionID(event) === sessionID
}

/**
 * 输入：TUI 上下文 + 会话 + 可选共享读取器 + 可选刷新回调。
 * 输出：panel 信号。
 * 预期：挂载时拉一次；`data.listen` 与 `panelUpdated` 都按 50ms 合并刷新；
 *       卸载时统一清定时器与订阅。必须在组件 setup 内调用（依赖 Solid owner）。
 *       刷新只由事件驱动，不对外暴露手动入口——外部拿到的旧值无法与定时器对齐。
 */
export function createPanelFeed(input: {
  readonly context: Context
  readonly sessionID: string
  readonly readPanel?: (context: Context, sessionID: string) => Promise<PanelData>
  readonly onRefresh?: () => void
}): { readonly panel: Accessor<PanelData | null> } {
  const rpc = toolkitRpc(input.context.client)
  const readPanel =
    input.readPanel ??
    ((context: Context, sessionID: string) => rpc.panelGet({ sessionID }, panelRpcOptions(context)))
  const [panel, setPanel] = createSignal<PanelData | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined

  const refresh = (): void => {
    void readPanel(input.context, input.sessionID)
      .then((data) => {
        setPanel(data)
        input.onRefresh?.()
      })
      .catch(() => undefined)
  }

  const schedule = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(refresh, REFRESH_DEBOUNCE_MS)
  }

  onMount(() => {
    refresh()
    const off = input.context.data.listen(({ details }) => {
      if (!isOwnSessionEvent(details, input.sessionID)) return
      schedule()
    })
    const offPanel = rpc.events.on("panelUpdated", (event) => {
      if (event.data.sessionID !== input.sessionID) return
      schedule()
    })
    onCleanup(() => {
      off()
      offPanel()
      if (timer !== undefined) clearTimeout(timer)
    })
  })

  return { panel }
}
