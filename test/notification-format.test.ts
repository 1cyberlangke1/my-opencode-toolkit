import { describe, expect, it } from "vitest"

import {
  buildWindowsToastScript,
  escapeAppleScriptText,
  escapePowerShellSingleQuotedText,
  escapeXmlText,
} from "../src/notification/format.ts"

describe("notification formatting", () => {
  it("XML 转义五个保留字符", () => {
    expect(escapeXmlText(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;")
  })

  it("PowerShell 单引号双写", () => {
    expect(escapePowerShellSingleQuotedText("it's")).toBe("it''s")
  })

  it("AppleScript 转义反斜杠与双引号", () => {
    expect(escapeAppleScriptText('a\\b"c')).toBe('a\\\\b\\"c')
  })

  it("toast 脚本是一行且包含转义后的内容", () => {
    const script = buildWindowsToastScript("t'<", "m&")
    expect(script).not.toContain("\n")
    expect(script).toContain("t&apos;&lt;")
    expect(script).toContain("m&amp;")
    expect(script).toContain("ToastNotificationManager")
  })
})
