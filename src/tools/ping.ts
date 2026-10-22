import type { Plugin } from "@opencode/plugin"
import { Schema } from "effect"

import { resolveMessages } from "../i18n/index.ts"
import { PLUGIN_ID } from "../shared/identity.ts"
import { loadSettings } from "../shared/settings-store.ts"

const DESCRIPTION =
  `Returns the ${PLUGIN_ID} status: whether the plugin is enabled and which language it uses. ` +
  "Use it to verify the plugin is loaded."

const PingInput = Schema.Struct({})
const PingOutput = Schema.Struct({
  enabled: Schema.Boolean,
  lang: Schema.String,
})

/**
 * 输入：服务端插件上下文。
 * 输出：注册 `toolkit_ping` 工具，返回注销句柄。
 * 预期：只读——读取设置并按当前语言返回一行状态，不修改任何状态。
 */
export async function registerPingTool(ctx: Plugin.Context): Promise<{ dispose(): Promise<void> }> {
  return ctx.tool.transform((tools) => {
    tools.add({
      name: "toolkit_ping",
      options: { codemode: false },
      description: DESCRIPTION,
      input: PingInput,
      output: PingOutput,
      execute: async () => {
        const settings = await loadSettings(ctx.storage)
        const messages = resolveMessages(settings.lang === "auto" ? undefined : settings.lang)
        return {
          output: { enabled: settings.enabled, lang: settings.lang },
          content: messages.tool.pingResult(settings.enabled, settings.lang),
        }
      },
    })
  })
}
