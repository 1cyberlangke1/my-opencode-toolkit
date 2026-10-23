import type { Plugin } from "@opencode/plugin"

import type { PluginEvent } from "../shared/events.ts"
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
}

/**
 * 输入：服务端插件上下文 + 存储 + 会话角色 + 控制器。
 * 输出：Goal 功能句柄。
 * 预期：注册三个工具与 `/goal` 命令；事件由调用方的统一循环分发。
 */
export async function registerGoal(
  ctx: Plugin.Context,
  roles: SessionRoles,
  controller: GoalController,
  notify: (sessionID: string) => void,
): Promise<GoalHandle> {
  const continuation = createGoalContinuation({ ctx, controller, roles })

  const tools = await registerGoalTools(ctx, controller, roles, (sessionID) => {
    continuation.resetRunState(sessionID)
  })
  const command = await registerGoalCommand(ctx, controller, continuation, notify)

  return {
    handle(event) {
      return continuation.handle(event)
    },
    async dispose() {
      await tools.dispose()
      await command.dispose()
    },
  }
}
