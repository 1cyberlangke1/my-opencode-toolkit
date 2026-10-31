#!/usr/bin/env bun
/**
 * 输入：无（需要本机 opencode 2.x 与 bun）。
 * 输出：在隔离的临时 HOME/DB/config 里启动 opencode，用假 provider 驱动多轮 step。
 * 预期：time.enabled 且每 intervalSteps=2 步注入一条合成时间消息；
 *       消息入库为 synthetic、description === text、metadata.timePulse === true；
 *       文本匹配 format 模板（纯时间串，无语言前缀）。
 *       只测 time，不创建 goal——功能测试互不干扰。
 *
 * 用法：bun scripts/e2e-time.mjs
 */

import { strict as assert } from "node:assert"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { Database } from "bun:sqlite"

const repo = process.cwd()
const root = await mkdtemp(join(tmpdir(), "opencode-e2e-time-"))
const configDir = join(root, "config")
const dataDir = join(root, "data")
for (const dir of [configDir, dataDir, join(root, "xdg-config"), join(root, "state"), join(root, "cache")]) {
  await mkdir(dir, { recursive: true })
}
// time 专属 seed：间隔 2 步注入一次；goal/scheduling 默认关闭，不干扰本用例。
await writeFile(
  join(configDir, "my-opencode-toolkit.json"),
  `${JSON.stringify({ time: { enabled: true, intervalSteps: 2 } }, null, 2)}\n`,
  "utf8",
)

const password = randomBytes(24).toString("base64url")
const basic = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`

/** 已服务的请求数。 */
let served = 0

/**
 * 输入：OpenAI chat 请求体。
 * 输出：流式响应。
 * 预期：每轮都回纯文本；time 的注入请求只是多一轮对话，不需要特殊处理。
 */
function handle(body) {
  const stream = body?.stream === true
  const usage = { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 }
  served += 1
  const text = `reply ${served}`
  if (stream) {
    const chunk = (data, finish, u) =>
      `data: ${JSON.stringify({ choices: [{ delta: data, finish_reason: finish ?? null }], ...(u ? { usage: u } : {}) })}\n\n`
    return new Response(
      `${chunk({ role: "assistant", content: text }, null)}${chunk({}, "stop", usage)}data: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" }, status: 200 },
    )
  }
  return Response.json({
    id: "chatcmpl-time",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "fake",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
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
      name: "Fake Time",
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
    title: "e2e-time",
    model: { providerID: "fake", id: "fake" },
  })
  const sessionID = created.id ?? created.sessionID
  assert.ok(sessionID, "session id missing")

  // 四条 user 消息：每条触发一轮 step；intervalSteps=2 → 第 2、4 步后各注入一次。
  // resume:false 不主动唤醒，注入发生在下一轮 step 边界，所以发下一条前留出注入窗口。
  for (let i = 1; i <= 4; i++) {
    await api("POST", `/api/session/${sessionID}/prompt`, { text: `message ${i}` })
    await api("POST", `/api/experimental/session/${sessionID}/wait`)
  }

  // 第 4 步后的注入发生在 wait 之后；再发一条把边界推过去。
  await api("POST", `/api/session/${sessionID}/prompt`, { text: "message 5" })
  await api("POST", `/api/experimental/session/${sessionID}/wait`)
  await Bun.sleep(500)

  const db = new Database(join(root, "opencode.db"), { readonly: true })
  const rows = db
    .query("select data from session_message where session_id = ? and type = 'synthetic' order by seq")
    .all(sessionID)
  db.close()

  const synthetics = rows.map((row) => JSON.parse(String(row.data)))
  const pulses = synthetics.filter((message) => message?.metadata?.timePulse === true)
  assert.ok(pulses.length >= 2, `expected at least 2 time pulses, got ${pulses.length}`)
  for (const pulse of pulses) {
    assert.equal(pulse.description, pulse.text, "time pulse description must equal text")
    // 纯时间串：YYYY-MM-DD HH:mm:ss 全数字与分隔符，无语言词。
    assert.match(pulse.text, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, `unexpected time text: ${pulse.text}`)
  }
  console.log("served:", served)
  console.log("time pulses:", pulses.length)
  console.log("case passed: time pulse injects every N steps")
} catch (error) {
  await Bun.write(join(root, "stdout.log"), stdoutText).catch(() => undefined)
  await Bun.write(join(root, "stderr.log"), stderrText).catch(() => undefined)
  console.log("logs saved to:", root)
  throw error
} finally {
  server.kill()
  fake.stop(true)
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
}
