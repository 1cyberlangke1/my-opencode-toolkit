import { describe, expect, it } from "vitest"

import { detectLocale, resolveMessages } from "../src/i18n/index.ts"
import { en } from "../src/i18n/en.ts"
import { zh } from "../src/i18n/zh.ts"

describe("resolveMessages", () => {
  it("zh 前缀返回中文", () => {
    expect(resolveMessages("zh-CN")).toBe(zh)
    expect(resolveMessages("zh")).toBe(zh)
    expect(resolveMessages("ZH-TW")).toBe(zh)
  })

  it("其余语言返回英文", () => {
    expect(resolveMessages("en-US")).toBe(en)
    expect(resolveMessages("fr")).toBe(en)
  })

  it("空值回退系统 locale", () => {
    const got = resolveMessages(undefined)
    expect(got === zh || got === en).toBe(true)
  })
})

describe("detectLocale", () => {
  it("始终返回非空字符串", () => {
    const got = detectLocale()
    expect(typeof got).toBe("string")
    expect(got.length).toBeGreaterThan(0)
  })
})

describe("文案完整性", () => {
  it("命令描述包含可用语法", () => {
    for (const messages of [zh, en]) {
      expect(messages.command.goal).toContain("/goal")
      expect(messages.command.goal).toContain("resume")
      expect(messages.command.goal).toContain("clear")
      expect(messages.command.loop).toContain("/loop")
      expect(messages.command.cron).toContain("/cron")
      expect(messages.command.cron).toContain("delete")
    }
  })

  it("中英文案键一致", () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    expect(Object.keys(zh.command).sort()).toEqual(Object.keys(en.command).sort())
    expect(Object.keys(zh.menu).sort()).toEqual(Object.keys(en.menu).sort())
    expect(Object.keys(zh.sidebar).sort()).toEqual(Object.keys(en.sidebar).sort())
    expect(Object.keys(zh.toast).sort()).toEqual(Object.keys(en.toast).sort())
  })
})
