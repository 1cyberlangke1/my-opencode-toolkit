#!/usr/bin/env bun
/**
 * 输入：无（需要本机 opencode 2.x 与 bun）。
 * 输出：在隔离的临时 HOME/DB/config 里启动真实 TUI，输入 `/my-opencode-toolkit`，
 *       断言设置菜单渲染出来。
 * 预期：证明 TUI 插件真的被加载、keymap 斜杠命令可用、设置菜单可见。
 *       不会读写日常使用的 OpenCode 数据。
 *
 * 用法：bun scripts/e2e-tui.mjs
 */

import { strict as assert } from "node:assert"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const repo = process.cwd()
const root = await mkdtemp(join(tmpdir(), "opencode-e2e-tui-"))
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
// Windows 的 opencode 是 .cmd，必须经过 cmd.exe 才能作为 PTY 子进程启动。
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

/** 输入：原始终端输出；输出：去掉 ANSI 与回车的纯文本。 */
function stripAnsi(text) {
  return text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "")
}

/** 输入：无；输出：当前累积的纯文本。 */
const plain = () => stripAnsi(chunks.join(""))

/** 输入：判定函数 + 超时；输出：是否在超时前满足。 */
async function waitFor(predicate, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate(plain())) return true
    await Bun.sleep(250)
  }
  return false
}

/** 输入：无；输出：无。预期：先杀进程树，再关 PTY，最后清临时目录。 */
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
  } catch {
    // 进程可能已经退出
  }
  await Bun.sleep(800)
  try {
    proc.terminal?.close()
  } catch {
    // PTY 可能已经关闭
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true })
      return
    } catch {
      await Bun.sleep(500)
    }
  }
  console.log(`note: temp dir left behind: ${root}`)
}

try {
  const ready = await waitFor((text) => text.includes("OpenCode") || text.includes("opencode"), 20_000)
  if (!ready) {
    console.log("=== screen tail ===")
    console.log(plain().slice(-3000))
    throw new Error("TUI did not render in 20s")
  }

  proc.terminal?.write("/my-opencode-toolkit")
  await Bun.sleep(1_200)
  proc.terminal?.write("\r")

  const opened = await waitFor(
    (text) =>
      text.includes("my-opencode-toolkit") &&
      (text.includes("通知") || text.includes("Notifications")) &&
      (text.includes("侧栏") || text.includes("Sidebar")),
    12_000,
  )
  if (!opened) {
    console.log("=== screen tail ===")
    console.log(plain().slice(-3000))
    throw new Error("settings menu did not open")
  }

  const text = plain()
  assert.ok(text.includes("my-opencode-toolkit"), "slash command name")
  assert.ok(text.includes("设置") || text.includes("Settings"), "settings menu title")
  assert.ok(text.includes("通知") || text.includes("Notifications"), "notification menu item")
  assert.ok(text.includes("侧栏") || text.includes("Sidebar"), "sidebar menu item")

  console.log("case passed: real TUI loads plugin and opens settings menu")
} finally {
  await cleanup()
}
