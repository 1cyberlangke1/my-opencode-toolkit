import type { Plugin } from "@opencode/plugin"

import type { JsonStore } from "../shared/json.ts"
import { registerGoalCommand } from "./command.ts"
import { createGoalContinuation } from "./continuation.ts"
import { createGoalController } from "./controller.ts"
import { registerGoalTools } from "./tools.ts"

/** 注销句柄。 */
export type Disposable = {
  dispose(): Promise<void>
}

/**
 * 输入：服务端插件上下文 + 存储。
 * 输出：Goal 功能的注销句柄。
 * 预期：注册三个工具、`/goal` 命令与事件订阅；卸载时全部释放并停止续作。
 */
export async function registerGoal(ctx: Plugin.Context, store: JsonStore): Promise<Disposable> {
  const controller = createGoalController(store)
  const continuation = createGoalContinuation({ ctx, store, controller })

  const tools = await registerGoalTools(ctx, controller)
  const command = await registerGoalCommand(ctx, controller, continuation)

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
      await tools.dispose()
      await command.dispose()
    },
  }
}
