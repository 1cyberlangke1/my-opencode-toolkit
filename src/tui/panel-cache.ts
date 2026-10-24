import type { Context } from "@opencode/plugin/tui/context"

import type { PanelData, ToolkitRpcClient } from "../shared/rpc.ts"

/** 面板请求合并窗口：同一会话的重复刷新只发一次 RPC。 */
const PANEL_CACHE_MS = 150

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
