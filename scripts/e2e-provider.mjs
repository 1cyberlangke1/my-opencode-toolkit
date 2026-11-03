#!/usr/bin/env bun
/**
 * 验证自定义提供商管理在真实 OpenCode 进程中的完整链路。
 *
 * 输入：无（需要本机 opencode 2.x 和 bun）。
 * 输出：
 *   1. 模拟远端 /v1/models 接口。
 *   2. providerModelsFetch 远端拉取并模糊匹配已知模型，未知模型 128k 兜底。
 *   3. providerModelMatch 单模型能力重匹配。
 *   4. providerSave 安全写入 opencode.json，保留原有注释。
 *   5. providersGet 重新读取验证。
 *   6. providerDelete 安全删除提供商，验证配置恢复与注释保留。
 *
 * 用法：bun scripts/e2e-provider.mjs
 */

import { strict as assert } from "node:assert"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"

const repo = process.cwd()
const root = await mkdtemp(join(tmpdir(), "opencode-tk-e2e-provider-"))
const configDir = join(root, "config")
const dataDir = join(root, "data")
const projectDir = join(root, "workspace")
for (const dir of [configDir, dataDir, projectDir, join(root, "xdg-config"), join(root, "state"), join(root, "cache")]) {
  await mkdir(dir, { recursive: true })
}

const password = randomBytes(24).toString("base64url")
const basic = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`

let remoteAuthHeader = ""
const fake = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    const url = new URL(request.url)
    remoteAuthHeader = request.headers.get("authorization") ?? ""
    if (url.pathname === "/v1/models") {
      return Response.json({
        data: [
          { id: "deepseek-ai/DeepSeek-V3" },
          { id: "custom-customer-service-v1" },
        ],
      })
    }
    return Response.json({
      id: "chatcmpl-provider",
      object: "chat.completion",
      created: 0,
      model: "deepseek-ai/DeepSeek-V3",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    })
  },
})

// 原有 opencode.json，带有重要的用户手写注释
const initialOpencodeJson = `{
  // 用户的核心注释：请勿删除
  "plugins": [
    { "package": "${repo.replace(/\\/g, "/")}" }
  ],
  "theme": "dark",
  "provider": {
    // 官方原生提供商
    "fake-test": {
      "name": "Fake Test",
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:${fake.port}/v1" }
    }
  }
}
`

const opencodeConfigFile = join(configDir, "opencode.json")
await writeFile(opencodeConfigFile, initialOpencodeJson, "utf8")

const env = {
  ...process.env,
  HOME: root,
  OPENCODE_CONFIG_DIR: configDir,
  OPENCODE_DB: join(root, "opencode.db"),
  OPENCODE_DISABLE_FILEWATCHER: "true",
  OPENCODE_DISABLE_MODELS_FETCH: "true",
  OPENCODE_PASSWORD: password,
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_CONFIG_HOME: join(root, "xdg-config"),
  XDG_DATA_HOME: dataDir,
  XDG_STATE_HOME: join(root, "state"),
}

const isWindows = process.platform === "win32"
const opencode = process.env.OPENCODE_BIN ?? (isWindows ? "opencode.cmd" : "opencode")
const server = Bun.spawn(
  isWindows
    ? ["cmd.exe", "/d", "/s", "/c", `${opencode} serve --stdio --port 0 --print-logs`]
    : [opencode, "serve", "--stdio", "--port", "0", "--print-logs"],
  {
    cwd: projectDir,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  },
)

let port
try {
  const reader = server.stdout.getReader()
  const decoder = new TextDecoder()
  let line = ""
  while (!line.includes("\n")) {
    const { value, done } = await reader.read()
    if (done) break
    line += decoder.decode(value)
  }
  const first = line.split("\n")[0]
  const ready = JSON.parse(first)
  port = new URL(ready.url).port
  console.log("isolated server online:", ready.url)

  const api = async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        authorization: basic,
        "content-type": "application/json",
        "x-opencode-directory": projectDir,
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!response.ok) {
      const text = await response.text()
      throw new Error(`${method} ${path} failed: ${response.status} ${text}`)
    }
    const json = await response.json()
    return json.output ?? json.data ?? json
  }

  // 1. 验证初始状态：仅有内置/原生提供商，没有自定义提供商（或者仅有自带的）
  const initial = await api("POST", "/api/rpc/my-opencode-toolkit/providersGet", { input: {} })
  assert.equal(initial.ok, true, "providersGet should succeed")
  console.log("case 1 passed: initial providers fetched")

  // 2. 远端拉取并模糊匹配模型
  const fetchRes = await api("POST", "/api/rpc/my-opencode-toolkit/providerModelsFetch", {
    input: {
      baseURL: `http://127.0.0.1:${fake.port}/v1`,
      apiKey: "sk-e2e-secret-key",
    },
  })
  assert.equal(fetchRes.ok, true, "providerModelsFetch should succeed")
  assert.equal(remoteAuthHeader, "Bearer sk-e2e-secret-key", "API Key should be passed in Authorization header")
  assert.equal(fetchRes.models.length, 2, "should fetch 2 models")

  const deepseek = fetchRes.models.find((m) => m.id === "deepseek-ai/DeepSeek-V3")
  assert.ok(deepseek, "deepseek model must exist")
  assert.equal(deepseek.capabilities.tools, true, "deepseek should have tool support")

  const customModel = fetchRes.models.find((m) => m.id === "custom-customer-service-v1")
  assert.ok(customModel, "custom model must exist")
  assert.equal(customModel.limit.context, 128000, "unmatched model must fallback to 128k context")
  assert.equal(customModel.limit.output, 4096, "unmatched model must fallback to 4096 output")
  assert.equal(customModel.capabilities.tools, true, "unmatched model fallback tools true")
  console.log("case 2 passed: remote models fetched and matched with 128k fallback")

  // 3. 测试单模型能力重匹配
  const rematchRes = await api("POST", "/api/rpc/my-opencode-toolkit/providerModelMatch", {
    input: { modelID: "claude-3-5-sonnet-20241022" },
  })
  assert.ok(rematchRes.model, "model must be returned")
  assert.equal(rematchRes.model.capabilities.tools, true)
  console.log("case 3 passed: single model capability rematch")

  // 4. 保存自定义提供商
  const saveRes = await api("POST", "/api/rpc/my-opencode-toolkit/providerSave", {
    input: {
      provider: {
        id: "my-e2e-provider",
        name: "My E2E Provider",
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL: `http://127.0.0.1:${fake.port}/v1`,
          apiKey: "sk-e2e-secret-key",
        },
        models: {
          "deepseek-ai/DeepSeek-V3": deepseek,
          "custom-customer-service-v1": customModel,
        },
      },
    },
  })
  assert.equal(saveRes.ok, true, "providerSave should succeed")

  // 验证 opencode.json 磁盘内容：注释完好保留！
  const diskConfig = await readFile(opencodeConfigFile, "utf8")
  assert.ok(diskConfig.includes("// 用户的核心注释：请勿删除"), "comments must be preserved!")
  assert.ok(diskConfig.includes('"my-e2e-provider"'), "custom provider must be written")
  assert.ok(diskConfig.includes('"deepseek-ai/DeepSeek-V3"'), "models must be written")
  console.log("case 4 passed: provider saved safely with comments intact")

  // 5. 重新读取提供商列表
  const afterSave = await api("POST", "/api/rpc/my-opencode-toolkit/providersGet", { input: {} })
  const savedProvider = afterSave.providers.find((p) => p.id === "my-e2e-provider")
  assert.ok(savedProvider, "saved provider must be in list")
  assert.equal(savedProvider.name, "My E2E Provider")
  assert.equal(Object.keys(savedProvider.models).length, 2)
  console.log("case 5 passed: saved provider read back successfully")

  // 6. 删除自定义提供商
  const deleteRes = await api("POST", "/api/rpc/my-opencode-toolkit/providerDelete", {
    input: { providerID: "my-e2e-provider" },
  })
  assert.equal(deleteRes.ok, true, "providerDelete should succeed")

  const diskAfterDelete = await readFile(opencodeConfigFile, "utf8")
  assert.ok(diskAfterDelete.includes("// 用户的核心注释：请勿删除"), "comments must still be preserved after delete")
  assert.ok(!diskAfterDelete.includes('"my-e2e-provider"'), "provider must be removed from file")
  console.log("case 6 passed: provider deleted safely")

  console.log("all e2e provider test cases passed successfully!")
} finally {
  server.kill()
  fake.stop()
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
}
