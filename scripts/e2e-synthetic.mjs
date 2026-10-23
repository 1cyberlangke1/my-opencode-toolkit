#!/usr/bin/env bun
/**
 * 输入：无（需要本机 opencode 2.x 与 bun）。
 * 输出：在隔离的临时 HOME/DB/config 里启动 opencode，用假 provider 创建 goal。
 * 预期：goal 创建后的第一次 idle 会注入 synthetic 续作并主动发起新一轮模型请求；
 *       synthetic 消息的 description 与 text 完全一致；模型完成后不再重复注入。
 *
 * 用法：bun scripts/e2e-synthetic.mjs
 */

import { strict as assert } from "node:assert"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { Database } from "bun:sqlite"

const GOAL_OBJECTIVE = "finish the synthetic e2e goal"
const CONTINUATION_MARK = "Continue working toward the active thread goal."

const repo = process.cwd()
const root = await mkdtemp(join(tmpdir(), "opencode-e2e-synthetic-"))
const configDir = join(root, "config")
const dataDir = join(root, "data")
for (const dir of [configDir, dataDir, join(root, "xdg-config"), join(root, "state"), join(root, "cache")]) {
  await mkdir(dir, { recursive: true })
}

const password = randomBytes(24).toString("base64url")
const basic = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`

/** 已服务的请求数：0 创建 goal，1 结束首轮，2 续作，3 收尾。 */
let served = 0
/** 续作请求里看到的用户文本。 */
let continuationText = ""
/** 续作之后是否又出现了请求（用来确认没有死循环）。 */
let extraRequests = 0

/** 输入：无；输出：SSE 分片构造器。 */
function chunker() {
  return (delta, finish, usage) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-synthetic",
      object: "chat.completion.chunk",
      created: 0,
      model: "fake",
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage === undefined ? {} : { usage }),
    })}\n\n`
}

/** 输入：流式标记 + 工具名 + 参数；输出：一次工具调用响应。 */
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
    id: "chatcmpl-synthetic",
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
            { id: `call_${String(served)}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage,
  })
}

/** 输入：流式标记 + 文本；输出：普通文本响应。 */
function textResponse(stream, text, usage) {
  if (stream) {
    const chunk = chunker()
    return new Response(
      `${chunk({ role: "assistant", content: text }, null)}${chunk({}, "stop", usage)}data: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" }, status: 200 },
    )
  }
  return Response.json({
    id: "chatcmpl-synthetic",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "fake",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage,
  })
}

/** 输入：一条 chat message；输出：它的文本内容。 */
function messageText(message) {
  const content = message?.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .filter((text) => text.length > 0)
      .join("\n")
  }
  return ""
}

/** 输入：请求 messages + 标记；输出：包含标记的用户文本。 */
function findUserText(messages, mark) {
  return messages
    .filter((message) => message?.role === "user")
    .map(messageText)
    .find((text) => text.includes(mark)) ?? ""
}

/**
 * 输入：OpenAI chat 请求体。
 * 输出：流式响应。
 * 预期：首轮创建 goal；idle 后续作请求应带 synthetic 文案并调用 update_goal 收尾。
 */
function handle(body) {
  const stream = body?.stream === true
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const usage = { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 }

  if (served === 0) {
    served = 1
    return toolCallResponse(stream, "create_goal", { objective: GOAL_OBJECTIVE }, usage)
  }

  if (served === 1) {
    served = 2
    return textResponse(stream, "goal created", usage)
  }

  if (served === 2) {
    served = 3
    continuationText = findUserText(messages, CONTINUATION_MARK)
    assert.ok(continuationText.length > 0, "goal continuation was not sent to the model")
    assert.ok(continuationText.includes(GOAL_OBJECTIVE), "continuation must include the goal objective")
    return toolCallResponse(stream, "update_goal", { status: "complete" }, usage)
  }

  if (served === 3) {
    served = 4
    return textResponse(stream, "done", usage)
  }

  extraRequests += 1
  return textResponse(stream, "unexpected extra request", usage)
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
  plugins: [
    process.env.E2E_PLUGIN ?? repo,
    ...(process.env.E2E_EXTRA_PLUGIN === undefined ? [] : [process.env.E2E_EXTRA_PLUGIN]),
  ],
  provider: {
    fake: {
      name: "Fake Synthetic",
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

let stdoutText = ""
let stderrText = ""

/** 输入：判定函数 + 超时；输出：无。预期：条件成立或超时抛错。 */
async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`)
    await Bun.sleep(50)
  }
}

try {
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

  void (async () => {
    for (;;) {
      const { value, done } = await stdoutReader.read()
      if (done) return
      stdoutText += stdoutDecoder.decode(value)
    }
  })()

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
    title: "e2e-synthetic",
    model: { providerID: "fake", id: "fake" },
  })
  const sessionID = created.id ?? created.sessionID
  assert.ok(sessionID, "session id missing")

  await api("POST", `/api/session/${sessionID}/prompt`, { text: "create a goal" })
  await api("POST", `/api/experimental/session/${sessionID}/wait`)

  await waitFor(() => continuationText.length > 0, 15_000, "goal continuation request")
  await waitFor(() => served >= 4, 15_000, "goal completion follow-up")
  await api("POST", `/api/experimental/session/${sessionID}/wait`)
  await Bun.sleep(500)

  const db = new Database(join(root, "opencode.db"), { readonly: true })
  const rows = db
    .query("select data from session_message where session_id = ? and type = 'synthetic' order by seq")
    .all(sessionID)
  const pluginHex = Array.from("my-opencode-toolkit")
    .map((char) => (char.codePointAt(0) ?? 0).toString(16).padStart(4, "0"))
    .join("")
  const goalRow = db.query("select value from kv where key = ?").get(`plugin:${pluginHex}:goal:${sessionID}`)
  const goal = typeof goalRow?.value === "string" ? JSON.parse(goalRow.value) : undefined
  db.close()

  const synthetic = rows.map((row) => JSON.parse(String(row.data)))

  if (served < 4 || extraRequests > 0) {
    await Bun.write(join(root, "stdout.log"), stdoutText)
    await Bun.write(join(root, "stderr.log"), stderrText)
    console.log("logs saved to:", root)
  }

  assert.equal(served, 4, "goal continuation must trigger exactly the expected follow-up requests")
  assert.equal(extraRequests, 0, "completed goal must not keep injecting")
  assert.ok(continuationText.includes(CONTINUATION_MARK), "continuation text missing marker")
  assert.equal(synthetic.length, 1, `expected one synthetic message, got ${String(synthetic.length)}`)
  assert.equal(synthetic[0]?.description, synthetic[0]?.text, "notice description must equal model text")
  assert.ok(String(synthetic[0]?.text).includes(CONTINUATION_MARK), "stored synthetic text missing continuation")
  assert.equal(goal?.status, "complete", "goal must be complete after update_goal")

  console.log("continuation:", continuationText.split("\n")[0])
  console.log("synthetic description == text:", synthetic[0]?.description === synthetic[0]?.text)
  console.log("goal status:", goal?.status)
  console.log("case passed: synthetic auto prompt triggers a real follow-up turn")
} catch (error) {
  await Bun.write(join(root, "stdout.log"), stdoutText).catch(() => undefined)
  await Bun.write(join(root, "stderr.log"), stderrText).catch(() => undefined)
  console.log("logs saved to:", root)
  console.log("served:", served, "extra:", extraRequests)
  console.log("continuation:", JSON.stringify(continuationText))
  throw error
} finally {
  server.kill()
  if (process.env.KEEP_E2E !== "1") await rm(root, { recursive: true, force: true }).catch(() => undefined)
}
process.exit(0)
