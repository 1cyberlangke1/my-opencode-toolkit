#!/usr/bin/env node
/**
 * 输入：当前仓库。
 * 输出：发布包缺少必需文件时退出码 1，否则打印文件数与体积。
 * 预期：用 `npm pack --dry-run` 的真实文件清单校验，防止 `files`/`exports` 改动漏掉入口。
 */

import { execFileSync } from "node:child_process"

const REQUIRED = [
  "package.json",
  "README.md",
  "LICENSE",
  "index.ts",
  "tui.ts",
  "src/index.ts",
  "src/tui/main.tsx",
  // npm 安装后的 TUI 入口：预编译产物，缺了它插件加载会退回 react JSX。
  "dist/tui.js",
]

const npmArgs = ["pack", "--dry-run", "--json"]
// Windows 上 npm 是 .cmd，execFileSync 不能直接 spawn；交给 cmd.exe。
const raw =
  process.platform === "win32"
    ? execFileSync("cmd.exe", ["/d", "/s", "/c", `npm ${npmArgs.join(" ")}`], { encoding: "utf8" })
    : execFileSync("npm", npmArgs, { encoding: "utf8" })
const parsed = JSON.parse(raw)
const info = Array.isArray(parsed) ? parsed[0] : parsed
const files = new Set(info.files.map((file) => file.path))
const missing = REQUIRED.filter((file) => !files.has(file))

if (missing.length > 0) {
  console.error(`package is missing required files: ${missing.join(", ")}`)
  process.exit(1)
}

console.log(`package ok: ${String(info.files.length)} files, ${String(info.size)} bytes packed`)
