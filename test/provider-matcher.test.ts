import { describe, expect, it } from "vitest"

import {
  defaultProviderIdFromName,
  defaultProviderNameFromUrl,
  FALLBACK_LIMIT,
  formatCapabilitiesEmoji,
  matchModelCapabilities,
} from "../src/provider/matcher.ts"
import type { KnownModelRef } from "../src/provider/types.ts"

const MOCK_KNOWN_MODELS: KnownModelRef[] = [
  {
    id: "deepseek-chat",
    name: "DeepSeek V3",
    limit: { context: 65536, output: 8192 },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
  },
  {
    id: "claude-3-5-sonnet",
    name: "Claude 3.5 Sonnet",
    limit: { context: 200000, output: 8192 },
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
  },
]

describe("provider matcher", () => {
  it("对相似模型名称能模糊匹配到已知模型能力与上下文", () => {
    // 带有组织前缀的中转模型名
    const res1 = matchModelCapabilities("deepseek-ai/DeepSeek-V3", MOCK_KNOWN_MODELS)
    expect(res1.matched).toBe(true)
    expect(res1.matchedName).toBe("DeepSeek V3")
    expect(res1.limit.context).toBe(65536)
    expect(res1.limit.output).toBe(8192)
    expect(res1.capabilities.tools).toBe(true)

    // 带有日期后缀的官方模型名
    const res2 = matchModelCapabilities("claude-3-5-sonnet-20241022", MOCK_KNOWN_MODELS)
    expect(res2.matched).toBe(true)
    expect(res2.matchedName).toBe("Claude 3.5 Sonnet")
    expect(res2.limit.context).toBe(200000)
    expect(res2.capabilities.input).toContain("image")
  })

  it("完全未知/冷门模型回落到 128k 纯文本兜底", () => {
    const res = matchModelCapabilities("my-custom-private-lora-v1", MOCK_KNOWN_MODELS)
    expect(res.matched).toBe(false)
    expect(res.limit.context).toBe(FALLBACK_LIMIT.context)
    expect(res.limit.context).toBe(128000)
    expect(res.limit.output).toBe(FALLBACK_LIMIT.output)
    expect(res.limit.output).toBe(4096)
    expect(res.capabilities.tools).toBe(true)
    expect(res.capabilities.input).toEqual(["text"])
    expect(res.capabilities.output).toEqual(["text"])
  })

  it("formatCapabilitiesEmoji 能正确渲染紧凑的 emoji 能力标记", () => {
    const emoji1 = formatCapabilitiesEmoji({
      limit: { context: 65536, output: 8192 },
      capabilities: { tools: true, input: ["text"], output: ["text"] },
    })
    expect(emoji1).toContain("🪟 66k")
    expect(emoji1).toContain("🛠️")
    expect(emoji1).toContain("💬")
    expect(emoji1).not.toContain("👁️")

    const emoji2 = formatCapabilitiesEmoji({
      limit: { context: 200000, output: 8192 },
      capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    })
    expect(emoji2).toContain("🪟 200k")
    expect(emoji2).toContain("🛠️")
    expect(emoji2).toContain("👁️")
    expect(emoji2).toContain("💬")
  })

  it("从 URL 自动提取域名生成默认名称与 ID", () => {
    expect(defaultProviderNameFromUrl("https://api.zhizengzheng.com/v1")).toBe("zhizengzheng")
    expect(defaultProviderNameFromUrl("https://api.deepseek.com")).toBe("deepseek")
    expect(defaultProviderNameFromUrl("http://192.168.1.100:8000/v1")).toBe("192.168.1.100:8000")
    expect(defaultProviderNameFromUrl("localhost:11434")).toBe("localhost:11434")

    expect(defaultProviderIdFromName("zhizengzheng")).toBe("zhizengzheng")
    expect(defaultProviderIdFromName("我的 节点 #1")).toBe("1")
    expect(defaultProviderIdFromName("My-Provider")).toBe("my-provider")
  })
})
