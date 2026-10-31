import type { Plugin } from "@opencode/plugin"

import type { PluginEvent } from "../shared/events.ts"
import { loadSettings } from "../shared/settings-store.ts"
import type { Lang } from "../shared/settings.ts"
import type { Disposable } from "../shared/types.ts"
import { registerGoalCommand } from "./command.ts"
import { createGoalContinuation } from "./continuation.ts"
import type { GoalController } from "./controller.ts"
import type { SessionRoles } from "./session-role.ts"
import { registerGoalTools } from "./tools.ts"

/** Goal 功能句柄。 */
export type GoalHandle = Disposable & {
  /** 输入：插件事件；输出：无。预期：续作与记账；由外层统一分发。 */
  handle(event: PluginEvent): Promise<void>
  /** 输入：新语言；输出：无。预期：重注册 `/goal` 的本地化描述。 */
  refreshCommands(lang: Lang): Promise<void>
  /**
   * 输入：目标功能是否启用。
   * 输出：无。
   * 预期：关闭时注销 `/goal` 命令与三个工具（命令面板与工具表立刻消失），
   *       事件 handler 变成空转；重新开启时再注册回来。与当前状态相同则不做事。
   */
  setEnabled(enabled: boolean): Promise<void>
}

/**
 * 输入：服务端插件上下文 + 存储 + 会话角色 + 控制器。
 * 输出：Goal 功能句柄。
 * 预期：注册三个工具与 `/goal` 命令；事件由调用方的统一循环分发。
 *       功能关闭时命令/工具整体注销、handler 空转——「关」必须是完整关闭。
 */
export async function registerGoal(
  ctx: Plugin.Context,
  roles: SessionRoles,
  controller: GoalController,
  notify: (sessionID: string) => void,
): Promise<GoalHandle> {
  const continuation = createGoalContinuation({ ctx, controller, roles })

  /**
   * 当前已注册的命令/工具注销器；`undefined` 表示功能关闭中。
   * 命令句柄单独保存，供语言切换时刷新描述。
   */
  let disposeActive: (() => Promise<void>) | undefined
  let commandHandle: { dispose(): Promise<void>; refresh(lang: Lang): Promise<void> } | undefined

  const start = async (): Promise<void> => {
    if (disposeActive !== undefined) return
    const tools = await registerGoalTools(ctx, controller, roles, (sessionID) => {
      continuation.resetRunState(sessionID)
    })
    const command = await registerGoalCommand(ctx, controller, continuation, roles, notify)
    commandHandle = command
    disposeActive = async () => {
      commandHandle = undefined
      await tools.dispose()
      await command.dispose()
    }
  }

  const stop = async (): Promise<void> => {
    const dispose = disposeActive
    disposeActive = undefined
    await dispose?.()
  }

  // 注册时读一次设置：默认关闭时启动就不带命令与工具。
  const initial = await loadSettings(ctx)
  if (initial.goal.enabled) await start()

  return {
    async handle(event) {
      // 功能关闭时不续作、不记账；已存在的目标静默保留在存储里。
      if (disposeActive === undefined) return
      await continuation.handle(event)
    },
    refreshCommands(lang) {
      // 功能关闭时命令已注销，没有描述可刷新；重新开启时会按当前语言注册。
      if (commandHandle === undefined) return Promise.resolve()
      return commandHandle.refresh(lang)
    },
    async setEnabled(enabled) {
      if (enabled) await start()
      else await stop()
    },
    async dispose() {
      await stop()
    },
  }
}
