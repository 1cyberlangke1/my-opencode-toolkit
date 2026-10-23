import { Rpc } from "@opencode/plugin/rpc"

import { RPC_ID } from "./identity.ts"
import type { Settings } from "./settings.ts"

/** 设置读取的输入：当前不需要参数，保留空对象以便后续扩展。 */
const EmptyInputJson = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const

/** 面板查询输入。 */
const PanelInputJson = {
  type: "object",
  properties: { sessionID: { type: "string" } },
  required: ["sessionID"],
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
      properties: { enabled: { type: "boolean" }, showInSidebar: { type: "boolean" } },
      required: ["enabled", "showInSidebar"],
      additionalProperties: false,
    },
    scheduling: {
      type: "object",
      properties: { enabled: { type: "boolean" }, showInSidebar: { type: "boolean" } },
      required: ["enabled", "showInSidebar"],
      additionalProperties: false,
    },
    sidebar: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        showTools: { type: "boolean" },
        showSubagents: { type: "boolean" },
      },
      required: ["enabled", "showTools", "showSubagents"],
      additionalProperties: false,
    },
    contextStats: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        showInput: { type: "boolean" },
        showOutput: { type: "boolean" },
        showCache: { type: "boolean" },
        showHitRate: { type: "boolean" },
      },
      required: ["enabled", "showInput", "showOutput", "showCache", "showHitRate"],
      additionalProperties: false,
    },
  },
  required: ["lang", "enabled", "notification", "goal", "scheduling", "sidebar", "contextStats"],
  additionalProperties: false,
} as const

/** 面板里的目标摘要。 */
const PanelGoalJson = {
  type: "object",
  properties: {
    objective: { type: "string" },
    status: { type: "string", enum: ["active", "paused", "blocked", "budget_limited", "complete"] },
    tokensUsed: { type: "number" },
    tokenBudget: { type: "number" },
    timeUsedSeconds: { type: "number" },
  },
  required: ["objective", "status", "tokensUsed", "timeUsedSeconds"],
  additionalProperties: false,
} as const

/** 面板里的循环摘要。 */
const PanelLoopJson = {
  type: "object",
  properties: {
    id: { type: "string" },
    mode: { type: "string", enum: ["fixed", "dynamic"] },
    prompt: { type: "string" },
    nextFireAt: { type: "number" },
  },
  required: ["id", "mode", "prompt"],
  additionalProperties: false,
} as const

/** 面板里的定时任务摘要。 */
const PanelJobJson = {
  type: "object",
  properties: {
    id: { type: "string" },
    cron: { type: "string" },
    prompt: { type: "string" },
    nextRunAt: { type: "number" },
  },
  required: ["id", "cron", "prompt"],
  additionalProperties: false,
} as const

/** 面板里的统计。 */
const PanelStatsJson = {
  type: "object",
  properties: {
    steps: { type: "number" },
    input: { type: "number" },
    output: { type: "number" },
    cached: { type: "number" },
    hitRate: { type: "number" },
    subagents: { type: "number" },
    tools: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, count: { type: "number" } },
        required: ["name", "count"],
        additionalProperties: false,
      },
    },
  },
  required: ["steps", "input", "output", "cached", "hitRate", "subagents", "tools"],
  additionalProperties: false,
} as const

/** 面板里的子代理摘要。 */
const PanelSubagentJson = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    agent: { type: "string" },
    outcome: { type: "string", enum: ["succeeded", "failed", "interrupted"] },
    updatedAt: { type: "number" },
    input: { type: "number" },
    output: { type: "number" },
    cached: { type: "number" },
  },
  required: ["id", "title", "updatedAt", "input", "output", "cached"],
  additionalProperties: false,
} as const

/** 子代理展开后的详细统计。 */
const PanelSubagentDetailJson = {
  type: "object",
  properties: {
    steps: { type: "number" },
    input: { type: "number" },
    output: { type: "number" },
    cached: { type: "number" },
    hitRate: { type: "number" },
    tools: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, count: { type: "number" } },
        required: ["name", "count"],
        additionalProperties: false,
      },
    },
  },
  required: ["steps", "input", "output", "cached", "hitRate", "tools"],
  additionalProperties: false,
} as const

const PanelOutputJson = {
  type: "object",
  properties: {
    goal: { anyOf: [PanelGoalJson, { type: "null" }] },
    loops: { type: "array", items: PanelLoopJson },
    jobs: { type: "array", items: PanelJobJson },
    stats: PanelStatsJson,
    subagents: { type: "array", items: PanelSubagentJson },
  },
  required: ["goal", "loops", "jobs", "stats", "subagents"],
  additionalProperties: false,
} as const

/** Plan 模式跳过 cron/loop 时发给 TUI 的 toast 事件。 */
const ToastEventJson = {
  type: "object",
  properties: {
    reason: { type: "string", enum: ["planSkipped"] },
    kind: { type: "string", enum: ["cron", "loop"] },
  },
  required: ["reason", "kind"],
  additionalProperties: false,
} as const

/** 服务端与 TUI 共用的 RPC 定义。 */
export const ToolkitRpc: Rpc.PortableDefinition = Rpc.define({
  id: RPC_ID,
  methods: {
    settingsGet: { input: EmptyInputJson, output: SettingsJson },
    settingsSet: { input: SettingsJson, output: SettingsJson },
    panelGet: { input: PanelInputJson, output: PanelOutputJson },
    subagentGet: { input: PanelInputJson, output: PanelSubagentDetailJson },
  },
  events: {
    toast: { schema: ToastEventJson },
  },
})

/** 面板目标摘要。 */
export type PanelGoal = {
  readonly objective: string
  readonly status: string
  readonly tokensUsed: number
  readonly tokenBudget?: number
  readonly timeUsedSeconds: number
}

/** 面板循环摘要。 */
export type PanelLoop = {
  readonly id: string
  readonly mode: "fixed" | "dynamic"
  readonly prompt: string
  readonly nextFireAt?: number
}

/** 面板任务摘要。 */
export type PanelJob = {
  readonly id: string
  readonly cron: string
  readonly prompt: string
  readonly nextRunAt?: number
}

/** 面板统计。 */
export type PanelStats = {
  readonly steps: number
  readonly input: number
  readonly output: number
  readonly cached: number
  readonly hitRate: number
  readonly subagents: number
  readonly tools: readonly { readonly name: string; readonly count: number }[]
}

/** 面板子代理摘要。 */
export type PanelSubagent = {
  readonly id: string
  readonly title: string
  readonly agent?: string
  readonly outcome?: "succeeded" | "failed" | "interrupted"
  readonly updatedAt: number
  readonly input: number
  readonly output: number
  readonly cached: number
}

/** 子代理展开详情。 */
export type PanelSubagentDetail = {
  readonly steps: number
  readonly input: number
  readonly output: number
  readonly cached: number
  readonly hitRate: number
  readonly tools: readonly { readonly name: string; readonly count: number }[]
}

/** 面板数据。 */
export type PanelData = {
  readonly goal: PanelGoal | null
  readonly loops: readonly PanelLoop[]
  readonly jobs: readonly PanelJob[]
  readonly stats: PanelStats
  readonly subagents: readonly PanelSubagent[]
}

/** toast 事件的载荷。 */
export type ToolkitToastEvent = {
  readonly reason: "planSkipped"
  readonly kind: "cron" | "loop"
}

/** TUI 侧对 ToolkitRpc 的类型化视图。 */
export type ToolkitRpcClient = {
  settingsGet(input: Record<string, never>): Promise<Settings>
  settingsSet(input: Settings): Promise<Settings>
  panelGet(input: { readonly sessionID: string }): Promise<PanelData>
  subagentGet(input: { readonly sessionID: string }): Promise<PanelSubagentDetail>
  events: {
    on(
      name: "toast",
      handler: (event: { readonly data: ToolkitToastEvent }) => void,
    ): () => void
  }
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
