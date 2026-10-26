import type { Plugin } from "@opencode/plugin"

import type { SessionRoles } from "../goal/session-role.ts"
import type { PluginEvent } from "../shared/events.ts"
import type { ScannableStore } from "../shared/json.ts"
import type { Lang } from "../shared/settings.ts"
import { loadSettings } from "../shared/settings-store.ts"
import { locateSession } from "../shared/session.ts"
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
  /** 输入：新语言；输出：无。预期：重注册 `/cron`、`/loop` 的本地化描述。 */
  refreshCommands(lang: Lang): Promise<void>
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
  notifySkipped?: (kind: "cron" | "loop", sessionID: string) => void,
): Promise<SchedulingHandle> {
  // durable 任务记录创建时的 location；读取时按目录 + workspaceID 过滤，
  // 并在会话 move 后以会话当前位置为准修正旧存档。
  const jobs = createSchedulingStore(store, {
    directory: ctx.location.directory,
    ...(ctx.location.workspaceID === undefined ? {} : { workspaceID: ctx.location.workspaceID }),
    sessionLocation: async (sessionID) => {
      const located = await locateSession(ctx, sessionID)
      if (located.kind === "missing") return null
      if (located.kind === "unknown") return undefined
      return {
        directory: located.directory,
        ...(located.workspaceID === undefined ? {} : { workspaceID: located.workspaceID }),
      }
    },
  })
  await jobs.load()

  /** 输入：无；输出：总开关与 scheduling 开关是否都打开。 */
  const isEnabled = async (): Promise<boolean> => {
    const settings = await loadSettings(ctx)
    return settings.enabled && settings.scheduling.enabled
  }

  const scheduler = createLoopScheduler({
    ctx,
    roles,
    shouldDefer,
    ...(notifySkipped === undefined ? {} : { notifySkipped }),
    enabled: isEnabled,
    locateSession: (sessionID) => locateSession(ctx, sessionID),
  })
  const continuation = createSchedulingContinuation({
    ctx,
    store: jobs,
    roles,
    shouldDefer,
    ...(notifySkipped === undefined ? {} : { notifySkipped }),
    enabled: isEnabled,
    locateSession: (sessionID) => locateSession(ctx, sessionID),
  })
  continuation.armTimers()

  const armTimersCallback = (): void => {
    continuation.armTimers()
  }
  const tools = await registerSchedulingTools(ctx, jobs, scheduler, roles, armTimersCallback)
  const commands = await registerSchedulingCommands(ctx, jobs, scheduler, roles, armTimersCallback)

  return {
    jobs,
    scheduler,
    async handle(event) {
      await continuation.handle(event)
      await scheduler.handleEvent(event)
    },
    refreshCommands(lang) {
      return commands.refresh(lang)
    },
    async dispose() {
      continuation.dispose()
      scheduler.dispose()
      await tools.dispose()
      await commands.dispose()
    },
  }
}
