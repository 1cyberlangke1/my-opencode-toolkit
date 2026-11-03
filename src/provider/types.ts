/**
 * 自定义提供商与模型的类型定义。
 */

/** 模型能力限制。 */
export type CustomModelLimit = {
  readonly context: number
  readonly output: number
}

/** 模型能力标志（多模态、工具调用等）。 */
export type CustomModelCapabilities = {
  readonly tools: boolean
  readonly input: readonly string[]
  readonly output: readonly string[]
}

/** 单个模型配置。 */
export type CustomModelConfig = {
  readonly id: string
  readonly name?: string | undefined
  /** 是否在 OpenCode 中启用该模型；默认 true。 */
  readonly enabled?: boolean | undefined
  readonly limit?: CustomModelLimit | undefined
  readonly capabilities?: CustomModelCapabilities | undefined
}

/** 提供商选项（Base URL、API Key 等）。 */
export type CustomProviderOptions = {
  readonly baseURL: string
  readonly apiKey?: string | undefined
}

/** 自定义提供商配置（对应 opencode.json 中 provider.<id> 的结构）。 */
export type CustomProviderConfig = {
  readonly id: string
  readonly name?: string | undefined
  /** 底层 SDK 适配包名；默认 "@ai-sdk/openai-compatible"。 */
  readonly npm: string
  readonly options: CustomProviderOptions
  readonly models: Record<string, CustomModelConfig>
}

/** 已知模型参考信息（通常来自 ctx.model.list()）。 */
export type KnownModelRef = {
  readonly id: string
  readonly name: string
  readonly limit?: { readonly context: number; readonly output: number } | undefined
  readonly capabilities?: { readonly tools: boolean; readonly input: readonly string[]; readonly output: readonly string[] } | undefined
}

/** 模型匹配与回落结果。 */
export type MatchedModelResult = {
  readonly id: string
  readonly name: string
  readonly limit: CustomModelLimit
  readonly capabilities: CustomModelCapabilities
  readonly matched: boolean
  readonly matchedName?: string | undefined
}
