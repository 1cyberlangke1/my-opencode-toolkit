import type { Plugin } from "@opencode/plugin"

import type { JsonStore } from "../shared/json.ts"
import { loadSettings } from "../shared/settings-store.ts"
import { registerGoalCommand } from "./command.ts"
import { createGoalContinuation } from "./continuation.ts"
import { createGoalController } from "./controller.ts"
import { hideGoalTools } from "./filter.ts"
import { createSessionRoles } from "./session-role.ts"
import { registerGoalTools } from "./tools.ts"

/** 注销句柄。 */
export type Disposable = {
  dispose(): Promise<void>
}

/**
 * 输入：服务端插件上下文 + 存储。
 * 输出：Goal 功能的注销句柄。
 * 预期：注册三个工具、`/goal` 命令、事件订阅与 context 钩子；
 *       子代理会话或功能关闭时，在请求发给模型前把 goal 工具从工具表里移除。
 */
export async function registerGoal(ctx: Plugin.Context, store: JsonStore): Promise<Disposable> {
  const controller = createGoalController(store)
  const roles = createSessionRoles(ctx)
  const continuation = createGoalContinuation({ ctx, store, controller, roles })

  const tools = await registerGoalTools(ctx, controller, roles)
  const command = await registerGoalCommand(ctx, controller, continuation)

  const hook = await ctx.session.hook("context", async (event) => {
    const settings = await loadSettings(store)
    if (settings.enabled && settings.goal.enabled && !(await roles.isSubagent(event.sessionID))) return
    hideGoalTools(event.tools)
  })

  const events = new AbortController()
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: events.signal })) {
        await continuation.handle({ type: event.type, data: event.data })
      }
    } catch {
      // aborted 或连接断开：卸载时正常路径
    }
  })()

  return {
    async dispose() {
      events.abort()
      await hook.dispose()
      await tools.dispose()
      await command.dispose()
    },
  }
}
