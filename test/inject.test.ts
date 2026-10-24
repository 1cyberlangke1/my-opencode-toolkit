import { describe, expect, it } from "vitest"
import type { Plugin } from "@opencode/plugin"

import type { SessionRoles } from "../src/goal/session-role.ts"
import { createSyntheticInjector } from "../src/scheduling/inject.ts"

/** 输入：无；输出：永远不是子代理的角色查询。 */
function roles(isSubagent = false): SessionRoles {
  return { isSubagent: () => Promise.resolve(isSubagent), forget: () => undefined }
}

/** 输入：synthetic 实现 + 会话消息；输出：最小插件上下文。 */
function ctxWith(input: {
  readonly synthetic: (payload: {
    text: string
    description: string
    metadata: Record<string, unknown>
    id?: string
  }) => Promise<void>
  readonly messages?: readonly { readonly type: string; readonly metadata?: Record<string, unknown> }[]
}): Plugin.Context {
  return {
    session: {
      synthetic: input.synthetic,
      context: () => Promise.resolve(input.messages ?? []),
    },
  } as unknown as Plugin.Context
}

describe("createSyntheticInjector", () => {
  it("注入成功后 description 与正文一致，并标记 pending", async () => {
    const calls: { text: string; description: string; metadata: Record<string, unknown> }[] = []
    const injector = createSyntheticInjector({
      ctx: ctxWith({
        synthetic: (payload) => {
          calls.push(payload)
          return Promise.resolve()
        },
      }),
      roles: roles(),
      marker: "cronContinuation",
    })

    expect(await injector.inject("ses_a", "go on")).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.description).toBe("go on")
    expect(calls[0]?.metadata["cronContinuation"]).toBe(true)
    expect(injector.pending.has("ses_a")).toBe(true)
    expect(injector.inFlight.size).toBe(0)
  })

  it("pending 期间再次注入直接跳过", async () => {
    let calls = 0
    const injector = createSyntheticInjector({
      ctx: ctxWith({
        synthetic: () => {
          calls += 1
          return Promise.resolve()
        },
      }),
      roles: roles(),
      marker: "loopContinuation",
    })

    expect(await injector.inject("ses_a", "first")).toBe(true)
    expect(await injector.inject("ses_a", "second")).toBe(false)
    expect(calls).toBe(1)
  })

  it("抢不到跨实例声明时不调用 synthetic", async () => {
    let calls = 0
    const injector = createSyntheticInjector({
      ctx: ctxWith({
        synthetic: () => {
          calls += 1
          return Promise.resolve()
        },
      }),
      roles: roles(),
      marker: "cronContinuation",
      claim: () => false,
    })

    expect(await injector.inject("ses_a", "go on", "msg_1")).toBe(false)
    expect(calls).toBe(0)
    expect(injector.inFlight.size).toBe(0)
    expect(injector.pending.size).toBe(0)
  })

  it("synthetic 抛错时释放声明并允许重试", async () => {
    const released: string[] = []
    let attempts = 0
    const injector = createSyntheticInjector({
      ctx: ctxWith({
        synthetic: () => {
          attempts += 1
          return attempts === 1 ? Promise.reject(new Error("busy")) : Promise.resolve()
        },
      }),
      roles: roles(),
      marker: "cronContinuation",
      claim: () => true,
      release: (id) => {
        released.push(id)
      },
    })

    expect(await injector.inject("ses_a", "go on", "msg_1")).toBe(false)
    expect(released).toEqual(["msg_1"])
    expect(injector.pending.size).toBe(0)
    expect(injector.inFlight.size).toBe(0)

    expect(await injector.inject("ses_a", "go on", "msg_1")).toBe(true)
  })

  it("子代理会话不注入", async () => {
    let calls = 0
    const injector = createSyntheticInjector({
      ctx: ctxWith({
        synthetic: () => {
          calls += 1
          return Promise.resolve()
        },
      }),
      roles: roles(true),
      marker: "loopContinuation",
    })

    expect(await injector.inject("ses_child", "go on")).toBe(false)
    expect(calls).toBe(0)
  })

  it("末条是真实用户输入时不注入", async () => {
    let calls = 0
    const injector = createSyntheticInjector({
      ctx: ctxWith({
        synthetic: () => {
          calls += 1
          return Promise.resolve()
        },
        messages: [{ type: "user" }],
      }),
      roles: roles(),
      marker: "loopContinuation",
    })

    expect(await injector.inject("ses_a", "go on")).toBe(false)
    expect(calls).toBe(0)
  })
})
