/**
 * 模型能力模糊匹配与兜底生成器。
 */

import { formatTokens } from "../shared/format.ts"
import type {
  CustomModelCapabilities,
  CustomModelLimit,
  KnownModelRef,
  MatchedModelResult,
} from "./types.ts"

/** 兜底上下文上限：128,000 (128k)。 */
export const FALLBACK_LIMIT: CustomModelLimit = {
  context: 128000,
  output: 4096,
}

/** 兜底能力：开启工具调用，纯文本输入输出。 */
export const FALLBACK_CAPABILITIES: CustomModelCapabilities = {
  tools: true,
  input: ["text"],
  output: ["text"],
}

/**
 * 计算两个字符串的 Levenshtein 编辑距离。
 *
 * 输入：两个字符串。
 * 输出：非负整数编辑距离。
 * 预期：相同返回 0，空串返回另一字符串长度。
 */
function levenshteinDistance(s1: string, s2: string): number {
  if (s1 === s2) return 0
  if (s1.length === 0) return s2.length
  if (s2.length === 0) return s1.length

  let prevRow: number[] = Array.from({ length: s1.length + 1 }, (_, i) => i)
  for (let j = 1; j <= s2.length; j += 1) {
    const nextRow: number[] = [j]
    for (let i = 1; i <= s1.length; i += 1) {
      const p = prevRow[i - 1] ?? 0
      const cost = s1[i - 1] === s2[j - 1] ? p : Math.min(p + 1, (nextRow[i - 1] ?? 0) + 1, (prevRow[i] ?? 0) + 1)
      nextRow.push(cost)
    }
    prevRow = nextRow
  }
  return prevRow[s1.length] ?? s1.length
}

/**
 * 计算两个模型名称的模糊相似度 [0, 1]。
 *
 * 输入：模型标识 A 与 B。
 * 输出：相似度得分，1 为完全相同。
 * 预期：支持包含、无符号归一、编辑距离多维打分。
 */
export function similarityScore(a: string, b: string): number {
  const s1 = a.toLowerCase().trim()
  const s2 = b.toLowerCase().trim()
  if (s1 === s2) return 1.0
  if (s1.length === 0 || s2.length === 0) return 0.0

  // 包含关系优先：例如 "deepseek-ai/DeepSeek-V3" 包含 "deepseek-v3"
  if (s1.includes(s2) || s2.includes(s1)) {
    const minLen = Math.min(s1.length, s2.length)
    const maxLen = Math.max(s1.length, s2.length)
    return Math.max(0.7, minLen / maxLen + 0.25)
  }

  // 去除非字母数字比较：如 "deepseek-v3" 与 "deepseekv3"
  const strip1 = s1.replace(/[^a-z0-9]/g, "")
  const strip2 = s2.replace(/[^a-z0-9]/g, "")
  if (strip1 === strip2 && strip1.length > 0) return 0.95
  if (strip1.includes(strip2) || strip2.includes(strip1)) {
    return 0.8
  }

  const maxLen = Math.max(s1.length, s2.length)
  const dist = levenshteinDistance(s1, s2)
  return Math.max(0, 1 - dist / maxLen)
}

/**
 * 将远端模型 ID 与已知模型库做模糊匹配；若未匹配上则回落到 128k 兜底配置。
 *
 * 输入：远端模型 ID、已知模型参考列表。
 * 输出：匹配或回落后的能力规格。
 * 预期：相似度 >= 0.5 视为命中已知模型。
 */
export function matchModelCapabilities(
  modelID: string,
  knownModels: readonly KnownModelRef[],
): MatchedModelResult {
  let bestScore = 0
  let bestKnown: KnownModelRef | undefined

  for (const known of knownModels) {
    const scoreId = similarityScore(modelID, known.id)
    const scoreName = similarityScore(modelID, known.name)
    const score = Math.max(scoreId, scoreName)
    if (score > bestScore) {
      bestScore = score
      bestKnown = known
    }
  }

  if (bestScore >= 0.5 && bestKnown !== undefined) {
    return {
      id: modelID,
      name: bestKnown.name,
      limit: {
        context: bestKnown.limit?.context ?? FALLBACK_LIMIT.context,
        output: bestKnown.limit?.output ?? FALLBACK_LIMIT.output,
      },
      capabilities: {
        tools: bestKnown.capabilities?.tools ?? FALLBACK_CAPABILITIES.tools,
        input: bestKnown.capabilities?.input ?? FALLBACK_CAPABILITIES.input,
        output: bestKnown.capabilities?.output ?? FALLBACK_CAPABILITIES.output,
      },
      matched: true,
      matchedName: bestKnown.name,
    }
  }

  return {
    id: modelID,
    name: modelID,
    limit: FALLBACK_LIMIT,
    capabilities: FALLBACK_CAPABILITIES,
    matched: false,
  }
}

/**
 * 切换模型的一种输入模态。
 *
 * 输入：当前能力描述（可为空）+ 模态名（如 "image" / "audio" / "video"）。
 * 输出：新的输入模态数组。
 * 预期：已存在则移除，不存在则追加；能力缺失时按纯文本兜底后再追加。
 */
export function toggleInputModality(
  capabilities: CustomModelCapabilities | undefined,
  modality: string,
): readonly string[] {
  const current = capabilities?.input ?? ["text"]
  return current.includes(modality)
    ? current.filter((item) => item !== modality)
    : [...current, modality]
}

/**
 * 将模型的能力特征格式化为紧凑美观的 Emoji 符号组合。
 *
 * 输入：模型规格。
 * 输出：Emoji 字符串，如 "🪟 64k 🛠️ 💬" 或 "🪟 200k 🛠️ 👁️ 💬"。
 * 预期：直观展示上下文窗口与多模态能力。
 */
export function formatCapabilitiesEmoji(model: {
  readonly limit?: { readonly context?: number; readonly output?: number } | undefined
  readonly capabilities?: {
    readonly tools?: boolean
    readonly input?: readonly string[]
    readonly output?: readonly string[]
  } | undefined
}): string {
  const parts: string[] = []

  const context = model.limit?.context
  if (typeof context === "number" && context > 0) {
    parts.push(`🪟 ${formatTokens(context)}`)
  }

  if (model.capabilities?.tools !== false) {
    parts.push("🛠️")
  }

  const input = model.capabilities?.input
  if (input !== undefined) {
    if (input.includes("image")) parts.push("👁️")
    if (input.includes("audio")) parts.push("🎙️")
    if (input.includes("video")) parts.push("🎬")
  }

  parts.push("💬")

  return parts.join(" ")
}

/**
 * 输入：Base URL 字符串。
 * 输出：提炼出的默认提供商名称。
 * 预期：如 "https://api.zhizengzheng.com/v1" -> "zhizengzheng"。
 */
export function defaultProviderNameFromUrl(urlStr: string): string {
  try {
    const raw = urlStr.trim()
    const withProto = raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`
    const url = new URL(withProto)
    const host = url.hostname

    // IP 地址：保留 host 与端口
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host === "localhost") {
      return url.port.length > 0 ? `${host}:${url.port}` : host
    }

    // 域名：去除 api. 前缀，提取主域名段
    const cleanHost = host.replace(/^api\./i, "")
    const parts = cleanHost.split(".")
    if (parts.length >= 2) {
      const first = parts[0]
      if (first !== undefined && first.length > 1) {
        return first
      }
    }
    return cleanHost.length > 0 ? cleanHost : "custom"
  } catch {
    return "custom"
  }
}

/**
 * 输入：提供商显示名称。
 * 输出：合法的 ID 标识（仅保留小写字母、数字、短横线）。
 * 预期：中文或特殊符号被转成短横线或安全标识。
 */
export function defaultProviderIdFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")

  if (slug.length > 0) return slug
  return `provider-${Date.now().toString(36)}`
}
