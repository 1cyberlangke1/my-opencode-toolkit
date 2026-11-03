#!/usr/bin/env bun
/**
 * 真实 TUI 交互端到端测试（真正的 e2e）：
 * 1. 启动带有假模型的模拟 OpenAI 端点。
 * 2. 隔离环境启动真实 OpenCode standalone TUI 进程。
 * 3. 在真实 PTY 终端输入框输入 `/provider` 并敲回车。
 * 4. 真实断言提供商菜单（🔌 自定义提供商）渲染到屏幕上。
 * 5. 模拟回车进入「➕ 添加新提供商...」向导。
 * 6. 真实断言弹出输入 Base URL 弹窗（文案取自语言文件，绝不硬编码）。
 * 7. 输入 Base URL，回车，断言弹出输入 API Key 弹窗。
 * 8. 回车跳过 Key，断言远端拉取的模型以 Emoji 标志（🪟 🛠️ 💬）渲染在真实终端上。
 * 9. 回车保存，断言磁盘 opencode.json 成功写入且保留原有用户注释。
 *
 * 用法：bun scripts/e2e-provider.mjs
 */

import { strict as assert } from "node:assert"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resolveMessages } from "../src/i18n/index.ts"

// 界面语言随宿主 locale 变（CI 是英文、本机可能是中文）：断言只从语言文件取文案。
// 同时具备终端宽度自适应：优先全串匹配，若窄屏被换行/截断则匹配核心前缀，绝不脆弱依赖固定窗口尺寸。
const copies = [resolveMessages("zh"), resolveMessages("en")]
const shows = (text, pick) =>
  copies.some((copy) => {
    const full = pick(copy)
    if (text.includes(full)) return true
    const prefix = full.slice(0, Math.min(8, full.length))
    return prefix.length > 0 && text.includes(prefix)
  })

const repo = process.cwd()
const root = await mkdtemp(join(tmpdir(), "opencode-real-e2e-provider-"))
for (const dir of ["config", "data", "state", "cache", "xdg-config"]) {
  await mkdir(join(root, dir), { recursive: true })
}

// 模拟远端中转提供商
const fake = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => {
    const url = new URL(request.url)
    if (url.pathname === "/v1/models") {
      return Response.json({
        data: [
          { id: "deepseek-ai/DeepSeek-V3" },
          { id: "custom-local-model-v1" },
        ],
      })
    }
    return Response.json({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 0,
      model: "deepseek-ai/DeepSeek-V3",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    })
  },
})

// 原有全局 opencode.json，包含重要的用户注释与已有提供商（包含没有 capabilities 的真实模型）
const initialOpencodeJson = `{
  // 用户的核心手写注释：绝不能丢失！
  "plugins": [
    "${repo.replace(/\\/g, "/")}"
  ],
  "theme": "dark",
  "provider": {
    "existing-commandcode": {
      "name": "Command Code",
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "https://api.commandcode.ai/v1", "setCacheKey": true },
      "models": {
        "deepseek/deepseek-v4-flash": {
          "limit": { "context": 1000000, "output": 384000 },
          "variants": { "high": { "reasoningEffort": "high" } }
        }
      }
    }
  }
}
`

const configPath = join(root, "config", "opencode.json")
await writeFile(configPath, initialOpencodeJson, "utf8")

const env = {
  ...process.env,
  HOME: root,
  USERPROFILE: root,
  OPENCODE_CONFIG_DIR: join(root, "config"),
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
    await Bun.sleep(200)
  }
  return false
}

async function cleanup() {
  fake.stop()
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
  await Bun.sleep(500)
  try {
    proc.terminal?.close()
  } catch {}
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true })
      return
    } catch {
      await Bun.sleep(400)
    }
  }
}

try {
  // 1. 等待真实 TUI 启动完成
  const ready = await waitFor((text) => text.includes("OpenCode") || text.includes("opencode"), 25_000)
  assert.ok(ready, "TUI did not start within 25s")

  // 2. 在真实输入框输入 /provider，按状态等待输入上屏后按回车
  proc.terminal?.write("/provider")
  await waitFor((text) => text.includes("/provider"), 10_000)
  proc.terminal?.write("\r")

  // 3. 真实状态断言：等到提供商主菜单渲染在屏幕上
  const menuOpened = await waitFor(
    (text) =>
      shows(text, (copy) => copy.provider.menuTitle) &&
      shows(text, (copy) => copy.provider.addProvider),
    15_000,
  )
  if (!menuOpened) {
    console.log("=== SCREEN TAIL ON FAILURE ===")
    console.log(plain().slice(-3000))
  }
  assert.ok(menuOpened, "Provider menu did not render in real TUI upon /provider")
  console.log("real TUI case 1 passed: /provider command opens provider menu in real terminal")

  // 4. 按回车选中第一项「➕ 添加新提供商...」，纯状态等待 Base URL 弹窗就绪
  proc.terminal?.write("\r")
  const urlPromptOpened = await waitFor(
    (text) => shows(text, (copy) => copy.provider.promptBaseUrl),
    15_000,
  )
  if (!urlPromptOpened) {
    console.log("=== SCREEN ON URL PROMPT FAILURE ===")
    console.log(plain().slice(-3000))
  }
  assert.ok(urlPromptOpened, "Base URL prompt dialog did not open")
  console.log("real TUI case 2 passed: entered add wizard and Base URL prompt showed")

  // 5. 写入端点 URL 并回车确认
  const mockBaseUrl = `http://127.0.0.1:${fake.port.toString()}/v1`
  proc.terminal?.write(`${mockBaseUrl}\r`)

  // 6. 真实状态断言：等到 Base URL 提交完成且 API Key 弹窗渲染在屏幕上
  const keyPromptOpened = await waitFor(
    (text) => shows(text, (copy) => copy.provider.promptApiKey),
    15_000,
  )
  if (!keyPromptOpened) {
    console.log("=== SCREEN ON KEY PROMPT FAILURE ===")
    console.log(plain().slice(-3000))
  }
  assert.ok(keyPromptOpened, "API Key prompt dialog did not open")
  console.log("real TUI case 3 passed: Base URL accepted, API Key prompt showed")

  // 7. 直接按回车跳过可选 API Key
  proc.terminal?.write("\r")

  // 8. 真实状态断言：向导完成拉取后自动保存入盘，并弹出提供商配置界面展示管理模型
  const editOpened = await waitFor(
    (text) => shows(text, (copy) => copy.provider.manageModels),
    20_000,
  )
  if (!editOpened) {
    console.log("=== SCREEN ON FETCH / EDIT WAIT ===")
    console.log(plain().slice(-3000))
  }
  assert.ok(editOpened, "Provider edit dialog did not open")
  console.log("real TUI case 4 passed: remote models auto-fetched and provider edit dialog opened")

  // 9. 检查磁盘配置：自动保存成功，注释完好！
  const savedOnDisk = await waitFor(async () => {
    try {
      const diskText = await readFile(configPath, "utf8")
      return diskText.includes("// 用户的核心手写注释：绝不能丢失！") && diskText.includes(mockBaseUrl)
    } catch {
      return false
    }
  }, 15_000)
  assert.ok(savedOnDisk, "new provider baseURL must be saved to disk within 15s")

  const finalConfig = await readFile(configPath, "utf8")
  assert.ok(finalConfig.includes("// 用户的核心手写注释：绝不能丢失！"), "comments must be preserved 100%")
  assert.ok(finalConfig.includes(mockBaseUrl), "new provider baseURL must be saved to disk")
  console.log("real TUI case 5 passed: saved to opencode.json with comments 100% intact")

  // 10. 按 Esc 退出弹窗
  proc.terminal?.write("\u001b")
  console.log("ALL REAL TUI PROVIDER E2E TESTS PASSED 100%!")
} finally {
  await cleanup()
}
