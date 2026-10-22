import { Plugin } from "@opencode/plugin"

import { hideGoalTools } from "./goal/filter.ts"
import { registerGoal } from "./goal/index.ts"
import { createGoalController } from "./goal/controller.ts"
import { createSessionRoles } from "./goal/session-role.ts"
import { hideSchedulingTools } from "./scheduling/filter.ts"
import { registerScheduling } from "./scheduling/index.ts"
import { loadSettings, saveSettings } from "./shared/settings-store.ts"
import { normalizeSettings } from "./shared/settings.ts"
import { ToolkitRpc } from "./shared/rpc.ts"
import { registerPingTool } from "./tools/ping.ts"

export default Plugin.define({
  id: "my-opencode-toolkit",

  /**
   * 输入：OpenCode 注入的插件上下文。
   * 输出：设置 RPC、`toolkit_ping`、Goal 与定时任务功能，以及卸载回调。
   * 预期：首次启动把 options 归一化后写入存储；之后以存储里的设置为准。
   */
  async setup(ctx) {
    await loadSettings(ctx.storage, ctx.options)

    const rpc = await ctx.rpc.register(ToolkitRpc, {
      settingsGet: async () => loadSettings(ctx.storage, ctx.options),
      settingsSet: async (input) => {
        // RPC 定义是 PortableDefinition，运行时才知道 input 形状；这里再归一化一次兜底。
        await saveSettings(ctx.storage, normalizeSettings(input))
        return loadSettings(ctx.storage, ctx.options)
      },
    })

    const roles = createSessionRoles(ctx)
    const goalController = createGoalController(ctx.storage)

    const tool = await registerPingTool(ctx)
    const goal = await registerGoal(ctx, ctx.storage, roles, goalController)
    const scheduling = await registerScheduling(ctx, ctx.storage, roles, async (sessionID) => {
      const goal = await goalController.getGoal(sessionID)
      return goal?.status === "active"
    })

    // 功能关闭或子代理会话时，请求发给模型前就把对应工具从工具表移除。
    const hook = await ctx.session.hook("context", async (event) => {
      const settings = await loadSettings(ctx.storage)
      if (!settings.enabled) {
        hideGoalTools(event.tools)
        hideSchedulingTools(event.tools)
        return
      }
      const subagent = await roles.isSubagent(event.sessionID)
      if (subagent || !settings.goal.enabled) hideGoalTools(event.tools)
      if (subagent || !settings.scheduling.enabled) hideSchedulingTools(event.tools)
    })

    // 工具注册后刷新一次工具表，让当前会话的下一次请求就能看到新工具。
    await ctx.tool.reload()

    return async () => {
      await hook.dispose()
      await scheduling.dispose()
      await goal.dispose()
      await tool.dispose()
      await rpc.dispose()
    }
  },
})
