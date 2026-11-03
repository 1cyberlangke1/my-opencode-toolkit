import { createServer, type Server } from "node:http"
import { afterEach, describe, expect, it } from "vitest"

import { fetchRemoteModels } from "../src/provider/fetcher.ts"

let server: Server | undefined

afterEach(() => {
  if (server !== undefined) {
    server.close()
    server = undefined
  }
})

describe("provider fetcher", () => {
  it("正常从 OpenAI 兼容的 /v1/models 接口拉取模型列表", async () => {
    let capturedAuth: string | undefined
    server = createServer((req, res) => {
      capturedAuth = req.headers.authorization
      if (req.url === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({
          data: [{ id: "deepseek-chat" }, { id: "qwen-max" }],
        }))
        return
      }
      res.writeHead(404).end()
    })

    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (typeof address !== "object" || address === null) throw new Error("no address")

    const res = await fetchRemoteModels(`http://127.0.0.1:${address.port.toString()}/v1`, "my-secret-key")
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.modelIDs).toEqual(["deepseek-chat", "qwen-max"])
    }
    expect(capturedAuth).toBe("Bearer my-secret-key")
  })

  it("支持 Ollama / models 格式对象返回", async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({
        models: [{ name: "llama3.2:latest" }, { name: "qwen2.5-coder:7b" }],
      }))
    })

    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (typeof address !== "object" || address === null) throw new Error("no address")

    const res = await fetchRemoteModels(`http://127.0.0.1:${address.port.toString()}`)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.modelIDs).toEqual(["llama3.2:latest", "qwen2.5-coder:7b"])
    }
  })

  it("远端报错 401 Unauthorized 时返回友好错误", async () => {
    server = createServer((_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Invalid key" }))
    })

    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (typeof address !== "object" || address === null) throw new Error("no address")

    const res = await fetchRemoteModels(`http://127.0.0.1:${address.port.toString()}/v1`, "bad-key")
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toContain("401")
    }
  })
})
