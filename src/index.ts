import { Plugin } from "@opencode/plugin"

import { registerGoal } from "./goal/index.ts"
import { loadSettings, saveSettings } from "./shared/settings-store.ts"
import { normalizeSettings } from "./shared/settings.ts"
import { ToolkitRpc } from "./shared/rpc.ts"
import { registerPingTool } from "./tools/ping.ts"

export default Plugin.define({
  id: "my-opencode-toolkit",

  /**
   * 输入：OpenCode 注入的插件上下文。
   * 输出：设置 RPC、`toolkit_ping` 工具，以及卸载回调。
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

    const tool = await registerPingTool(ctx)
    const goal = await registerGoal(ctx, ctx.storage)
    // 工具注册后刷新一次工具表，让当前会话的下一次请求就能看到新工具。
    await ctx.tool.reload()

    return async () => {
      await goal.dispose()
      await tool.dispose()
      await rpc.dispose()
    }
  },
})
