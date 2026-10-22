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
    tools: [{ name: "read", count: 2 }],
  },
}

/** 输入：无；输出：只实现侧栏依赖的假上下文。 */
function fakeContext(): Context {
  return {
    client: {
      rpc: () => ({
        panelGet: () => Promise.resolve(PANEL),
      }),
    },
    data: {
      listen: () => () => {},
    },
  } as unknown as Context
}

/** 输入：语言；输出：挂载好的侧栏。 */
async function mount(lang: "zh" | "en") {
  const [settings] = createSignal<Settings>({ ...DEFAULT_SETTINGS, lang })
  return testRender(
    () => (
      <Sidebar
        context={fakeContext()}
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

    expect(frame).toContain("Toolkit")
    expect(frame).toContain("Goal: ship it")
    expect(frame).toContain("33.33%")
    expect(frame).toContain("read 2")
    expect(frame).toContain("Subagents: 1")
    expect(frame).toContain("Loops: 1")
    expect(frame).toContain("Jobs: 1")

    await app.dispose()
  })

  test("中文设置渲染中文标签", async () => {
    const app = await mount("zh")
    const frame = await app.waitForFrame((text) => text.includes("目标"))

    expect(frame).toContain("工具包")
    expect(frame).toContain("目标: ship it")
    expect(frame).toContain("子代理: 1")

    await app.dispose()
  })
})
