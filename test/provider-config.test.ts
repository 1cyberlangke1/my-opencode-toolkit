import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  deleteCustomProvider,
  loadCustomProviders,
  saveCustomProvider,
} from "../src/provider/config.ts"
import type { CustomProviderConfig } from "../src/provider/types.ts"

const cleanup: string[] = []

async function workspace(): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "tk-provider-config-"))
  cleanup.push(dir)
  const file = join(dir, "opencode.json")
  return { dir, file }
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("provider config safe editor", () => {
  it("无文件时 load 返回空列表，save 能自动创建", async () => {
    const { file } = await workspace()
    const loaded = await loadCustomProviders(file)
    expect(loaded.ok).toBe(true)
    if (loaded.ok) {
      expect(loaded.providers).toEqual([])
    }

    const provider: CustomProviderConfig = {
      id: "my-test",
      name: "My Test Provider",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "https://api.test.com/v1", apiKey: "sk-123" },
      models: {
        "model-a": {
          id: "model-a",
          name: "Model A",
          limit: { context: 128000, output: 4096 },
          capabilities: { tools: true, input: ["text"], output: ["text"] },
        },
      },
    }

    const saved = await saveCustomProvider(file, provider)
    expect(saved.ok).toBe(true)

    const reloaded = await loadCustomProviders(file)
    expect(reloaded.ok).toBe(true)
    if (reloaded.ok) {
      expect(reloaded.providers.length).toBe(1)
      expect(reloaded.providers[0]?.id).toBe("my-test")
      expect(reloaded.providers[0]?.options.baseURL).toBe("https://api.test.com/v1")
      expect(reloaded.providers[0]?.models["model-a"]?.limit?.context).toBe(128000)
    }
  })

  it("保留文件中原有的注释、其他全局字段与缩进格式", async () => {
    const { file } = await workspace()
    const initialText = `{
  // 这是用户的自定义插件配置
  "plugins": ["my-plugin"],
  /* 核心主题设置 */
  "theme": "dark",
  "provider": {
    // 官方原生提供商，不能破坏
    "anthropic": {}
  }
}
`
    await writeFile(file, initialText, "utf8")

    const provider: CustomProviderConfig = {
      id: "custom-one",
      name: "Custom One",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "https://api.custom.com/v1" },
      models: {
        "m-1": {
          id: "m-1",
          name: "M 1",
          limit: { context: 64000, output: 2048 },
          capabilities: { tools: true, input: ["text"], output: ["text"] },
        },
      },
    }

    const saved = await saveCustomProvider(file, provider)
    expect(saved.ok).toBe(true)

    const content = await readFile(file, "utf8")
    // 注释必须完好无损保留！
    expect(content).toContain("// 这是用户的自定义插件配置")
    expect(content).toContain("/* 核心主题设置 */")
    expect(content).toContain("// 官方原生提供商，不能破坏")
    expect(content).toContain('"theme": "dark"')
    expect(content).toContain('"custom-one"')
  })

  it("当原有文件存在语法错误时，前置校验拦截并绝不破坏文件", async () => {
    const { file } = await workspace()
    // 故意写一个少闭合括号的坏 JSON
    const corruptedText = `{
  "theme": "dark",
  "provider": {
`
    await writeFile(file, corruptedText, "utf8")

    const provider: CustomProviderConfig = {
      id: "test",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "https://api.com" },
      models: {},
    }

    const saved = await saveCustomProvider(file, provider)
    expect(saved.ok).toBe(false)
    if (!saved.ok) {
      expect(saved.error).toContain("parse error")
    }

    // 磁盘文件保持原样，没有被写空或截断
    const after = await readFile(file, "utf8")
    expect(after).toBe(corruptedText)
  })

  it("删除提供商只移除对应 key，保留其他内容", async () => {
    const { file } = await workspace()
    const initialText = `{
  // 全局配置注释
  "theme": "light",
  "provider": {
    "keep-me": {
      "options": { "baseURL": "https://keep.com" }
    },
    "delete-me": {
      "options": { "baseURL": "https://delete.com" }
    }
  }
}
`
    await writeFile(file, initialText, "utf8")

    const deleted = await deleteCustomProvider(file, "delete-me")
    expect(deleted.ok).toBe(true)

    const content = await readFile(file, "utf8")
    expect(content).toContain("// 全局配置注释")
    expect(content).toContain('"keep-me"')
    expect(content).not.toContain('"delete-me"')
  })

  it("容错兼容：对只有 limit 和 variants、完全没有 capabilities 的模型安全读取并保留扩展字段", async () => {
    const { file } = await workspace()
    const rawRealConfig = `{
  "provider": {
    "commandcode": {
      "name": "Command Code",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://api.commandcode.ai/provider/v1",
        "setCacheKey": true
      },
      "models": {
        "deepseek/deepseek-v4-flash": {
          "limit": {
            "context": 1000000,
            "output": 384000
          },
          "variants": {
            "high": { "reasoningEffort": "high" }
          }
        }
      }
    }
  }
}`
    await writeFile(file, rawRealConfig, "utf8")

    const loaded = await loadCustomProviders(file)
    expect(loaded.ok).toBe(true)
    if (loaded.ok) {
      expect(loaded.providers.length).toBe(1)
      const p = loaded.providers[0]
      expect(p).toBeDefined()
      if (p === undefined) return
      expect(p.id).toBe("commandcode")
      expect(p.options["setCacheKey"]).toBe(true)
      const m = p.models["deepseek/deepseek-v4-flash"]
      expect(m).toBeDefined()
      if (m === undefined) return
      expect(m.id).toBe("deepseek/deepseek-v4-flash")
      expect(m.limit?.context).toBe(1000000)
      // 容错补齐的 capabilities
      expect(m.capabilities?.tools).toBe(true)
      expect(m.capabilities?.input).toEqual(["text"])

      // 再次保存时，保留原有 variants 和 setCacheKey
      const saveRes = await saveCustomProvider(file, p)
      expect(saveRes.ok).toBe(true)

      const savedText = await readFile(file, "utf8")
      expect(savedText).toContain('"setCacheKey": true')
      expect(savedText).toContain('"reasoningEffort": "high"')
    }
  })
})
