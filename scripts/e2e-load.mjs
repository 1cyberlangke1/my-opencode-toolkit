#!/usr/bin/env bun
/**
 * 输入：无（需要本机 opencode 2.x 与 bun）。
 * 输出：在隔离的临时 HOME/DB/config 里启动 opencode，用假 provider 驱动五次工具调用。
 * 预期：工具表包含三个 goal 工具与四个 scheduling 工具；
 *       create_goal / get_goal / cron_create / update_goal 依次执行成功；
 *       默认设置、goal 与 durable cron 任务写入隔离数据库。不会读写日常使用的 OpenCode 数据。
 *
 * 用法：bun scripts/e2e-load.mjs
 */

import { strict as assert } from "node:assert"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { Database } from "bun:sqlite"

const GOAL_OBJECTIVE = "finish the e2e goal"

const repo = process.cwd()
const root = await mkdtemp(join(tmpdir(), "opencode-e2e-load-"))
const configDir = join(root, "config")
const dataDir = join(root, "data")
for (const dir of [configDir, dataDir, join(root, "xdg-config"), join(root, "state"), join(root, "cache")]) {
  await mkdir(dir, { recursive: true })
}

const password = randomBytes(24).toString("base64url")
const basic = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`

/** 已服务的请求数：0 创建目标，1 读取目标，2 收尾。 */
let served = 0
/** 首轮请求里看到的工具名。 */
let toolNames = []
/** 最后一轮请求里看到的工具结果文本。 */
let toolResultText = ""

/** 输入：无；输出：SSE 分片构造器。预期：每个分片都是合法 chat.completion.chunk。 */
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
 * 输入：流式标记 + 工具名 + 参数。
 * 输出：一次工具调用的响应。
 * 预期：流式时先发名字、再发完整参数，避免参数被拼成 `{}{}`。
 */
function toolCallResponse(stream, name, args, usage) {
  const chunk = chunker()
  if (stream) {
    const sse =
      chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${String(served)}`, function: { name, arguments: "" } }] }, null) +
      chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }, null) +
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
          tool_calls: [{ id: `call_${String(served)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage,
  })
}

/**
 * 输入：OpenAI chat 请求体。
 * 输出：流式响应。
 * 预期：第 1 轮调用 create_goal，第 2 轮调用 get_goal，第 3 轮创建 cron，
 *       第 4 轮把 goal 标为 complete，第 5 轮返回 done。
 */
function handle(body) {
  const stream = body?.stream === true
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const usage = { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 }

  if (served === 0) {
    served = 1
    toolNames = Array.isArray(body?.tools)
      ? body.tools.map((tool) => tool?.function?.name ?? tool?.name).filter((name) => typeof name === "string")
      : []
    return toolCallResponse(stream, "create_goal", { objective: GOAL_OBJECTIVE }, usage)
  }

  if (served === 1) {
    served = 2
    return toolCallResponse(stream, "get_goal", {}, usage)
  }

  if (served === 2) {
    served = 3
    return toolCallResponse(stream, "cron_create", { cron: "*/5 * * * *", prompt: "e2e cron", durable: true }, usage)
  }

  if (served === 3) {
    served = 4
    return toolCallResponse(stream, "update_goal", { status: "complete" }, usage)
  }

  served = 5
  toolResultText = messages
    .filter((message) => message?.role === "tool")
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
    .join("\n")

  if (stream) {
    const chunk = chunker()
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

/** 收集服务端输出，插件加载失败时用来定位。 */
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

await api("POST", `/api/session/${sessionID}/prompt`, { text: "create a goal then read it back" })
await api("POST", `/api/experimental/session/${sessionID}/wait`)

const pluginHex = Array.from("my-opencode-toolkit")
  .map((char) => (char.codePointAt(0) ?? 0).toString(16).padStart(4, "0"))
  .join("")
const db = new Database(join(root, "opencode.db"), { readonly: true })
const readValue = (suffix) => {
  const row = db.query("select value from kv where key = ?").get(`plugin:${pluginHex}:${suffix}`)
  return typeof row?.value === "string" ? JSON.parse(row.value) : undefined
}
const settings = readValue("settings")
const goal = readValue(`goal:${sessionID}`)
const schedule = readValue(`schedule:${sessionID}`)
db.close()

if (!toolNames.includes("create_goal")) {
  await Bun.write(join(root, "stdout.log"), stdoutText)
  await Bun.write(join(root, "stderr.log"), stderrText)
  console.log("logs saved to:", root)
}

assert.equal(served, 5, "provider must serve five requests (create goal, read goal, cron, complete goal, finish)")
for (const name of [
  "create_goal",
  "get_goal",
  "update_goal",
  "cron_create",
  "cron_list",
  "cron_delete",
  "schedule_wakeup",
]) {
  assert.ok(toolNames.includes(name), `tool table must include ${name}, got ${toolNames.join(",")}`)
}
assert.ok(toolResultText.includes(GOAL_OBJECTIVE), `goal result missing objective, got ${toolResultText}`)
assert.ok(toolResultText.includes('"status": "active"'), `goal result missing active status, got ${toolResultText}`)
assert.equal(settings?.lang, "auto", "default settings must be written to storage")
assert.equal(goal?.objective, GOAL_OBJECTIVE, "goal must be persisted under the session key")
assert.equal(goal?.status, "complete", "goal must be completed before idle so no continuation follows")
assert.equal(schedule?.jobs?.length, 1, "durable cron job must be persisted")
assert.equal(schedule?.jobs?.[0]?.cron, "*/5 * * * *", "cron expression must round-trip")

console.log("tools:", toolNames.length, "goal tools:", toolNames.filter((name) => name.endsWith("_goal")).join(","))
console.log("goal:", JSON.stringify(goal))
console.log("schedule:", JSON.stringify(schedule))
console.log("case passed: plugin loads, tools execute, goal and cron persist")

server.kill()
await rm(root, { recursive: true, force: true }).catch(() => undefined)
process.exit(0)
