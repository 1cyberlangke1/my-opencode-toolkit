import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"

import { DEFAULT_SETTINGS, type Settings } from "../src/shared/settings.ts"
import plugin from "../src/tui/index.tsx"

/** 已注册的 keymap 层。 */
type RegisteredLayer = {
  readonly commands?: readonly {
    readonly slash?: { readonly name: string }
    readonly run: () => void | Promise<void>
  }[]
}

/** 一次对话框调用。 */
type SelectCall = {
  readonly title: string
  readonly options: readonly { readonly title: string; readonly value: unknown; readonly footer?: string }[]
}

/**
 * 输入：可选的对话框选择序列与设置写入实现。
 * 输出：只实现 TUI setup 依赖的假上下文 + 捕获到的注册项。
 * 预期：不渲染真实终端；用来验证 setup 的注册、写回与销毁路径。
 */
function fakeContext(options: {
  readonly picks?: readonly (string | undefined)[]
  readonly onSettingsSet?: (next: Settings) => Promise<Settings>
}): {
  readonly context: Context
  readonly slots: string[]
  readonly layers: RegisteredLayer[]
  readonly selects: SelectCall[]
} {
  const slots: string[] = []
  const layers: RegisteredLayer[] = []
  const selects: SelectCall[] = []
  let pickIndex = 0

  const context = {
    client: {
      rpc: () => ({
        settingsGet: () => Promise.resolve({ ...DEFAULT_SETTINGS }),
        settingsSet: (next: Settings) => options.onSettingsSet?.(next) ?? Promise.resolve(next),
        panelGet: () =>
          Promise.resolve({
            goal: null,
            loops: [],
            jobs: [],
            stats: { steps: 0, input: 0, output: 0, cached: 0, hitRate: 0, subagents: 0, tools: [] },
          }),
      }),
    },
    ui: {
      dialog: {
        select: (call: SelectCall) => {
          selects.push(call)
          return Promise.resolve(options.picks?.[pickIndex++])
        },
      },
      slot: (claim: { readonly append?: string }) => {
        slots.push(claim.append ?? "")
        return () => undefined
      },
    },
    keymap: {
      layer: (factory: () => RegisteredLayer) => {
        layers.push(factory())
      },
    },
    data: {
      listen: () => () => undefined,
    },
  } as unknown as Context

  return { context, slots, layers, selects }
}

/** 输入：对话框调用 + 条目值；输出：该条目的 footer。 */
function footerOf(call: SelectCall | undefined, value: string): string | undefined {
  return call?.options.find((option) => option.value === value)?.footer
}

describe("tui plugin setup", () => {
  test("注册侧栏 slot 与斜杠命令，卸载时释放 slot", async () => {
    const { context, slots, layers } = fakeContext({})
    const cleanup = await plugin.setup(context)

    expect(slots).toEqual(["sidebar.content"])
    expect(layers).toHaveLength(1)
    expect(layers[0]?.commands?.[0]?.slash?.name).toBe("my-opencode-toolkit")

    await cleanup?.()
  })

  test("设置菜单切换 goal 并通过 RPC 写回", async () => {
    const saved: Settings[] = []
    const { context, layers } = fakeContext({
      // 第一次选 goal，第二次 Esc 退出菜单。
      picks: ["goal", undefined],
      onSettingsSet: (next) => {
        saved.push(next)
        return Promise.resolve(next)
      },
    })

    const cleanup = await plugin.setup(context)
    const command = layers[0]?.commands?.[0]
    expect(command).toBeDefined()
    command?.run()
    await Bun.sleep(20)

    expect(saved).toHaveLength(1)
    expect(saved[0]?.goal.enabled).toBe(false)
    expect(saved[0]?.enabled).toBe(true)

    await cleanup?.()
  })

  test("写回失败时回滚本地设置", async () => {
    const { context, layers, selects } = fakeContext({
      picks: ["goal", undefined],
      onSettingsSet: () => Promise.reject(new Error("storage down")),
    })

    const cleanup = await plugin.setup(context)
    layers[0]?.commands?.[0]?.run()
    await Bun.sleep(20)

    // 菜单重开后 goal 的 footer 仍是默认的“开”，说明失败后回滚了乐观更新。
    expect(selects).toHaveLength(2)
    expect(footerOf(selects[1], "goal")).toBe(footerOf(selects[0], "goal"))

    await cleanup?.()
  })
})
