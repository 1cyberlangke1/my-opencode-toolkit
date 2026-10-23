import { testRender } from "@opentui/solid"
import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal } from "solid-js"

import { resolveMessages } from "../src/i18n/index.ts"
import { DEFAULT_SETTINGS, type Settings } from "../src/shared/settings.ts"
import type { PanelData } from "../src/shared/rpc.ts"
import { ContextStats } from "../src/tui/main.tsx"

/** 输入：无；输出：ContextStats 需要的最小假上下文。 */
function fakeContext(): Context {
  const panel: PanelData = {
    goal: null,
    loops: [],
    jobs: [],
    stats: {
      steps: 3,
      input: 63_100_000,
      output: 64_100,
      cached: 62_400_000,
      hitRate: 98.91,
      subagents: 0,
      tools: [],
    },
    subagents: [],
  }
  return {
    client: {
      rpc: () => ({
        panelGet: () => Promise.resolve(panel),
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
        },
      },
    },
  } as unknown as Context
}

/** 输入：上下文统计设置补丁；输出：渲染后的 ContextStats。 */
async function mount(patch: Partial<Settings["contextStats"]> = {}) {
  const initial: Settings = {
    ...DEFAULT_SETTINGS,
    contextStats: { ...DEFAULT_SETTINGS.contextStats, ...patch },
  }
  const [settings] = createSignal<Settings>(initial)
  return testRender(
    () => (
      <ContextStats
        context={fakeContext()}
        sessionID="ses_test"
        settings={settings}
        copy={() => resolveMessages("en")}
      />
    ),
    { width: 80, height: 4 },
  )
}

describe("ContextStats", () => {
  test("显示总输入输出缓存与两位命中，不带 Context 前缀", async () => {
    const app = await mount()
    const frame = await app.waitForFrame((text) => text.includes("98.91%"))

    expect(frame).toContain("↑ 63.1M")
    expect(frame).toContain("↓ 64.1K")
    expect(frame).toContain("♻  62.4M")
    expect(frame).toContain("🎯 98.91%")
    expect(frame).not.toContain("Context")

    await app.dispose()
  })

  test("关闭输入后省略 ↑，其余字段保留", async () => {
    const app = await mount({ showInput: false })
    const frame = await app.waitForFrame((text) => text.includes("♻"))

    expect(frame).not.toContain("↑")
    expect(frame).toContain("↓ 64.1K")
    expect(frame).toContain("🎯 98.91%")

    await app.dispose()
  })

  test("关闭输出和缓存后只保留输入与命中", async () => {
    const app = await mount({ showOutput: false, showCache: false })
    const frame = await app.waitForFrame((text) => text.includes("🎯"))

    expect(frame).toContain("↑ 63.1M")
    expect(frame).not.toContain("↓")
    expect(frame).not.toContain("♻")
    expect(frame).not.toContain("·")
    expect(frame).toContain("🎯 98.91%")

    await app.dispose()
  })

  test("所有字段关闭后不渲染", async () => {
    const app = await mount({
      showInput: false,
      showOutput: false,
      showCache: false,
      showHitRate: false,
    })
    const frame = await app.waitForFrame(
      (text) => !text.includes("↑") && !text.includes("↓") && !text.includes("♻") && !text.includes("🎯"),
    )

    expect(frame).not.toContain("↑")
    expect(frame).not.toContain("↓")
    expect(frame).not.toContain("♻")
    expect(frame).not.toContain("🎯")

    await app.dispose()
  })

  test("整行关闭后不渲染", async () => {
    const app = await mount({ enabled: false })
    const frame = await app.waitForFrame((text) => !text.includes("🎯") && !text.includes("♻"))

    expect(frame).not.toContain("🎯")
    expect(frame).not.toContain("♻")

    await app.dispose()
  })
})
