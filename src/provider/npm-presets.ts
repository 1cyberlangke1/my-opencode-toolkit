/**
 * 常用 SDK 驱动包预设。
 *
 * 包名写入 opencode.jsonc 的 provider.npm；端点路径是该 SDK 在 baseURL 之后
 * 实际请求的路径，用于在选择框右侧对齐展示，帮助区分 /chat/completions 与
 * /responses 这类光看包名分不清的协议。
 */

/** 一个 SDK 预设：包名 + baseURL 之后拼接的端点路径。 */
export type NpmPreset = {
  /** 写入配置的 provider.npm 包名。 */
  readonly id: string
  /** baseURL 之后拼接的端点路径；空串表示由 SDK 自行决定。 */
  readonly endpoint: string
}

/**
 * 预设列表。
 *
 * 输入：无。
 * 输出：四个固定预设。
 * 预期：openai-compatible 覆盖第三方中转与本地推理，其余三个是官方 SDK
 *       各自的协议端点。
 */
export const NPM_PRESETS: readonly NpmPreset[] = [
  { id: "@ai-sdk/openai-compatible", endpoint: "/chat/completions" },
  { id: "@ai-sdk/openai", endpoint: "/responses" },
  { id: "@ai-sdk/anthropic", endpoint: "/messages" },
  { id: "@ai-sdk/google", endpoint: "/models/{model}:generateContent" },
]

/** 选择框里的一行：包名做标题，端点路径做右对齐 footer。 */
export type NpmPresetOption = {
  readonly title: string
  readonly value: string
  readonly footer?: string
}

/**
 * 生成 SDK 选择项列表。
 *
 * 输入：无。
 * 输出：与 NPM_PRESETS 等长、同序的选项数组。
 * 预期：endpoint 非空时放进 footer（宿主右对齐成列）；调用方可自行追加
 *       自定义项。
 */
export function npmPresetOptions(): NpmPresetOption[] {
  return NPM_PRESETS.map((preset) => ({
    title: preset.id,
    value: preset.id,
    ...(preset.endpoint.length > 0 ? { footer: preset.endpoint } : {}),
  }))
}
