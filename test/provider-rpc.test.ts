import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { ProviderService } from "../src/provider/service.ts"
import type { CustomProviderConfig, KnownModelRef } from "../src/provider/types.ts"

const cleanup: string[] = []

async function tempConfig(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tk-rpc-provider-"))
  cleanup.push(dir)
  return join(dir, "opencode.json")
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const MOCK_KNOWN: KnownModelRef[] = [
  {
    id: "deepseek-chat",
    name: "DeepSeek V3",
    limit: { context: 65536, output: 8192 },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
  },
]

describe("provider rpc service", () => {
  it("getProviders / saveProvider / deleteProvider 完整生命周期", async () => {
    const configFilePath = await tempConfig()
    const service = new ProviderService({
      configFilePath,
      listKnownModels: () => Promise.resolve(MOCK_KNOWN),
    })

    const initial = await service.getProviders()
    expect(initial.ok).toBe(true)
    expect(initial.providers).toEqual([])

    const provider: CustomProviderConfig = {
      id: "my-proxy",
      name: "My Proxy",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "https://api.myproxy.com/v1" },
      models: {
        "deepseek-chat": {
          id: "deepseek-chat",
          name: "DeepSeek V3",
          limit: { context: 65536, output: 8192 },
          capabilities: { tools: true, input: ["text"], output: ["text"] },
        },
      },
    }

    const saveRes = await service.saveProvider(provider)
    expect(saveRes.ok).toBe(true)

    const afterSave = await service.getProviders()
    expect(afterSave.ok).toBe(true)
    expect(afterSave.providers.length).toBe(1)
    expect(afterSave.providers[0]?.id).toBe("my-proxy")

    const delRes = await service.deleteProvider("my-proxy")
    expect(delRes.ok).toBe(true)

    const afterDel = await service.getProviders()
    expect(afterDel.ok).toBe(true)
    expect(afterDel.providers).toEqual([])
  })

  it("rematchModel 能单条重新匹配能力", async () => {
    const configFilePath = await tempConfig()
    const service = new ProviderService({
      configFilePath,
      listKnownModels: () => Promise.resolve(MOCK_KNOWN),
    })

    const matched = await service.rematchModel("deepseek-chat")
    expect(matched.matched).toBe(true)
    expect(matched.limit.context).toBe(65536)

    const unmatched = await service.rematchModel("unrecognized-custom-ai")
    expect(unmatched.matched).toBe(false)
    expect(unmatched.limit.context).toBe(128000)
  })
})
