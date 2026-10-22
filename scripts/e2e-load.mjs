#!/usr/bin/env bun
/**
 * 输入：无（需要本机 opencode 2.x 与 bun）。
 * 输出：在隔离的临时 HOME/DB/config 里启动 opencode，用假 provider 驱动一次工具调用。
 * 预期：首次请求的工具表包含 `toolkit_ping`；模型调用后，第二次请求里能读到工具返回的状态行；
 *       插件默认设置已写入隔离数据库。不会读写日常使用的 OpenCode 数据。
 *
 * 用法：bun scripts/e2e-load.mjs
 */

import { strict as assert } from "node:assert"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { Database } from "bun:sqlite"

const repo = process.cwd()
const root = await mkdtemp(join(tmpdir(), "opencode-e2e-load-"))
const configDir = join(root, "config")
const dataDir = join(root, "data")
for (const dir of [configDir, dataDir, join(root, "xdg-config"), join(root, "state"), join(root, "cache")]) {
  await mkdir(dir, { recursive: true })
}

const password = randomBytes(24).toString("base64url")
const basic = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`

/** 已服务的请求数；0 表示首轮（返回工具调用）。 */
let served = 0
/** 首轮请求里看到的工具名。 */
let toolNames = []
/** 第二轮请求里看到的工具结果文本。 */
let toolResultText = ""

/** 输入：文本；输出：SSE 分片构造器。预期：每个分片都是合法 chat.completion.chunk。 */
function chunker() {
  return (delta, finish, usage) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-load",
      object: "chat.completion.chunk",
      created: 0,
      model: "fake",
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage === undefined ? {} : { usage }),
    })}\n\n`
}

/**
 * 输入：OpenAI chat 请求体。
 * 输出：流式响应。
 * 预期：第一次返回 `toolkit_ping` 的 tool_calls；第二次把工具结果记录下来并返回 done。
 */
function handle(body) {
  const stream = body?.stream === true
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const chunk = chunker()
  const usage = { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 }

  if (served === 0) {
    served = 1
    toolNames = Array.isArray(body?.tools)
      ? body.tools.map((tool) => tool?.function?.name ?? tool?.name).filter((name) => typeof name === "string")
      : []
    const call = {
      role: "assistant",
      tool_calls: [{ index: 0, id: "call_ping", function: { name: "toolkit_ping", arguments: "" } }],
    }
    if (stream) {
      const sse =
        chunk(call, null) +
        chunk({ tool_calls: [{ index: 0, function: { arguments: "{}" } }] }, null) +
        chunk({}, "tool_calls") +
        chunk({}, "stop", usage) +
        "data: [DONE]\n\n"
      return new Response(sse, { headers: { "content-type": "text/event-stream" }, status: 200 })
    }
    return Response.json({
      id: "chatcmpl-load",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "fake",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_ping", type: "function", function: { name: "toolkit_ping", arguments: "{}" } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage,
    })
  }

  served = 2
  toolResultText = messages
    .filter((message) => message?.role === "tool")
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
    .join("\n")

  if (stream) {
    return new Response(
      `${chunk({ role: "assistant", content: "done" }, null)}${chunk({}, "stop", usage)}data: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" }, status: 200 },
    )
  }
  return Response.json({
    id: "chatcmpl-load",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "fake",
    choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
    usage,
  })
}

const fake = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    const url = new URL(request.url)
    if (url.pathname === "/v1/models") {
      return Response.json({ object: "list", data: [{ id: "fake", object: "model" }] })
    }
    if (url.pathname !== "/v1/chat/completions" || request.method !== "POST") {
      return new Response("not found", { status: 404 })
    }
    const body = await request.json()
    try {
      return handle(body)
    } catch (error) {
      console.log("provider error", error)
      return new Response(String(error), { status: 500 })
    }
  },
})

const config = {
  compaction: { auto: false },
  plugins: [process.env.E2E_PLUGIN ?? repo],
  provider: {
    fake: {
      name: "Fake Load",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: `http://127.0.0.1:${fake.port}/v1`, apiKey: "test" },
      models: {
        fake: {
          name: "Fake",
          limit: { context: 1_000_000, output: 2_000 },
          capabilities: { tools: true, input: ["text"], output: ["text"] },
        },
      },
    },
  },
}

const env = {
  ...process.env,
  HOME: root,
  USERPROFILE: root,
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

const opencode = process.env.OPENCODE_BIN ?? "opencode.cmd"
const server = Bun.spawn(["cmd.exe", "/d", "/s", "/c", `${opencode} serve --stdio --port 0 --print-logs`], {
  env,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
})

const stdoutReader = server.stdout.getReader()
const stdoutDecoder = new TextDecoder()
let port
{
  let line = ""
  while (!line.includes("\n")) {
    const { value, done } = await stdoutReader.read()
    if (done) break
    line += stdoutDecoder.decode(value)
  }
  port = new URL(JSON.parse(line).url).port
  console.log("isolated server:", port)
}

/** 收集服务端 stdout（首个 JSON 行之后）与 stderr，插件加载失败时用来定位。 */
let stdoutText = ""
void (async () => {
  for (;;) {
    const { value, done } = await stdoutReader.read()
    if (done) return
    stdoutText += stdoutDecoder.decode(value)
  }
})()

let stderrText = ""
void (async () => {
  const reader = server.stderr.getReader()
  const decoder = new TextDecoder()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    stderrText += decoder.decode(value)
  }
})()

const api = async (method, path, body) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { authorization: basic, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${await response.text()}`)
  const text = await response.text()
  const json = text.length === 0 ? undefined : JSON.parse(text)
  return json?.data ?? json
}

const created = await api("POST", "/api/session", {
  title: "e2e-load",
  model: { providerID: "fake", id: "fake" },
})
const sessionID = created.id ?? created.sessionID
assert.ok(sessionID, "session id missing")

await api("POST", `/api/session/${sessionID}/prompt`, { text: "call the toolkit ping tool" })
await api("POST", `/api/experimental/session/${sessionID}/wait`)

const pluginHex = Array.from("my-opencode-toolkit")
  .map((char) => (char.codePointAt(0) ?? 0).toString(16).padStart(4, "0"))
  .join("")
const db = new Database(join(root, "opencode.db"), { readonly: true })
const row = db.query("select value from kv where key = ?").get(`plugin:${pluginHex}:settings`)
db.close()
const settings = typeof row?.value === "string" ? JSON.parse(row.value) : undefined

if (!toolNames.includes("toolkit_ping")) {
  await Bun.write(join(root, "stdout.log"), stdoutText)
  await Bun.write(join(root, "stderr.log"), stderrText)
  console.log("logs saved to:", root)
}

assert.equal(served, 2, "provider must serve two requests (tool call + final answer)")
assert.ok(toolNames.includes("toolkit_ping"), `tool table must include toolkit_ping, got ${toolNames.join(",")}`)
assert.ok(toolResultText.includes("my-opencode-toolkit"), `tool result missing, got ${toolResultText}`)
assert.equal(settings?.lang, "auto", "default settings must be written to storage")
assert.equal(settings?.enabled, true, "plugin must default to enabled")

console.log("tools:", toolNames.length, "has toolkit_ping:", toolNames.includes("toolkit_ping"))
console.log("tool result:", toolResultText.split("\n")[0])
console.log("settings:", JSON.stringify(settings))
console.log("case passed: plugin loads and tool executes")

server.kill()
await rm(root, { recursive: true, force: true }).catch(() => undefined)
process.exit(0)
