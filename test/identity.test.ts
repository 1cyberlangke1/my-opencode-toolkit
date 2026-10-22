import { describe, expect, it } from "vitest"

import {
  PLUGIN_ID,
  RPC_ID,
  SETTINGS_COMMAND_ID,
  SETTINGS_SLASH_NAME,
  TUI_PLUGIN_ID,
} from "../src/shared/identity.ts"

describe("plugin identity", () => {
  it("所有运行时 id 都由 PLUGIN_ID 派生", () => {
    // 故意锁死 PLUGIN_ID：它决定 OpenCode 的插件存储命名空间。
    // 改这个值必须同时做存储迁移，否则已有 settings/goal/schedule 会读不到。
    expect(PLUGIN_ID).toBe("my-opencode-toolkit")
    expect(TUI_PLUGIN_ID).toBe(`${PLUGIN_ID}.tui`)
    expect(RPC_ID).toBe(PLUGIN_ID)
    expect(SETTINGS_COMMAND_ID).toBe(`${PLUGIN_ID}.settings`)
    expect(SETTINGS_SLASH_NAME).toBe(PLUGIN_ID)
  })
})
