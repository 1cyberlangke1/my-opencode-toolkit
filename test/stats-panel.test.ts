import type { Plugin } from "@opencode/plugin"
import { describe, expect, it, vi } from "vitest"

import plugin from "../src/index.ts"
import { statsKey } from "../src/shared/keys.ts"
import type { PanelData } from "../src/shared/rpc.ts"
import { loadStats, saveStats } from "../src/stats-store.ts"
import type { SessionStats } from "../src/stats.ts"
import { MemoryStore } from "./helpers.ts"

type SessionInfo = {
  readonly location: { readonly directory: string; readonly workspaceID?: string }
  readonly title?: string
  readonly parentID?: string
  readonly agent?: string
}

type FeedEvent = { readonly type: string; readonly data: unknown }
type RpcHandler = (input: unknown) => Promise<unknown>
type ToolHook = (input: { readonly tool: string; readonly sessionID: string }) => Promise<void>

type Deferred = {
  readonly promise: Promise<void>
  resolve(): void
}

/** 输入：无；输出：可手动 resolve 的 Promise。 */
function deferred(): Deferred {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** 输入：无；输出：会话不存在的结构化错误。预期：locateSession 按 missing 处理。 */
function missingSession(): Error {
  return Object.assign(new Error("session not found"), { _tag: "Session.NotFoundError" })
}

/** 输入：无；输出：让所有已排队微任务与一个宏任务跑完。 */
async function tick(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

type Harness = {
  readonly storage: MemoryStore
  readonly sessions: Map<string, SessionInfo>
  readonly messages: Map<string, unknown[]>
  readonly contextCalls: Map<string, number>
  readonly hooks: {
    get?: (sessionID: string) => Promise<SessionInfo> | undefined
    context?: (sessionID: string) => Promise<unknown[]> | undefined
  }
  panelGet(input: { readonly sessionID: string }): Promise<PanelData>
  toolAfter(input: { readonly tool: string; readonly sessionID: string }): Promise<void>
  push(event: FeedEvent): Promise<void>
  close(): Promise<void>
}

/**
 * 输入：本实例 location。
 * 输出：用真实 MemoryStore 与真实插件 setup 搭出的测试夹具。
 * 预期：RPC 是被捕获的真实 handler；事件从可控异步队列喂给插件的统一分发循环。
 */
async function createHarness(location: {
  readonly directory: string
  readonly workspaceID?: string
}): Promise<Harness> {
  const storage = new MemoryStore()
  const sessions = new Map<string, SessionInfo>()
  const messages = new Map<string, unknown[]>()
  const contextCalls = new Map<string, number>()
  const hooks: Harness["hooks"] = {}
  const toolHooks = new Map<string, ToolHook>()
  const handlers = new Map<string, RpcHandler>()

  const queue: { readonly event: FeedEvent; readonly processed: () => void }[] = []
  let closed = false
  let wake: (() => void) | undefined
  const flushWake = (): void => {
    const current = wake
    wake = undefined
    current?.()
  }

  async function* subscribe(): AsyncGenerator<FeedEvent> {
    for (;;) {
      if (closed) return
      const item = queue.shift()
      if (item === undefined) {
        await new Promise<void>((resolve) => {
          wake = resolve
        })
        continue
      }
      yield item.event
      item.processed()
    }
  }

  const ctx = {
    location,
    storage,
    session: {
      get: (input: { readonly sessionID: string }) => {
        const overridden = hooks.get?.(input.sessionID)
        if (overridden !== undefined) return overridden
        const session = sessions.get(input.sessionID)
        if (session === undefined) return Promise.reject(missingSession())
        return Promise.resolve(session)
      },
      context: (input: { readonly sessionID: string }) => {
        contextCalls.set(input.sessionID, (contextCalls.get(input.sessionID) ?? 0) + 1)
        const overridden = hooks.context?.(input.sessionID)
        if (overridden !== undefined) return overridden
        return Promise.resolve(messages.get(input.sessionID) ?? [])
      },
      list: () => Promise.resolve({ data: [], cursor: {} }),
      synthetic: () => Promise.resolve(),
      prompt: () => Promise.resolve(),
      hook: () => Promise.resolve({ dispose: () => Promise.resolve() }),
    },
    command: {
      transform: (apply: (editor: { add: () => void }) => void) => {
        apply({ add: () => undefined })
        return Promise.resolve({ dispose: () => Promise.resolve() })
      },
      reload: () => Promise.resolve(),
    },
    tool: {
      transform: (apply: (tools: { add: () => void }) => void) => {
        apply({ add: () => undefined })
        return Promise.resolve({ dispose: () => Promise.resolve() })
      },
      hook: (name: string, hook: ToolHook) => {
        toolHooks.set(name, hook)
        return Promise.resolve({ dispose: () => Promise.resolve() })
      },
      reload: () => Promise.resolve(),
    },
    rpc: {
      register: (
        _definition: unknown,
        registered: Record<string, RpcHandler>,
      ) => {
        for (const [name, handler] of Object.entries(registered)) handlers.set(name, handler)
        return Promise.resolve({
          events: { emit: () => Promise.resolve() },
          dispose: () => Promise.resolve(),
        })
      },
    },
    event: { subscribe },
  } as unknown as Plugin.Context

  const cleanup = await plugin.setup(ctx)

  const panelGet = async (input: { readonly sessionID: string }): Promise<PanelData> => {
    const handler = handlers.get("panelGet")
    if (handler === undefined) throw new Error("panelGet was not registered")
    return (await handler(input)) as PanelData
  }

  const toolAfter = async (input: { readonly tool: string; readonly sessionID: string }): Promise<void> => {
    const hook = toolHooks.get("execute.after")
    if (hook === undefined) throw new Error("execute.after was not registered")
    await hook(input)
  }

  return {
    storage,
    sessions,
    messages,
    contextCalls,
    hooks,
    panelGet,
    toolAfter,
    async push(event) {
      if (closed) return
      let processed: () => void = () => undefined
      const done = new Promise<void>((resolve) => {
        processed = resolve
      })
      queue.push({ event, processed })
      flushWake()
      await done
    },
    async close() {
      closed = true
      flushWake()
      for (const item of queue.splice(0)) item.processed()
      if (typeof cleanup === "function") await cleanup()
    },
  }
}

/** 输入：token 参数 + 工具名；输出：buildStats 能识别的 assistant 消息。 */
function assistant(
  input: number,
  output: number,
  cache: { readonly read: number; readonly write: number },
  tools: readonly string[] = [],
): unknown {
  return {
    type: "assistant",
    tokens: { input, output, reasoning: 0, cache },
    content: tools.map((name) => ({ type: "tool", name })),
  }
}

const OWNER = { directory: "/work", workspaceID: "ws_a" }
const PARTIAL: SessionStats = { steps: 0, input: 0, output: 0, cached: 0, tools: {} }

describe("panelGet 统计首次重建", () => {
  it("已有部分存档时仍从完整历史补齐，之后读存档不再重建", async () => {
    const harness = await createHarness(OWNER)
    try {
      const sessionID = "ses_rebuild"
      harness.sessions.set(sessionID, { location: OWNER })
      harness.messages.set(sessionID, [
        assistant(10, 2, { read: 4, write: 1 }, ["read"]),
        assistant(20, 3, { read: 6, write: 2 }, ["grep"]),
      ])
      await saveStats(harness.storage, sessionID, {
        steps: 1,
        input: 10,
        output: 2,
        cached: 4,
        tools: { stale: 9 },
      })

      const panel = await harness.panelGet({ sessionID })
      expect(panel.stats).toMatchObject({ steps: 2, input: 43, output: 5, cached: 10 })
      expect(panel.stats.tools).toEqual([
        { name: "read", count: 1 },
        { name: "grep", count: 1 },
      ])
      expect(await loadStats(harness.storage, sessionID)).toEqual({
        steps: 2,
        input: 43,
        output: 5,
        cached: 10,
        lastTool: "grep",
        tools: { read: 1, grep: 1 },
      })

      const calls = harness.contextCalls.get(sessionID) ?? 0
      await harness.panelGet({ sessionID })
      expect(harness.contextCalls.get(sessionID) ?? 0).toBe(calls)
    } finally {
      await harness.close()
    }
  })

  it("首次重建读取失败时保留已有存档且不标记完成，下次仍会重试", async () => {
    const harness = await createHarness(OWNER)
    try {
      const sessionID = "ses_rebuild_failure"
      harness.sessions.set(sessionID, { location: OWNER })
      const stored: SessionStats = {
        steps: 3,
        input: 30,
        output: 4,
        cached: 10,
        lastTool: "read",
        tools: { read: 2 },
      }
      await saveStats(harness.storage, sessionID, stored)
      harness.hooks.context = () => Promise.reject(new Error("context unavailable"))

      const panel = await harness.panelGet({ sessionID })
      expect(panel.stats).toMatchObject({
        steps: 3,
        input: 30,
        output: 4,
        cached: 10,
        lastTool: "read",
      })
      expect(await loadStats(harness.storage, sessionID)).toEqual(stored)

      delete harness.hooks.context
      harness.messages.set(sessionID, [assistant(40, 5, { read: 2, write: 1 }, ["grep"])])
      await harness.panelGet({ sessionID })

      expect(harness.contextCalls.get(sessionID)).toBe(2)
      expect(await loadStats(harness.storage, sessionID)).toMatchObject({
        steps: 1,
        input: 43,
        output: 5,
        cached: 2,
        lastTool: "grep",
      })
    } finally {
      await harness.close()
    }
  })

  it("重建保存失败时不打完成标记，下次 panelGet 会再重建", async () => {
    const harness = await createHarness(OWNER)
    try {
      const sessionID = "ses_rebuild_save_failure"
      harness.sessions.set(sessionID, { location: OWNER })
      harness.messages.set(sessionID, [assistant(10, 1, { read: 0, write: 0 }, ["read"])])
      const set = vi.spyOn(harness.storage, "set").mockRejectedValueOnce(new Error("storage unavailable"))

      const first = await harness.panelGet({ sessionID })
      expect(first.stats.steps).toBe(1)
      expect(await loadStats(harness.storage, sessionID)).toBeNull()

      const second = await harness.panelGet({ sessionID })
      expect(second.stats.steps).toBe(1)
      expect(harness.contextCalls.get(sessionID)).toBe(2)
      expect(await loadStats(harness.storage, sessionID)).toMatchObject({
        steps: 1,
        input: 10,
        lastTool: "read",
      })
      expect(set).toHaveBeenCalledTimes(2)
    } finally {
      await harness.close()
    }
  })

  it("完成标记存在但存档丢失时清标记并重建一次", async () => {
    const harness = await createHarness(OWNER)
    try {
      const sessionID = "ses_marker_without_stats"
      harness.sessions.set(sessionID, { location: OWNER })
      harness.messages.set(sessionID, [assistant(10, 1, { read: 0, write: 0 }, ["read"])])

      await harness.panelGet({ sessionID })
      await harness.storage.remove(statsKey(sessionID))

      const rebuilt = await harness.panelGet({ sessionID })
      expect(rebuilt.stats.steps).toBe(1)
      expect(harness.contextCalls.get(sessionID)).toBe(2)
      expect(await loadStats(harness.storage, sessionID)).toMatchObject({
        steps: 1,
        input: 10,
        lastTool: "read",
      })
    } finally {
      await harness.close()
    }
  })

  it("重建历史没有工具时保留存档里的 lastTool", async () => {
    const harness = await createHarness(OWNER)
    try {
      const sessionID = "ses_last_tool_fallback"
      harness.sessions.set(sessionID, { location: OWNER })
      harness.messages.set(sessionID, [assistant(10, 1, { read: 0, write: 0 })])
      await saveStats(harness.storage, sessionID, {
        steps: 1,
        input: 10,
        output: 1,
        cached: 0,
        lastTool: "read",
        tools: {},
      })

      const panel = await harness.panelGet({ sessionID })
      expect(panel.stats.lastTool).toBe("read")
      expect((await loadStats(harness.storage, sessionID))?.lastTool).toBe("read")
    } finally {
      await harness.close()
    }
  })

  it("首次重建与工具增量共用串行链，工具计数不被覆盖", async () => {
    const harness = await createHarness(OWNER)
    try {
      const sessionID = "ses_serial"
      harness.sessions.set(sessionID, { location: OWNER })
      harness.messages.set(sessionID, [assistant(10, 1, { read: 0, write: 0 })])
      await saveStats(harness.storage, sessionID, PARTIAL)

      const started = deferred()
      const gate = deferred()
      harness.hooks.context = (id) => {
        if (id !== sessionID) return undefined
        started.resolve()
        return gate.promise.then(() => harness.messages.get(sessionID) ?? [])
      }

      const panelPromise = harness.panelGet({ sessionID })
      await started.promise

      let toolDone = false
      const toolPromise = harness.toolAfter({ tool: "read", sessionID }).then(() => {
        toolDone = true
      })
      await tick()
      // 首次重建占着同一个会话串行链，工具增量必须排在它后面。
      expect(toolDone).toBe(false)

      gate.resolve()
      await panelPromise
      await toolPromise

      expect(await loadStats(harness.storage, sessionID)).toEqual({
        steps: 1,
        input: 10,
        output: 1,
        cached: 0,
        lastTool: "read",
        tools: { read: 1 },
      })
    } finally {
      await harness.close()
    }
  })

  it("首次重建与删除串行，重建后的迟到保存不复活统计", async () => {
    const harness = await createHarness(OWNER)
    try {
      const sessionID = "ses_deleted_during_rebuild"
      harness.sessions.set(sessionID, { location: OWNER })
      harness.messages.set(sessionID, [assistant(10, 1, { read: 0, write: 0 })])
      await saveStats(harness.storage, sessionID, PARTIAL)

      const started = deferred()
      const gate = deferred()
      harness.hooks.context = (id) => {
        if (id !== sessionID) return undefined
        started.resolve()
        return gate.promise.then(() => harness.messages.get(sessionID) ?? [])
      }

      const panelPromise = harness.panelGet({ sessionID })
      await started.promise

      harness.sessions.delete(sessionID)
      const deletion = harness.push({ type: "session.deleted", data: { sessionID } })
      await tick()

      gate.resolve()
      await panelPromise
      await deletion
      expect(await loadStats(harness.storage, sessionID)).toBeNull()
    } finally {
      await harness.close()
    }
  })

  it("删除会话与迟到工具写入串行，旧统计不复活", async () => {
    const harness = await createHarness(OWNER)
    try {
      const sessionID = "ses_deleted_late_tool"
      harness.sessions.set(sessionID, { location: OWNER })
      await saveStats(harness.storage, sessionID, {
        steps: 1,
        input: 5,
        output: 1,
        cached: 0,
        tools: { old: 1 },
      })

      const started = deferred()
      const release = deferred()
      harness.hooks.get = (id) => {
        if (id !== sessionID) return undefined
        started.resolve()
        return release.promise.then(() => ({ location: OWNER }))
      }

      const toolPromise = harness.toolAfter({ tool: "read", sessionID })
      await started.promise

      harness.sessions.delete(sessionID)
      const deletion = harness.push({ type: "session.deleted", data: { sessionID } })
      await tick()

      release.resolve()
      await toolPromise
      await deletion
      expect(await loadStats(harness.storage, sessionID)).toBeNull()
    } finally {
      await harness.close()
    }
  })

  it("同目录多会话的统计互不干扰", async () => {
    const harness = await createHarness(OWNER)
    try {
      harness.sessions.set("ses_a", { location: OWNER })
      harness.sessions.set("ses_b", { location: OWNER })
      harness.messages.set("ses_a", [assistant(10, 1, { read: 0, write: 0 })])
      harness.messages.set("ses_b", [
        assistant(20, 2, { read: 0, write: 0 }),
        assistant(30, 3, { read: 0, write: 0 }),
      ])

      const [a, b] = await Promise.all([
        harness.panelGet({ sessionID: "ses_a" }),
        harness.panelGet({ sessionID: "ses_b" }),
      ])

      expect(a.stats.steps).toBe(1)
      expect(a.stats.input).toBe(10)
      expect(b.stats.steps).toBe(2)
      expect(b.stats.input).toBe(50)
      expect((await loadStats(harness.storage, "ses_a"))?.input).toBe(10)
      expect((await loadStats(harness.storage, "ses_b"))?.input).toBe(50)
    } finally {
      await harness.close()
    }
  })

  it("同目录不同 workspaceID 的会话不写统计", async () => {
    const harness = await createHarness(OWNER)
    try {
      const sessionID = "ses_other_workspace"
      harness.sessions.set(sessionID, {
        location: { directory: "/work", workspaceID: "ws_b" },
      })
      await saveStats(harness.storage, sessionID, {
        steps: 1,
        input: 5,
        output: 1,
        cached: 0,
        tools: { old: 1 },
      })

      const panel = await harness.panelGet({ sessionID })
      expect(panel.stats.steps).toBe(0)

      await harness.toolAfter({ tool: "read", sessionID })
      await harness.push({
        type: "session.step.ended",
        data: {
          sessionID,
          tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      })

      expect(await loadStats(harness.storage, sessionID)).toEqual({
        steps: 1,
        input: 5,
        output: 1,
        cached: 0,
        tools: { old: 1 },
      })
      expect(harness.storage.values.has(statsKey(sessionID))).toBe(true)
    } finally {
      await harness.close()
    }
  })
})
