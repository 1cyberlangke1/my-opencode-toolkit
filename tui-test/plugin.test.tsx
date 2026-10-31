import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"

import { DEFAULT_SETTINGS, type Settings } from "../src/shared/settings.ts"
import { resolveMessages } from "../src/i18n/index.ts"
import plugin from "../src/tui/main.tsx"

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

/** 一次 toast 调用。 */
type ToastCall = {
  readonly message: string
  readonly variant?: string
}

/** RPC toast 事件处理器。 */
type ToastHandler = (event: {
  readonly data: { readonly reason: string; readonly kind: string; readonly sessionID: string }
}) => void

/**
 * 输入：可选的对话框选择序列与设置写入实现。
 * 输出：只实现 TUI setup 依赖的假上下文 + 捕获到的注册项。
 * 预期：不渲染真实终端；用来验证 setup 的注册、写回与销毁路径。
 */
function fakeContext(options: {
  readonly picks?: readonly (string | undefined)[]
  readonly prompts?: readonly (string | undefined)[]
  readonly onSettingsSet?: (next: Settings) => Promise<Settings>
}): {
  readonly context: Context
  readonly slots: string[]
  readonly layers: RegisteredLayer[]
  readonly selects: SelectCall[]
  readonly toasts: ToastCall[]
  readonly toastHandlers: ToastHandler[]
  readonly promptCalls: { title: string; value?: string }[]
} {
  const slots: string[] = []
  const layers: RegisteredLayer[] = []
  const selects: SelectCall[] = []
  const toasts: ToastCall[] = []
  const toastHandlers: ToastHandler[] = []
  const promptCalls: { title: string; value?: string }[] = []
  let pickIndex = 0
  let promptIndex = 0

  const context = {
    theme: {
      text: {
        base: "#ffffff",
        muted: "#888888",
        feedback: {
          warning: { base: "#ffcc00" },
          error: { base: "#ff0000" },
        },
      },
    },
    client: {
      rpc: () => ({
        settingsGet: () => Promise.resolve({ ...DEFAULT_SETTINGS }),
        settingsSet: (next: Settings) => options.onSettingsSet?.(next) ?? Promise.resolve(next),
        panelGet: () =>
          Promise.resolve({
            goal: null,
            loops: [],
            jobs: [],
            stats: { steps: 0, input: 0, output: 0, cached: 0, hitRate: 0, subagents: 0, lastTool: null, tools: [] },
            subagents: [],
          }),
        events: {
          on: (_name: string, handler: ToastHandler) => {
            toastHandlers.push(handler)
            return () => undefined
          },
        },
      }),
    },
    ui: {
      dialog: {
        select: (call: SelectCall) => {
          selects.push(call)
          return Promise.resolve(options.picks?.[pickIndex++])
        },
        prompt: (call: { title: string; value?: string }) => {
          promptCalls.push(call)
          return Promise.resolve(options.prompts?.[promptIndex++])
        },
      },
      toast: {
        show: (call: ToastCall) => {
          toasts.push(call)
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
      session: {
        get: (id: string) => (id === "ses_1" ? { id } : undefined),
      },
    },
  } as unknown as Context

  return { context, slots, layers, selects, toasts, toastHandlers, promptCalls }
}

/** 输入：对话框调用 + 条目值；输出：该条目的 footer。 */
function footerOf(call: SelectCall | undefined, value: string): string | undefined {
  return call?.options.find((option) => option.value === value)?.footer
}

describe("tui plugin setup", () => {
  test("注册侧栏 slot 与斜杠命令，卸载时释放 slot", async () => {
    const { context, slots, layers } = fakeContext({})
    const cleanup = await plugin.setup(context)

    expect(slots).toEqual([
      "sidebar.content",
      "sidebar.content",
      "sidebar.content",
      "sidebar.content",
      "prompt.footer",
    ])
    expect(layers).toHaveLength(1)
    expect(layers[0]?.commands?.[0]?.slash?.name).toBe("my-opencode-toolkit")

    await cleanup?.()
  })

  test("主菜单没有通用总开关，语言直接在第一项", async () => {
    const { context, layers, selects } = fakeContext({ picks: [undefined] })
    const cleanup = await plugin.setup(context)

    layers[0]?.commands?.[0]?.run()
    await Bun.sleep(20)

    const titles = selects[0]?.options.map((option) => option.title) ?? []
    expect(titles[0]).toMatch(/Language|语言/)
    expect(titles).not.toContain("General")
    expect(titles).not.toContain("通用")
    expect(titles).not.toContain("Enabled")

    await cleanup?.()
  })

  test("侧栏子菜单只有工具/子代理显示开关", async () => {
    const { context, layers, selects } = fakeContext({ picks: ["sidebar", undefined, undefined] })
    const cleanup = await plugin.setup(context)

    layers[0]?.commands?.[0]?.run()
    await Bun.sleep(20)

    expect(footerOf(selects[0], "sidebar")).toBeUndefined()
    expect(selects[1]?.title).toMatch(/Sidebar|侧栏/)
    // 目标/定时的侧栏开关已移入各自选项卡，侧栏子菜单只剩工具/子代理。
    expect(selects[1]?.options.map((option) => option.value)).toEqual(["showTools", "showSubagents"])

    await cleanup?.()
  })

  test("设置菜单切换 goal 并通过 RPC 写回", async () => {
    const saved: Settings[] = []
    const { context, layers } = fakeContext({
      // 第一次选 goal 分类，第二次点功能开关，第三次 Esc 退出子菜单/主菜单。
      picks: ["goal", "enabled", undefined],
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
    // 默认 goal.enabled=false，切换后变 true。
    expect(saved[0]?.goal.enabled).toBe(true)
    expect(saved[0]?.enabled).toBe(true)

    await cleanup?.()
  })

  test("写回失败时回滚本地设置", async () => {
    const { context, layers, selects } = fakeContext({
      picks: ["goal", "enabled", undefined],
      onSettingsSet: () => Promise.reject(new Error("storage down")),
    })

    const cleanup = await plugin.setup(context)
    layers[0]?.commands?.[0]?.run()
    await Bun.sleep(20)

    // 菜单重开后 goal 的 footer 仍是默认的“关”，说明失败后回滚了乐观更新。
    expect(selects).toHaveLength(4)
    expect(footerOf(selects.at(-1), "goal")).toBe(footerOf(selects[0], "goal"))

    await cleanup?.()
  })

  test("收到 plan skipped 事件时弹本地化 toast", async () => {
    const { context, toastHandlers, toasts } = fakeContext({})
    const cleanup = await plugin.setup(context)

    toastHandlers[0]?.({ data: { reason: "planSkipped", kind: "cron", sessionID: "ses_1" } })
    expect(toasts).toHaveLength(1)
    expect(toasts[0]?.variant).toBe("warning")
    // 断言文案来自语言文件，不写死某种语言：本机与 CI 的 locale 可能不同。
    const zh = resolveMessages("zh")
    const en = resolveMessages("en")
    expect([zh.toast.planSkippedCron, en.toast.planSkippedCron]).toContain(toasts[0]?.message)

    toastHandlers[0]?.({ data: { reason: "planSkipped", kind: "loop", sessionID: "ses_1" } })
    expect(toasts).toHaveLength(2)
    expect([zh.toast.planSkippedLoop, en.toast.planSkippedLoop]).toContain(toasts[1]?.message)

    // 不是本 TUI 认识的会话：事件来自别的 location，不能弹。
    toastHandlers[0]?.({ data: { reason: "planSkipped", kind: "cron", sessionID: "ses_other" } })
    expect(toasts).toHaveLength(2)

    await cleanup?.()
  })

  test("主菜单含时间感知项，子菜单四项齐全", async () => {
    const { context, layers, selects } = fakeContext({ picks: ["time", undefined, undefined] })
    const cleanup = await plugin.setup(context)

    layers[0]?.commands?.[0]?.run()
    await Bun.sleep(20)

    const zh = resolveMessages("zh")
    const en = resolveMessages("en")
    expect([zh.menu.time, en.menu.time]).toContain(selects[0]?.options.find((o) => o.value === "time")?.title)
    expect(selects[1]?.title).toMatch(/Time awareness|时间感知/)
    expect(selects[1]?.options.map((option) => option.value)).toEqual([
      "enabled",
      "intervalSteps",
      "format",
      "timezone",
    ])

    await cleanup?.()
  })

  test("时间子菜单：切换开关写回；非法间隔弹 toast 不写回；合法间隔写回", async () => {
    // 开 → 非法间隔 "abc" → 合法间隔 "5" → Esc 退出。
    const saved: Settings[] = []
    const { context, layers, toasts } = fakeContext({
      picks: ["time", "enabled", "intervalSteps", "intervalSteps", undefined],
      prompts: ["abc", "5"],
      onSettingsSet: (next) => {
        saved.push(next)
        return Promise.resolve(next)
      },
    })
    const cleanup = await plugin.setup(context)
    layers[0]?.commands?.[0]?.run()
    await Bun.sleep(20)

    // 开关写回一次；非法值被拦；合法值再写一次。
    expect(saved).toHaveLength(2)
    expect(saved[0]?.time.enabled).toBe(false)
    expect(saved[1]?.time.intervalSteps).toBe(5)
    const zh = resolveMessages("zh")
    const en = resolveMessages("en")
    expect([zh.menu.timeInvalidInterval, en.menu.timeInvalidInterval]).toContain(toasts[0]?.message)

    await cleanup?.()
  })

  test("时间子菜单：格式模板与时区写回；非法时区弹 toast", async () => {
    const saved: Settings[] = []
    const { context, layers, toasts } = fakeContext({
      // 开 → 格式输入 → 时区先输非法 → 再输合法 → Esc。
      picks: ["time", "format", "timezone", "timezone", undefined],
      prompts: ["HH:mm:ss", "Not/AZone", "Asia/Shanghai"],
      onSettingsSet: (next) => {
        saved.push(next)
        return Promise.resolve(next)
      },
    })
    const cleanup = await plugin.setup(context)
    layers[0]?.commands?.[0]?.run()
    await Bun.sleep(20)

    expect(saved).toHaveLength(2)
    expect(saved[0]?.time.format).toBe("HH:mm:ss")
    expect(saved[1]?.time.timezone).toBe("Asia/Shanghai")
    const zh = resolveMessages("zh")
    const en = resolveMessages("en")
    expect([zh.menu.timeInvalidTimezone, en.menu.timeInvalidTimezone]).toContain(toasts[0]?.message)

    await cleanup?.()
  })
})
