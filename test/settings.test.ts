import { describe, expect, it } from "vitest"

import { DEFAULT_SETTINGS, normalizeSettings, patchSettings } from "../src/shared/settings.ts"

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
      sidebar: { collapsed: "no" },
    })

    expect(got.lang).toBe(DEFAULT_SETTINGS.lang)
    expect(got.enabled).toBe(DEFAULT_SETTINGS.enabled)
    expect(got.notification.enabled).toBe(DEFAULT_SETTINGS.notification.enabled)
    expect(got.notification.onComplete).toBe(false)
    expect(got.notification.onQuestion).toBe(DEFAULT_SETTINGS.notification.onQuestion)
    expect(got.sidebar.collapsed).toBe(DEFAULT_SETTINGS.sidebar.collapsed)
  })

  it("丢弃未知字段", () => {
    const got = normalizeSettings({ unknown: true, notification: { nope: 1 } })
    expect(Object.keys(got).sort()).toEqual(
      ["enabled", "goal", "lang", "notification", "scheduling", "sidebar"].sort(),
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
})

describe("patchSettings", () => {
  it("顶层字段覆盖", () => {
    const got = patchSettings(DEFAULT_SETTINGS, { enabled: false, lang: "zh" })
    expect(got.enabled).toBe(false)
    expect(got.lang).toBe("zh")
  })

  it("子对象逐字段合并，不丢同级字段", () => {
    const got = patchSettings(DEFAULT_SETTINGS, { notification: { onComplete: false } })
    expect(got.notification.onComplete).toBe(false)
    expect(got.notification.enabled).toBe(DEFAULT_SETTINGS.notification.enabled)
    expect(got.notification.onQuestion).toBe(DEFAULT_SETTINGS.notification.onQuestion)
  })

  it("补丁不是对象时原样返回", () => {
    expect(patchSettings(DEFAULT_SETTINGS, undefined)).toBe(DEFAULT_SETTINGS)
    expect(patchSettings(DEFAULT_SETTINGS, 42)).toBe(DEFAULT_SETTINGS)
  })

  it("不修改传入的当前设置", () => {
    const before = structuredClone(DEFAULT_SETTINGS)
    patchSettings(DEFAULT_SETTINGS, { sidebar: { collapsed: true } })
    expect(DEFAULT_SETTINGS).toEqual(before)
  })
})
