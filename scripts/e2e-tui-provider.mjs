#!/usr/bin/env bun
/**
 * 真实 TUI 交互测试：验证在输入框输入 `/provider` 回车后能弹出自定义提供商菜单。
 */

import { strict as assert } from "node:assert"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resolveMessages } from "../src/i18n/index.ts"

const copies = [resolveMessages("zh"), resolveMessages("en")]
const shows = (text, pick) => copies.some((copy) => text.includes(pick(copy)))

const repo = process.cwd()
const root = await mkdtemp(join(tmpdir(), "opencode-e2e-tui-provider-"))
for (const dir of ["config", "data", "state", "cache", "xdg-config"]) {
  await mkdir(join(root, dir), { recursive: true })
}

const config = {
  plugins: [process.env.E2E_PLUGIN ?? repo],
  provider: {
    fake: {
      name: "Fake TUI",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "http://127.0.0.1:9/v1", apiKey: "test" },
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

const env = {
  ...process.env,
  HOME: root,
  USERPROFILE: root,
  OPENCODE_CONFIG_DIR: join(root, "config"),
  OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
  OPENCODE_DB: join(root, "opencode.db"),
  OPENCODE_DISABLE_FILEWATCHER: "true",
  OPENCODE_DISABLE_MODELS_FETCH: "true",
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_CONFIG_HOME: join(root, "xdg-config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"),
  TERM: "xterm-256color",
}

const chunks = []
const bin = process.env.OPENCODE_BIN ?? "opencode"
const command =
  process.platform === "win32"
    ? ["cmd.exe", "/d", "/s", "/c", `${bin} --standalone`]
    : [bin, "--standalone"]

const proc = Bun.spawn(command, {
  terminal: {
    cols: 120,
    rows: 40,
    data(_terminal, data) {
      chunks.push(new TextDecoder().decode(data))
    },
  },
  env,
  cwd: repo,
})

function stripAnsi(text) {
  return text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "")
}

const plain = () => stripAnsi(chunks.join(""))

async function waitFor(predicate, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate(plain())) return true
    await Bun.sleep(250)
  }
  return false
}

async function cleanup() {
  try {
    if (process.platform === "win32") {
      Bun.spawnSync(["taskkill", "/PID", String(proc.pid), "/T", "/F"], {
        stdout: "ignore",
        stderr: "ignore",
      })
    } else {
      proc.kill()
    }
  } catch {}
  await Bun.sleep(800)
  try {
    proc.terminal?.close()
  } catch {}
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true })
      return
    } catch {
      await Bun.sleep(500)
    }
  }
}

try {
  const ready = await waitFor((text) => text.includes("OpenCode") || text.includes("opencode"), 20_000)
  if (!ready) {
    console.log("=== screen tail ===")
    console.log(plain().slice(-3000))
    throw new Error("TUI did not render in 20s")
  }

  // 模拟用户在输入框打字直接连按回车（不等待任何补全弹出）
  proc.terminal?.write("/provider\r")

  const opened = await waitFor(
    (text) => shows(text, (copy) => copy.provider.menuTitle),
    12_000,
  )

  if (!opened) {
    console.log("=== screen tail when typing /provider ===")
    console.log(plain().slice(-3000))
    throw new Error("provider menu did not open upon /provider")
  }

  console.log("case passed: real TUI opens provider menu upon /provider")

  // 等待菜单组件完全挂载并获得焦点
  await Bun.sleep(600)
  // 按回车选中第一项「➕ 添加新提供商...」
  proc.terminal?.write("\r")
  const prompted = await waitFor(
    (text) => shows(text, (copy) => copy.provider.promptBaseUrl),
    8_000,
  )
  if (!prompted) {
    console.log("=== screen tail when pressing Enter on Add ===")
    console.log(plain().slice(-3000))
    throw new Error("Add wizard prompt did not open")
  }

  // 按 Esc 退出
  proc.terminal?.write("\u001b")
  await Bun.sleep(300)
  console.log("case passed: Add wizard opened and Esc cleanly returned")
} finally {
  await cleanup()
}
