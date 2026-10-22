import type { Plugin } from "@opencode/plugin"

import type { SessionRoles } from "../goal/session-role.ts"
import type { PluginEvent } from "../shared/events.ts"
import type { ScannableStore } from "../shared/json.ts"
import { loadSettings } from "../shared/settings-store.ts"
import type { Disposable } from "../shared/types.ts"
import { registerSchedulingCommands } from "./command.ts"
import { createSchedulingContinuation } from "./continuation.ts"
import type { LoopScheduler } from "./loops.ts"
import { createLoopScheduler } from "./loops.ts"
import type { SchedulingStore } from "./store.ts"
import { createSchedulingStore } from "./store.ts"
import { registerSchedulingTools } from "./tools.ts"

/** 定时任务功能句柄 + 面板数据源。 */
export type SchedulingHandle = Disposable & {
  readonly jobs: SchedulingStore
  readonly scheduler: LoopScheduler
  /** 输入：插件事件；输出：无。预期：cron 触发与 loop 状态维护；由外层统一分发。 */
  handle(event: PluginEvent): Promise<void>
}

/**
 * 输入：插件上下文、存储、会话角色、让路回调。
 * 输出：定时任务功能句柄。
 * 预期：恢复 durable 任务、注册工具与命令、武装 timer；事件由调用方统一分发。
 */
export async function registerScheduling(
  ctx: Plugin.Context,
  store: ScannableStore,
  roles: SessionRoles,
  shouldDefer: (sessionID: string) => Promise<boolean>,
): Promise<SchedulingHandle> {
  const jobs = createSchedulingStore(store)
  await jobs.load()

  /** 输入：无；输出：总开关与 scheduling 开关是否都打开。 */
  const isEnabled = async (): Promise<boolean> => {
    const settings = await loadSettings(store)
    return settings.enabled && settings.scheduling.enabled
  }

  const scheduler = createLoopScheduler({ ctx, roles, shouldDefer, enabled: isEnabled })
  const tools = await registerSchedulingTools(ctx, jobs, scheduler, roles)
  const commands = await registerSchedulingCommands(ctx, jobs, scheduler, roles)

  const continuation = createSchedulingContinuation({
    ctx,
    store: jobs,
    roles,
    shouldDefer,
    enabled: isEnabled,
  })
  continuation.armTimers()

  return {
    jobs,
    scheduler,
    async handle(event) {
      await continuation.handle(event)
      await scheduler.handleEvent(event)
    },
    async dispose() {
      continuation.dispose()
      scheduler.dispose()
      await tools.dispose()
      await commands.dispose()
    },
  }
}
