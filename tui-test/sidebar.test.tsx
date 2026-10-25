import { testRender } from "@opentui/solid"
import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal, For } from "solid-js"

import { resolveMessages } from "../src/i18n/index.ts"
import { DEFAULT_SETTINGS, type Settings } from "../src/shared/settings.ts"
import type { PanelData } from "../src/shared/rpc.ts"
import { Sidebar, type SidebarSection } from "../src/tui/main.tsx"

const SECTIONS: readonly SidebarSection[] = ["goal", "scheduling", "tools", "subagents"]

/** 侧栏测试用的固定面板数据。 */
const PANEL: PanelData = {
  goal: {
    objective: "ship it",
    status: "active",
    tokensUsed: 47_013_600,
    inputTokens: 46_900_000,
    outputTokens: 113_600,
    cachedTokens: 46_700_000,
    timeUsedSeconds: 10,
  },
  loops: [{ id: "loop1", mode: "fixed", prompt: "loop prompt" }],
  jobs: [{ id: "job1", cron: "0 * * * *", prompt: "job prompt" }],
  stats: {
    steps: 3,
    input: 1000,
    output: 20,
    cached: 500,
    hitRate: 33.33,
    subagents: 1,
    lastTool: "read",
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
        events: { on: () => () => {} },
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
          info: { base: "#00aaff" },
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
      <box gap={1}>
        <For each={SECTIONS}>
          {(section) => (
            <Sidebar
              context={fakeContext(panel)}
              sessionID="ses_test"
              settings={settings}
              copy={() => resolveMessages(lang)}
              section={section}
            />
          )}
        </For>
      </box>
    ),
    { width: 80, height: 20 },
  )
}

/** 输入：app + 行内标记 + 片段文本；输出：该行里文本完全相同的 span；找不到返回 undefined。 */
function findSpanOnLine(app: Awaited<ReturnType<typeof mount>>, lineText: string, text: string) {
  for (const line of app.captureSpans().lines) {
    if (!line.spans.map((span) => span.text).join("").includes(lineText)) continue
    for (const span of line.spans) {
      if (span.text === text) return span
    }
  }
  return undefined
}

describe("sidebar panel", () => {
  test("渲染目标、缓存、工具与调度数量", async () => {
    const app = await mount("en")
    const frame = await app.waitForFrame((text) => text.includes("ship it"))

    expect(frame).toContain("Goal")
    expect(frame).toContain("ship it")
    expect(frame).toContain("↑ 46.9M ↓ 113.6K ♻  46.7M")
    expect(frame).toContain("read")
    expect(frame).toContain("very_long_tool_name")
    expect(frame).not.toContain("zero")
    expect(frame).not.toContain("+1")
    expect(frame).toContain("Scheduled")
    expect(frame).toContain("0 * * * *")
    expect(frame).toContain("loop prompt")
    expect(frame).toContain("Subagents (1)")
    expect(frame).toContain("review")
    expect(frame).toContain("Tools (2)")
    expect(frame).toContain("[read](2)")
    expect(frame).toContain("[very_long_tool_name](1)")
    expect(frame).toMatch(/\n\s*\n[^\n]*Scheduled/)
    expect(frame).toMatch(/\n\s*\n[^\n]*Tools \(2\)/)
    expect(frame).not.toContain("41.67%")

    await app.dispose()
  })

  test("最近调用的工具计数用成功绿，其余保持 muted", async () => {
    const app = await mount("en")
    await app.waitForFrame((text) => text.includes("[read](2)"))

    // 主题里 success=#00ff00、muted=#888888；只验证计数片段，工具名不算。
    expect(findSpanOnLine(app, "[read](2)", "(2)")?.fg.toInts()).toEqual([0, 255, 0, 255])
    expect(findSpanOnLine(app, "[very_long_tool_name](1)", "(1)")?.fg.toInts()).toEqual([136, 136, 136, 255])

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
