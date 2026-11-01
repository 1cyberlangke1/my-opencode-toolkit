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
/** 捕获所有发给假大模型的真实 HTTP 请求体，用于严格验证模型是否真切感知到了时间。 */
const capturedRequests = []

/**
 * 输入：OpenAI chat 请求体。
 * 输出：流式响应。
 * 预期：每轮都回纯文本；time 的注入请求只是多一轮对话，不需要特殊处理。
 */
function handle(body) {
  const stream = body?.stream === true
  const usage = { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 }
  served += 1
  capturedRequests.push(body)
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

const opencode = process.env.OPENCODE_BIN ?? (process.platform === "win32" ? "opencode.cmd" : "opencode")
// Windows 的 opencode 是 .cmd，必须经 cmd.exe 启动；其它平台直接 exec。
const server = Bun.spawn(
  process.platform === "win32"
    ? ["cmd.exe", "/d", "/s", "/c", `${opencode} serve --stdio --port 0 --print-logs`]
    : [opencode, "serve", "--stdio", "--port", "0", "--print-logs"],
  {
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

  // 6 条 user 消息验证间隔 2 步触发：
  // 规则：注入的那一轮本身不计入下一次步数。
  // - msg 1: step 1 结束 (count=1)
  // - msg 2: step 2 结束 (count=2)
  // - msg 3: 触发注入 Pulse 1！step 3 本身不计数 (count=0)
  // - msg 4: step 4 结束 (count=1)
  // - msg 5: step 5 结束 (count=2)
  // - msg 6: 触发注入 Pulse 2！
  for (let i = 1; i <= 6; i++) {
    await api("POST", `/api/session/${sessionID}/prompt`, { text: `message ${i}` })
    await api("POST", `/api/experimental/session/${sessionID}/wait`)
  }
  await Bun.sleep(500)

  const db = new Database(join(root, "opencode.db"), { readonly: true })
  const rows = db
    .query("select data from session_message where session_id = ? and type = 'synthetic' order by seq")
    .all(sessionID)
  db.close()

  const synthetics = rows.map((row) => JSON.parse(String(row.data)))
  const pulses = synthetics.filter((message) => message?.metadata?.timePulse === true)
  assert.equal(pulses.length, 2, `expected exactly 2 time pulses in DB, got ${pulses.length}`)
  for (const pulse of pulses) {
    assert.equal(pulse.text, `${pulse.description}\n`, "time pulse text must end with newline and match description")
    // 时间串带方括号外壳：[YYYY-MM-DD HH:mm:ss]，与 [context-reminder] 同风格的元数据锚点。
    assert.match(pulse.description, /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]$/, `unexpected time description: ${pulse.description}`)
  }

  // 核心功能性断言：严格验证模型发出的每一次真实 HTTP 请求中，是否真切接收到了时间感知！
  assert.equal(capturedRequests.length, 6, `expected exactly 6 LLM requests, got ${capturedRequests.length}`)

  /** 提取一个请求体中所有的文本内容 */
  const requestText = (req) => {
    const messages = Array.isArray(req?.messages) ? req.messages : []
    return messages
      .map((m) => {
        if (typeof m.content === "string") return m.content
        if (Array.isArray(m.content)) return m.content.map((p) => p.text ?? "").join("\n")
        return ""
      })
      .join("\n")
  }

  // 时间戳带方括号外壳，正则同样要求外壳，确保注入格式与 [context-reminder] 元数据风格一致。
  const timeRegex = /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/g

  // 第 1 轮与第 2 轮请求：尚未达到 intervalSteps=2，模型上下文绝对不得包含时间戳
  assert.equal(requestText(capturedRequests[0]).match(timeRegex), null, "request 1 must not contain time pulse")
  assert.equal(requestText(capturedRequests[1]).match(timeRegex), null, "request 2 must not contain time pulse")

  // 第 3 轮请求：达到步数，轮次触发！模型上下文必须真真切切接收到了第 1 个时间戳
  const req3Matches = requestText(capturedRequests[2]).match(timeRegex)
  assert.ok(req3Matches && req3Matches.length === 1, `request 3 must contain exactly 1 time pulse, got ${req3Matches?.length}`)
  assert.equal(req3Matches[0], pulses[0].description, "request 3 must contain the exact time pulse string")
  assert.ok(requestText(capturedRequests[2]).includes(`${pulses[0].description}\n`), "time pulse must be followed by newline")

  // 第 4 轮与第 5 轮请求：包含历史里的第 1 个时间戳，但不得注入新的时间戳
  assert.equal(requestText(capturedRequests[3]).match(timeRegex)?.length, 1, "request 4 must only contain pulse 1")
  assert.equal(requestText(capturedRequests[4]).match(timeRegex)?.length, 1, "request 5 must only contain pulse 1")

  // 第 6 轮请求：第二次达到步数，模型上下文必须接收到了第 2 个新鲜时间戳！
  const req6Matches = requestText(capturedRequests[5]).match(timeRegex)
  assert.ok(req6Matches && req6Matches.length === 2, `request 6 must contain 2 time pulses, got ${req6Matches?.length}`)
  assert.equal(req6Matches[1], pulses[1].description, "request 6 must contain pulse 2 string")
  assert.ok(requestText(capturedRequests[5]).includes(`${pulses[1].description}\n`), "pulse 2 must be followed by newline")

  console.log("served:", served)
  console.log("time pulses:", pulses.length)
  console.log("case passed: LLM requests received exact time pulses at correct turns with zero ghost calls")
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
