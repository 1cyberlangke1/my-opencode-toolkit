#!/usr/bin/env bun
/**
 * 输入：无（需要本机 opencode 2.x 与 bun）。
 * 输出：在隔离的临时 HOME/DB/config 里启动 opencode，用假 provider 捕获三个会话的工具表：
 *       主会话、子代理会话、关闭 goal/scheduling 后的主会话。
 * 预期：主会话有 goal/scheduling 工具；子代理和关闭功能后都没有。
 *       不会读写日常使用的 OpenCode 数据。
 *
 * 用法：bun scripts/e2e-tool-visibility.mjs
 */

import { strict as assert } from "node:assert"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"

const repo = process.cwd()
const root = await mkdtemp(join(tmpdir(), "opencode-e2e-tools-"))
for (const dir of ["config", "data", "state", "cache", "xdg-config"]) {
  await mkdir(join(root, dir), { recursive: true })
}
// 默认 goal 已关闭；用例第一段要验证「开启时父会话可见」，先显式打开，第二段再写回关闭。
await writeFile(
  join(root, "config", "my-opencode-toolkit.json"),
  `${JSON.stringify({ goal: { enabled: true }, scheduling: { enabled: true } }, null, 2)}\n`,
  "utf8",
)

const password = randomBytes(24).toString("base64url")
const basic = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
const requests = []

/** 输入：无；输出：SSE 分片构造器。 */
function chunker() {
  return (delta, finish, usage) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-tools",
      object: "chat.completion.chunk",
      created: 0,
      model: "fake",
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage === undefined ? {} : { usage }),
    })}\n\n`
}

/** 输入：请求体；输出：普通文本响应。 */
function reply(body) {
  const stream = body?.stream === true
  const usage = { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }
  if (stream) {
    const chunk = chunker()
    return new Response(
      `${chunk({ role: "assistant", content: "ok" }, null)}${chunk({}, "stop", usage)}data: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" }, status: 200 },
    )
  }
  return Response.json({
    id: "chatcmpl-tools",
    object: "chat.completion",
    created: 0,
    model: "fake",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
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
    const names = Array.isArray(body?.tools)
      ? body.tools.map((tool) => tool?.function?.name ?? tool?.name).filter((name) => typeof name === "string")
      : []
    requests.push({ names })
    return reply(body)
  },
})

const config = {
  compaction: { auto: false },
  plugins: [process.env.E2E_PLUGIN ?? repo],
  provider: {
    fake: {
      name: "Fake Tools",
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
  OPENCODE_CONFIG_DIR: join(root, "config"),
  OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  OPENCODE_DB: join(root, "opencode.db"),
  OPENCODE_DISABLE_FILEWATCHER: "true",
  OPENCODE_DISABLE_MODELS_FETCH: "true",
  OPENCODE_PASSWORD: password,
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_CONFIG_HOME: join(root, "xdg-config"),
  XDG_DATA_HOME: join(root, "data"),
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

let stdoutText = ""
void (async () => {
  for (;;) {
    const { value, done } = await stdoutReader.read()
    if (done) return
    stdoutText += stdoutDecoder.decode(value)
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

/** 输入：标题 + 可选 parentID；输出：新会话。 */
async function newSession(title, parentID) {
  const created = await api("POST", "/api/session", {
    title,
    model: { providerID: "fake", id: "fake" },
    ...(parentID === undefined ? {} : { parentID }),
  })
  const sessionID = created.id ?? created.sessionID
  assert.ok(sessionID, "session id missing")
  return sessionID
}

/** 输入：sessionID + 文本；输出：无；预期：等一次模型请求完成。 */
async function prompt(sessionID, text) {
  await api("POST", `/api/session/${sessionID}/prompt`, { text })
  await api("POST", `/api/experimental/session/${sessionID}/wait`)
}

/** 输入：无；输出：最后一次请求的工具名。 */
const lastTools = () => requests.at(-1)?.names ?? []

const goalTools = ["create_goal", "get_goal", "update_goal"]
const schedulingTools = ["cron_create", "cron_list", "cron_delete", "schedule_wakeup"]

try {
  const parent = await newSession("tool-visibility-parent")
  await prompt(parent, "hello")
  const parentTools = lastTools()
  for (const name of [...goalTools, ...schedulingTools]) {
    assert.ok(parentTools.includes(name), `parent must see ${name}, got ${parentTools.join(",")}`)
  }

  const child = await newSession("tool-visibility-child", parent)
  await prompt(child, "hello from child")
  const childTools = lastTools()
  for (const name of [...goalTools, ...schedulingTools]) {
    assert.ok(!childTools.includes(name), `subagent must not see ${name}, got ${childTools.join(",")}`)
  }

  // 关闭 goal/scheduling 后，新的主会话也应隐藏对应工具。
  // 插件设置只读自己的 JSONC；写 DB 的旧 seed 已失效。
  await writeFile(
    join(root, "config", "my-opencode-toolkit.json"),
    `${JSON.stringify({ goal: { enabled: false }, scheduling: { enabled: false } }, null, 2)}\n`,
    "utf8",
  )

  const disabled = await newSession("tool-visibility-disabled")
  await prompt(disabled, "hello disabled")
  const disabledTools = lastTools()
  for (const name of [...goalTools, ...schedulingTools]) {
    assert.ok(!disabledTools.includes(name), `disabled feature must not see ${name}, got ${disabledTools.join(",")}`)
  }

  console.log("parent tools:", parentTools.length, "child tools:", childTools.length, "disabled tools:", disabledTools.length)
  console.log("case passed: goal/scheduling tools are hidden in subagents and when disabled")
} catch (error) {
  await Bun.write(join(root, "stdout.log"), stdoutText)
  console.log("logs saved to:", root)
  process.exitCode = 1
  console.error(error)
} finally {
  fake.stop(true)
  if (process.platform === "win32") {
    Bun.spawnSync(["taskkill", "/PID", String(server.pid), "/T", "/F"], {
      stdout: "ignore",
      stderr: "ignore",
    })
  } else {
    server.kill()
  }
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
  process.exit(process.exitCode ?? 0)
}
