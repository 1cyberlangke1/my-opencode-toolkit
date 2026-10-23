import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { CONFIG_FILE } from "../src/shared/config-paths.ts"
import { loadSettings, saveSettings } from "../src/shared/settings-store.ts"
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from "../src/shared/settings.ts"

/** 输入：初始值；输出：临时项目目录 + `.opencode` 配置文件。 */
function fixture(settings?: Settings): {
  readonly ctx: { location: { directory: string } }
  readonly path: string
} {
  const directory = mkdtempSync(join(tmpdir(), "toolkit-settings-"))
  const opencode = join(directory, ".opencode")
  mkdirSync(opencode, { recursive: true })
  const path = join(opencode, CONFIG_FILE)
  if (settings !== undefined) writeFileSync(path, JSON.stringify(settings), "utf8")
  return { ctx: { location: { directory } }, path }
}

describe("loadSettings", () => {
  it("没有配置文件时返回默认值", async () => {
    const { ctx } = fixture()
    expect(await loadSettings(ctx)).toEqual(DEFAULT_SETTINGS)
  })

  it("读取 JSONC 并补齐缺字段", async () => {
    const { ctx, path } = fixture()
    writeFileSync(path, '{ "lang": "zh", "goal": { "enabled": false } }', "utf8")
    const got = await loadSettings(ctx)
    expect(got.lang).toBe("zh")
    expect(got.goal.enabled).toBe(false)
    expect(got.goal.showInSidebar).toBe(DEFAULT_SETTINGS.goal.showInSidebar)
  })
})

describe("saveSettings", () => {
  it("只写变化键，保留原有注释", async () => {
    const { ctx, path } = fixture()
    writeFileSync(path, '{\n  // keep\n  "lang": "zh"\n}\n', "utf8")
    await saveSettings(ctx, normalizeSettings({ ...DEFAULT_SETTINGS, lang: "en" }))
    const text = readFileSync(path, "utf8")
    expect(text).toContain("// keep")
    expect(text).toContain('"lang": "en"')
  })
})
