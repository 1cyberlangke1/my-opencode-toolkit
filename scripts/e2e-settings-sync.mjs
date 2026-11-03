#!/usr/bin/env bun
/**
 * 验证外部进程/编辑器修改配置文件时，OpenCode 服务端能实时感知并自动更新设置。
 *
 * 输入：无（需要本机 opencode 2.x 和 bun）。
 * 输出：在隔离临时环境启动 opencode，外部直接改写全局与项目级 JSONC 配置文件，断言 RPC 读出最新配置。
 *
 * 用法：bun scripts/e2e-settings-sync.mjs
 */

import { strict as assert } from "node:assert"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"

const repo = process.cwd()
const root = await mkdtemp(join(tmpdir(), "opencode-tk-e2e-sync-"))
const configDir = join(root, "config")
const dataDir = join(root, "data")
const projectDir = join(root, "workspace")
for (const dir of [configDir, dataDir, projectDir, join(root, "xdg-config"), join(root, "state"), join(root, "cache")]) {
  await mkdir(dir, { recursive: true })
}

const password = randomBytes(24).toString("base64url")
const basic = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`

const fake = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    const url = new URL(request.url)
    if (url.pathname === "/v1/models") {
      return Response.json({ object: "list", data: [{ id: "fake", object: "model" }] })
    }
    return Response.json({
      id: "chatcmpl-sync",
      object: "chat.completion",
      created: 0,
      model: "fake",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    })
  },
})

const config = {
  plugins: [{ package: repo }],
  provider: {
    fake: {
      name: "Fake",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: `http://127.0.0.1:${fake.port}/v1`, apiKey: "test" },
      models: {
        fake: {
          name: "Fake",
          limit: { context: 100_000, output: 2_000 },
          capabilities: { tools: true, input: ["text"], output: ["text"] },
        },
      },
    },
  },
}

const globalConfigFile = join(configDir, "my-opencode-toolkit.json")
await writeFile(
  globalConfigFile,
  JSON.stringify({ lang: "auto", scheduling: { enabled: true } }, null, 2),
  "utf8",
)

const env = {
  ...process.env,
  HOME: root,
  OPENCODE_CONFIG_DIR: configDir,
  OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
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

  // 1. 验证初始配置
  const initial = await api("POST", "/api/rpc/my-opencode-toolkit/settingsGet", { input: {} })
  assert.equal(initial.lang, "auto", "initial lang should be auto")
  assert.equal(initial.scheduling.enabled, true, "initial scheduling should be true")
  console.log("case 1 passed: initial settings loaded")

  // 2. 外部直接修改全局配置文件
  await writeFile(
    globalConfigFile,
    JSON.stringify({ lang: "zh", scheduling: { enabled: false } }, null, 2),
    "utf8",
  )

  await new Promise((resolve) => setTimeout(resolve, 200))

  const afterGlobalChange = await api("POST", "/api/rpc/my-opencode-toolkit/settingsGet", { input: {} })
  assert.equal(afterGlobalChange.lang, "zh", "external global config modification must update lang to zh")
  assert.equal(afterGlobalChange.scheduling.enabled, false, "external global config modification must update scheduling.enabled to false")
  console.log("case 2 passed: external global config modification synced")

  // 3. 项目层创建 .opencode/my-opencode-toolkit.json
  const projectOpencodeDir = join(projectDir, ".opencode")
  await mkdir(projectOpencodeDir, { recursive: true })
  const projectConfigFile = join(projectOpencodeDir, "my-opencode-toolkit.json")
  await writeFile(
    projectConfigFile,
    JSON.stringify({ lang: "en" }, null, 2),
    "utf8",
  )

  await new Promise((resolve) => setTimeout(resolve, 200))

  const afterProjectChange = await api("POST", "/api/rpc/my-opencode-toolkit/settingsGet", { input: {} })
  assert.equal(afterProjectChange.lang, "en", "project config must override global lang to en")
  assert.equal(afterProjectChange.scheduling.enabled, false, "unspecified fields in project config must inherit global")
  console.log("case 3 passed: project layer config creation synced and merged")

  // 4. 当前窗口 RPC settingsSet 保存配置
  const setResult = await api("POST", "/api/rpc/my-opencode-toolkit/settingsSet", {
    input: {
      ...afterProjectChange,
      lang: "zh",
    },
  })
  assert.equal(setResult.lang, "zh", "settingsSet should return updated settings")

  const afterSet = await api("POST", "/api/rpc/my-opencode-toolkit/settingsGet", { input: {} })
  assert.equal(afterSet.lang, "zh", "settingsSet must be immediately visible")
  console.log("case 4 passed: internal settingsSet works seamlessly with watcher")

  console.log("all tk settings sync e2e cases passed successfully!")
} finally {
  server.kill()
  fake.stop()
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
}
