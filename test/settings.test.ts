import { describe, expect, it } from "vitest"

import { DEFAULT_SETTINGS, normalizeSettings, applyEditorEnvironment } from "../src/shared/settings.ts"

describe("normalizeSettings", () => {
  it("无输入时返回默认设置", () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
  })

  it("非对象输入回退默认设置", () => {
    expect(normalizeSettings("oops")).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings([1, 2])).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS)
  })

  it("类型错误的字段逐个回退", () => {
    const got = normalizeSettings({
      lang: "fr",
      enabled: "yes",
      notification: { enabled: 1, onComplete: false },
      sidebar: { showTools: "no" },
    })

    expect(got.lang).toBe(DEFAULT_SETTINGS.lang)
    expect(got.enabled).toBe(DEFAULT_SETTINGS.enabled)
    expect(got.notification.enabled).toBe(DEFAULT_SETTINGS.notification.enabled)
    expect(got.notification.onComplete).toBe(false)
    expect(got.notification.onQuestion).toBe(DEFAULT_SETTINGS.notification.onQuestion)
    expect(got.sidebar.showTools).toBe(DEFAULT_SETTINGS.sidebar.showTools)
    expect(got.sidebar.showSubagents).toBe(DEFAULT_SETTINGS.sidebar.showSubagents)
    expect(DEFAULT_SETTINGS.sidebar.showSubagents).toBe(false)
  })

  it("time 设置支持 interval 与 steps 模式，下限分别为 30 秒和 1 步", () => {
    expect(DEFAULT_SETTINGS.time.mode).toBe("interval")
    expect(DEFAULT_SETTINGS.time.intervalSeconds).toBe(300)
    expect(DEFAULT_SETTINGS.time.intervalSteps).toBe(3)

    const got = normalizeSettings({
      time: {
        mode: "steps",
        intervalSeconds: 20, // 低于 30 秒应回退
        intervalSteps: 0, // 低于 1 步应回退
      },
    })
    expect(got.time.mode).toBe("steps")
    expect(got.time.intervalSeconds).toBe(300)
    expect(got.time.intervalSteps).toBe(3)

    const valid = normalizeSettings({
      time: {
        mode: "interval",
        intervalSeconds: 45,
        intervalSteps: 5,
      },
    })
    expect(valid.time.mode).toBe("interval")
    expect(valid.time.intervalSeconds).toBe(45)
    expect(valid.time.intervalSteps).toBe(5)
  })

  it("旧 sidebar.showCache 迁移到 contextStats.enabled", () => {
    expect(normalizeSettings({ sidebar: { showCache: false } }).contextStats.enabled).toBe(false)
    expect(normalizeSettings({ contextStats: { enabled: true } }).contextStats.enabled).toBe(true)
  })

  it("丢弃未知字段", () => {
    const got = normalizeSettings({ unknown: true, notification: { nope: 1 } })
    expect(Object.keys(got).sort()).toEqual(
      ["contextStats", "editor", "enabled", "goal", "lang", "notification", "scheduling", "sidebar", "time"].sort(),
    )
    expect(Object.keys(got.notification).sort()).toEqual(
      ["enabled", "onComplete", "onPermission", "onQuestion", "onlyMainSession"].sort(),
    )
  })

  it("接受合法枚举", () => {
    expect(normalizeSettings({ lang: "zh" }).lang).toBe("zh")
    expect(normalizeSettings({ lang: "en" }).lang).toBe("en")
    expect(normalizeSettings({ lang: "auto" }).lang).toBe("auto")
  })

  it("goal/scheduling 的侧栏显示独立于功能开关", () => {
    const got = normalizeSettings({
      goal: { enabled: true, showInSidebar: false },
      scheduling: { enabled: false, showInSidebar: true },
    })
    expect(got.goal).toEqual({ enabled: true, showInSidebar: false })
    expect(got.scheduling).toEqual({ enabled: false, showInSidebar: true })
    expect(normalizeSettings({}).goal.showInSidebar).toBe(true)
    expect(normalizeSettings({}).scheduling.showInSidebar).toBe(true)
  })

  it("editor 外部编辑器在 Windows 下默认启用且命令为 notepad，非 Windows 默认禁用", () => {
    const isWin = process.platform === "win32"
    expect(DEFAULT_SETTINGS.editor.enabled).toBe(isWin)
    expect(DEFAULT_SETTINGS.editor.showHint).toBe(true)
    expect(DEFAULT_SETTINGS.editor.command).toBe(isWin ? "notepad" : "")

    const got = normalizeSettings({
      editor: {
        enabled: false,
        command: "code --wait",
        showHint: false,
      },
    })
    expect(got.editor.enabled).toBe(false)
    expect(got.editor.command).toBe("code --wait")
    expect(got.editor.showHint).toBe(false)
  })

  it("applyEditorEnvironment 仅在启用且命令非空时注入 EDITOR 与 VISUAL", () => {
    const originalEditor = process.env["EDITOR"]
    const originalVisual = process.env["VISUAL"]

    try {
      delete process.env["EDITOR"]
      delete process.env["VISUAL"]

      // 禁用时不注入
      applyEditorEnvironment({ enabled: false, command: "notepad", showHint: true })
      expect(process.env["EDITOR"]).toBeUndefined()
      expect(process.env["VISUAL"]).toBeUndefined()

      // 命令为空时不注入
      applyEditorEnvironment({ enabled: true, command: "  ", showHint: true })
      expect(process.env["EDITOR"]).toBeUndefined()
      expect(process.env["VISUAL"]).toBeUndefined()

      // 启用且命令有效时注入
      applyEditorEnvironment({ enabled: true, command: "notepad", showHint: true })
      expect(process.env["EDITOR"]).toBe("notepad")
      expect(process.env["VISUAL"]).toBe("notepad")

      // 再次修改时更新
      applyEditorEnvironment({ enabled: true, command: "code --wait", showHint: false })
      expect(process.env["EDITOR"]).toBe("code --wait")
      expect(process.env["VISUAL"]).toBe("code --wait")
    } finally {
      if (originalEditor !== undefined) process.env["EDITOR"] = originalEditor
      else delete process.env["EDITOR"]
      if (originalVisual !== undefined) process.env["VISUAL"] = originalVisual
      else delete process.env["VISUAL"]
    }
  })
})

