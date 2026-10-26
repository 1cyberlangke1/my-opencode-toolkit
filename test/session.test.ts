import { describe, expect, it } from "vitest"
import type { Plugin } from "@opencode/plugin"

import { ownsSession } from "../src/shared/session.ts"

/** 输入：本实例目录/工作区 + session.get 实现；输出：最小插件上下文。 */
function ctxWith(directory: string, get: () => Promise<unknown>, workspaceID?: string): Plugin.Context {
  return {
    location: workspaceID === undefined ? { directory } : { directory, workspaceID },
    session: { get },
  } as unknown as Plugin.Context
}

describe("ownsSession", () => {
  it("会话在同一目录时返回 true", async () => {
    const ctx = ctxWith("/work", () => Promise.resolve({ location: { directory: "/work" } }))
    expect(await ownsSession(ctx, "ses_a")).toBe(true)
  })

  it("会话属于别的目录时返回 false", async () => {
    const ctx = ctxWith("/work", () => Promise.resolve({ location: { directory: "/other" } }))
    expect(await ownsSession(ctx, "ses_a")).toBe(false)
  })

  it("同目录不同 workspaceID 时返回 false", async () => {
    const ctx = ctxWith(
      "/work",
      () => Promise.resolve({ location: { directory: "/work", workspaceID: "ws_b" } }),
      "ws_a",
    )
    expect(await ownsSession(ctx, "ses_a")).toBe(false)
  })

  it("结构化 NotFound 返回 false", async () => {
    const notFound = Object.assign(new Error("session not found"), { _tag: "Session.NotFoundError" })
    const ctx = ctxWith("/work", () => Promise.reject(notFound))
    expect(await ownsSession(ctx, "ses_gone")).toBe(false)
  })

  it("瞬时错误按查询失败处理，也返回 false", async () => {
    const ctx = ctxWith("/work", () => Promise.reject(new Error("socket hang up")))
    expect(await ownsSession(ctx, "ses_a")).toBe(false)
  })
})
