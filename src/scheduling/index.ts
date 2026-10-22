import type { Plugin } from "@opencode/plugin"

import type { SessionRoles } from "../goal/session-role.ts"
import { loadSettings } from "../shared/settings-store.ts"
import type { ScannableStore } from "../shared/json.ts"
import { registerSchedulingCommands } from "./command.ts"
import { createSchedulingContinuation } from "./continuation.ts"
import { createLoopScheduler } from "./loops.ts"
import { createSchedulingStore } from "./store.ts"
import { registerSchedulingTools } from "./tools.ts"

/** 注销句柄。 */
export type Disposable = {
  dispose(): Promise<void>
}

/**
 * 输入：插件上下文、存储、会话角色、让路回调。
 * 输出：定时任务功能的注销句柄。
 * 预期：恢复 durable 任务、注册工具与命令、武装 timer、订阅事件；
 *       子代理与 goal active 时不注入。
 */
export async function registerScheduling(
  ctx: Plugin.Context,
  store: ScannableStore,
  roles: SessionRoles,
  shouldDefer: (sessionID: string) => Promise<boolean>,
): Promise<Disposable> {
  const jobs = createSchedulingStore(store)
  await jobs.load()

  const scheduler = createLoopScheduler({ ctx, roles, shouldDefer })
  const tools = await registerSchedulingTools(ctx, jobs, scheduler, roles)
  const commands = await registerSchedulingCommands(ctx, jobs, scheduler, roles)

  const continuation = createSchedulingContinuation({
    ctx,
    store: jobs,
    roles,
    shouldDefer,
    enabled: async () => {
      const settings = await loadSettings(store)
      return settings.enabled && settings.scheduling.enabled
    },
  })
  continuation.armTimers()

  const events = new AbortController()
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: events.signal })) {
        const payload = { type: event.type, data: event.data }
        await continuation.handle(payload)
        await scheduler.handleEvent(payload)
      }
    } catch {
      // aborted 或连接断开：卸载时正常路径
    }
  })()

  return {
    async dispose() {
      events.abort()
      continuation.dispose()
      scheduler.dispose()
      await tools.dispose()
      await commands.dispose()
    },
  }
}
