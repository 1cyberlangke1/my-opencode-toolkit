import { Rpc } from "@opencode/plugin/rpc"

import type { Settings } from "./settings.ts"

/** 设置读取的输入：当前不需要参数，保留空对象以便后续扩展。 */
const EmptyInputJson = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const

/** 设置对象的 JSON Schema，服务端与 TUI 共用。 */
const SettingsJson = {
  type: "object",
  properties: {
    lang: { type: "string", enum: ["auto", "zh", "en"] },
    enabled: { type: "boolean" },
    notification: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        onComplete: { type: "boolean" },
        onQuestion: { type: "boolean" },
        onPermission: { type: "boolean" },
        onlyMainSession: { type: "boolean" },
      },
      required: ["enabled", "onComplete", "onQuestion", "onPermission", "onlyMainSession"],
      additionalProperties: false,
    },
    goal: {
      type: "object",
      properties: { enabled: { type: "boolean" } },
      required: ["enabled"],
      additionalProperties: false,
    },
    scheduling: {
      type: "object",
      properties: { enabled: { type: "boolean" } },
      required: ["enabled"],
      additionalProperties: false,
    },
    sidebar: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        showCache: { type: "boolean" },
        showTools: { type: "boolean" },
        showSubagents: { type: "boolean" },
        collapsed: { type: "boolean" },
      },
      required: ["enabled", "showCache", "showTools", "showSubagents", "collapsed"],
      additionalProperties: false,
    },
  },
  required: ["lang", "enabled", "notification", "goal", "scheduling", "sidebar"],
  additionalProperties: false,
} as const

/** 服务端与 TUI 共用的 RPC 定义。 */
export const ToolkitRpc: Rpc.PortableDefinition = Rpc.define({
  id: "my-opencode-toolkit",
  methods: {
    settingsGet: { input: EmptyInputJson, output: SettingsJson },
    settingsSet: { input: SettingsJson, output: SettingsJson },
  },
  events: {},
})

/** TUI 侧对 ToolkitRpc 的类型化视图。 */
export type ToolkitRpcClient = {
  settingsGet(input: Record<string, never>): Promise<Settings>
  settingsSet(input: Settings): Promise<Settings>
}

/**
 * 输入：带 `rpc` 方法的 TUI client。
 * 输出：类型化 RPC 客户端。
 * 预期：只做类型断言，不改变运行时行为。
 */
export function toolkitRpc(client: {
  rpc(definition: Rpc.PortableDefinition): unknown
}): ToolkitRpcClient {
  return client.rpc(ToolkitRpc) as ToolkitRpcClient
}
