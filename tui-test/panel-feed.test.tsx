import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { Context } from "@opencode/plugin/tui/context"

import type { PanelData } from "../src/shared/rpc.ts"
import { createPanelFeed } from "../src/tui/panel-cache.ts"

/** 输入：步数；输出：最小面板数据。 */
function panel(steps: number): PanelData {
  return {
    goal: null,
    loops: [],
    jobs: [],
    stats: {
      steps,
      input: 0,
      output: 0,
      cached: 0,
      hitRate: 0,
      subagents: 0,
      lastTool: null,
      tools: [],
    },
    subagents: [],
  }
}

/**
 * 输入：无。
 * 输出：只实现 feed 依赖的假上下文 + 事件触发器。
 * 预期：`listen` / `events.on` 的处理器被捕获，测试可手动投递事件。
 */
function harness(): {
  readonly context: Context
  readonly emit: (type: string, sessionID: string) => void
  readonly emitPanel: (sessionID: string) => void
} {
  const listeners: ((input: { details: { type: string; data: unknown } }) => void)[] = []
  const panelHandlers: ((event: { data: { sessionID: string } }) => void)[] = []
  const context = {
    location: { directory: "/work" },
    client: {
      rpc: () => ({
        events: {
          on: (_name: string, handler: (event: { data: { sessionID: string } }) => void) => {
            panelHandlers.push(handler)
            return () => {}
          },
        },
      }),
    },
    data: {
      listen: (handler: (input: { details: { type: string; data: unknown } }) => void) => {
        listeners.push(handler)
        return () => {}
      },
    },
  } as unknown as Context

  return {
    context,
    emit: (type, sessionID) => {
      for (const listener of listeners) listener({ details: { type, data: { sessionID } } })
    },
    emitPanel: (sessionID) => {
      for (const handler of panelHandlers) handler({ data: { sessionID } })
    },
  }
}

/** 输入：上下文 + 读取函数；输出：只展示步数的探针组件。 */
function Fixture(props: {
  readonly context: Context
  readonly readPanel: (context: Context, sessionID: string) => Promise<PanelData>
}) {
  const feed = createPanelFeed({
    context: props.context,
    sessionID: "ses_a",
    readPanel: props.readPanel,
  })
  return <text>{`steps:${String(feed.panel()?.stats.steps ?? -1)}`}</text>
}

/** 输入：毫秒；输出：等待 Promise。预期：让 50ms 合并窗口走完。 */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("createPanelFeed", () => {
  test("挂载时拉一次，本会话的连续事件只合并刷新一次", async () => {
    let calls = 0
    const readPanel = (): Promise<PanelData> => {
      calls += 1
      return Promise.resolve(panel(calls))
    }
    const h = harness()
    const app = await testRender(() => <Fixture context={h.context} readPanel={readPanel} />, {
      width: 20,
      height: 3,
    })
    app.renderer.start()
    try {
      await app.waitForFrame((value) => value.includes("steps:1"))
      expect(calls).toBe(1)

      h.emit("session.step.ended", "ses_a")
      h.emit("session.step.ended", "ses_a")
      h.emitPanel("ses_a")

      await app.waitForFrame((value) => value.includes("steps:2"))
      expect(calls).toBe(2)
    } finally {
      await app.dispose()
    }
  })

  test("别的会话事件不触发刷新", async () => {
    let calls = 0
    const readPanel = (): Promise<PanelData> => {
      calls += 1
      return Promise.resolve(panel(calls))
    }
    const h = harness()
    const app = await testRender(() => <Fixture context={h.context} readPanel={readPanel} />, {
      width: 20,
      height: 3,
    })
    app.renderer.start()
    try {
      await app.waitForFrame((value) => value.includes("steps:1"))

      h.emit("session.step.ended", "ses_other")
      h.emitPanel("ses_other")
      await wait(120)

      expect(calls).toBe(1)
    } finally {
      await app.dispose()
    }
  })
})

