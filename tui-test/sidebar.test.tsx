import { testRender } from "@opentui/solid"
import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal } from "solid-js"

import { resolveMessages } from "../src/i18n/index.ts"
import { DEFAULT_SETTINGS, type Settings } from "../src/shared/settings.ts"
import type { PanelData } from "../src/shared/rpc.ts"
import { Sidebar } from "../src/tui/index.tsx"

/** 侧栏测试用的固定面板数据。 */
const PANEL: PanelData = {
  goal: { objective: "ship it", status: "active", tokensUsed: 1234, timeUsedSeconds: 10 },
  loops: [{ id: "loop1", mode: "fixed", prompt: "loop prompt" }],
  jobs: [{ id: "job1", cron: "0 * * * *", prompt: "job prompt" }],
  stats: {
    steps: 3,
    input: 1000,
    output: 20,
    cached: 500,
    hitRate: 33.33,
    subagents: 1,
    tools: [
      { name: "read", count: 2 },
      { name: "zero", count: 0 },
      { name: "very_long_tool_name", count: 1 },
    ],
  },
  subagents: [
    { id: "child1", title: "review", updatedAt: Date.now(), input: 1200, output: 20, cached: 500 },
  ],
}

/** 输入：面板数据；输出：只实现侧栏依赖的假上下文。 */
function fakeContext(panel: PanelData = PANEL): Context {
  return {
    client: {
      rpc: () => ({
        panelGet: () => Promise.resolve(panel),
        subagentGet: () =>
          Promise.resolve({ steps: 1, input: 1200, output: 20, cached: 500, hitRate: 41.67, tools: [{ name: "read", count: 2 }] }),
      }),
    },
    data: {
      listen: () => () => {},
    },
    theme: {
      text: {
        base: "#ffffff",
        muted: "#888888",
        feedback: {
          success: { base: "#00ff00" },
          warning: { base: "#ffff00" },
          error: { base: "#ff0000" },
        },
      },
    },
  } as unknown as Context
}

/** 输入：语言 + 面板；输出：挂载好的侧栏。 */
async function mount(lang: "zh" | "en", panel: PanelData = PANEL) {
  const [settings] = createSignal<Settings>({ ...DEFAULT_SETTINGS, lang })
  return testRender(
    () => (
      <Sidebar
        context={fakeContext(panel)}
        sessionID="ses_test"
        settings={settings}
        copy={() => resolveMessages(lang)}
      />
    ),
    { width: 80, height: 20 },
  )
}

describe("sidebar panel", () => {
  test("渲染目标、缓存、工具与调度数量", async () => {
    const app = await mount("en")
    const frame = await app.waitForFrame((text) => text.includes("ship it"))

    expect(frame).toContain("Goal")
    expect(frame).toContain("ship it")
    expect(frame).toContain("read")
    expect(frame).toContain("very_long_tool_name")
    expect(frame).not.toContain("zero")
    expect(frame).not.toContain("+1")
    expect(frame).toContain("Scheduled")
    expect(frame).toContain("0 * * * *")
    expect(frame).toContain("loop prompt")
    expect(frame).toContain("Subagents")
    expect(frame).toContain("review")
    expect(frame).toContain("Tools (2)")
    expect(frame).not.toContain("41.67%")

    await app.dispose()
  })

  test("目标为空时整个目标分区不渲染", async () => {
    const app = await mount("en", { ...PANEL, goal: null })
    const frame = await app.waitForFrame((text) => text.includes("Tools (2)"))

    expect(frame).not.toContain("Goal")
    expect(frame).not.toContain("No goal")
    expect(frame).not.toContain("none")

    await app.dispose()
  })

  test("中文设置渲染中文标签", async () => {
    const app = await mount("zh")
    const frame = await app.waitForFrame((text) => text.includes("目标"))

    expect(frame).toContain("目标")
    expect(frame).toContain("ship it")
    expect(frame).toContain("子代理")
    expect(frame).toContain("review")

    await app.dispose()
  })
})
