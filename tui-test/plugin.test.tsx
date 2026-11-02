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
      slot: (claim: { readonly append?: string; readonly prepend?: string }) => {
        slots.push(claim.append ?? claim.prepend ?? "")
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
      "prompt.footer",
    ])
    expect(layers).toHaveLength(1)
    expect(layers[0]?.commands?.[0]?.slash?.name).toBe("my-opencode-toolkit")

    await cleanup?.()
  })

  test("主菜单三分类：功能/界面/检查更新，footer 呈现纯粹状态流与数值", async () => {
    const { context, layers, selects } = fakeContext({ picks: [undefined] })
    const cleanup = await plugin.setup(context)

    layers[0]?.commands?.[0]?.run()
    await Bun.sleep(20)

    const values = selects[0]?.options.map((option) => option.value) ?? []
    expect(values).toEqual(["features", "appearance", "update"])
    const isWin = process.platform === "win32"
    // 功能分类 footer 呈现纯粹开关状态流（定时 · 时间 · 通知 · 编辑器 · 目标），不带冗长功能名字
    const featuresFooter = footerOf(selects[0], "features") ?? ""
    expect([
      `开 · 开 · 开 · ${isWin ? "开" : "关"} · 关`,
      `on · on · on · ${isWin ? "on" : "off"} · off`,
    ]).toContain(featuresFooter)

    // 界面分类 footer 呈现语言与开关数值（如 auto · 开）
    const appearanceFooter = footerOf(selects[0], "appearance") ?? ""
    expect([
      "auto · 开",
      "auto · on",
    ]).toContain(appearanceFooter)

    await cleanup?.()
  })

  test("功能子菜单：目标带弃用标记且排在末尾，五项齐全", async () => {
    const { context, layers, selects } = fakeContext({ picks: ["features", undefined, undefined] })
    const cleanup = await plugin.setup(context)

    layers[0]?.commands?.[0]?.run()
    await Bun.sleep(20)

    const zh = resolveMessages("zh")
    const en = resolveMessages("en")
    expect(selects[1]?.title).toMatch(/Features|功能/)
    const goalTitle = selects[1]?.options.find((option) => option.value === "goal")?.title ?? ""
    expect([`${zh.menu.goal}${zh.menu.deprecatedSuffix}`, `${en.menu.goal}${en.menu.deprecatedSuffix}`]).toContain(
      goalTitle,
    )
    expect(selects[1]?.options.map((option) => option.value)).toEqual([
      "scheduling",
      "time",
      "notifications",
      "editor",
      "goal",
    ])

    await cleanup?.()
  })

  test("侧栏子菜单四项：定时/工具/子代理 + 目标（移至最下方）", async () => {
    const { context, layers, selects } = fakeContext({ picks: ["appearance", "sidebar", undefined, undefined, undefined] })
    const cleanup = await plugin.setup(context)

    layers[0]?.commands?.[0]?.run()
    await Bun.sleep(20)

    expect(selects[1]?.title).toMatch(/Appearance|界面/)
    expect(selects[2]?.title).toMatch(/Sidebar|侧栏/)
    // 目标（已弃用）移至最下方，其余三项在前。
    expect(selects[2]?.options.map((option) => option.value)).toEqual([
      "scheduling.showInSidebar",
      "showTools",
      "showSubagents",
      "goal.showInSidebar",
    ])

    await cleanup?.()
  })

  test("功能关闭时侧栏显示项仍可改：写入保存且 footer 带不生效提示", async () => {
    const saved: Settings[] = []
    const { context, layers, selects } = fakeContext({
      picks: ["appearance", "sidebar", "goal.showInSidebar", undefined, undefined],
      onSettingsSet: (next) => {
        saved.push(next)
        return Promise.resolve(next)
      },
    })
    const cleanup = await plugin.setup(context)
    layers[0]?.commands?.[0]?.run()
    await Bun.sleep(20)

    // 默认 goal.enabled=false：footer 带不生效后缀，但切换仍写回。
    const zh = resolveMessages("zh")
    const en = resolveMessages("en")
    const footer = footerOf(selects[2], "goal.showInSidebar") ?? ""
    // 功能关闭时 footer 末尾带不生效提示（后缀从语言文件取，不写死文案）。
    expect(
        footer.endsWith(zh.menu.inactiveSuffix) || footer.endsWith(en.menu.inactiveSuffix),
      ).toBe(true)
    expect(saved).toHaveLength(1)
    expect(saved[0]?.goal.showInSidebar).toBe(false)

    await cleanup?.()
  })

  test("设置菜单切换 goal 并通过 RPC 写回", async () => {
    const saved: Settings[] = []
    const { context, layers } = fakeContext({
      // 第一次进功能分类选 goal，第二次点功能开关，第三次 Esc 退出子菜单/主菜单。
      picks: ["features", "goal", "enabled", undefined, undefined],
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
      picks: ["features", "goal", "enabled", undefined, undefined],
      onSettingsSet: () => Promise.reject(new Error("storage down")),
    })

    const cleanup = await plugin.setup(context)
    layers[0]?.commands?.[0]?.run()
    await Bun.sleep(20)

    // 菜单重开后 goal 的 footer 仍是默认的“关”，说明失败后回滚了乐观更新。
    // selects: 主菜单 → 功能 → goal → 切换失败重开 goal → Esc → 功能重开 → 主菜单。
    expect(selects).toHaveLength(6)
    const first = selects[2]?.options.find((option) => option.value === "enabled")?.footer
    const last = selects[3]?.options.find((option) => option.value === "enabled")?.footer
    expect(last).toBe(first)

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

  test("主菜单功能分类含时间感知项，子菜单四项齐全", async () => {
    const { context, layers, selects } = fakeContext({ picks: ["features", "time", undefined, undefined] })
    const cleanup = await plugin.setup(context)

    layers[0]?.commands?.[0]?.run()
    await Bun.sleep(20)

    const zh = resolveMessages("zh")
    const en = resolveMessages("en")
    expect([zh.menu.time, en.menu.time]).toContain(selects[1]?.options.find((o) => o.value === "time")?.title)
    expect(selects[2]?.title).toMatch(/Time awareness|时间感知/)
    expect(selects[2]?.options.map((option) => option.value)).toEqual([
      "enabled",
      "mode",
      "interval",
      "format",
      "timezone",
    ])

    await cleanup?.()
  })

  test("时间子菜单：切换开关写回；非法间隔弹 toast 不写回；合法时间间隔写回", async () => {
    // 进功能分类 → time → 开关 → 非法间隔 "20s"（小于30s）→ 合法间隔 "5m" → Esc 退出。
    const saved: Settings[] = []
    const { context, layers, toasts } = fakeContext({
      picks: ["features", "time", "enabled", "interval", "interval", undefined, undefined],
      prompts: ["20s", "5m"],
      onSettingsSet: (next) => {
        saved.push(next)
        return Promise.resolve(next)
      },
    })
    const cleanup = await plugin.setup(context)
    layers[0]?.commands?.[0]?.run()
    await Bun.sleep(20)

    // 开关写回一次；非法值被拦；合法值再写一次（5m -> 300 秒）。
    expect(saved).toHaveLength(2)
    expect(saved[0]?.time.enabled).toBe(false)
    expect(saved[1]?.time.intervalSeconds).toBe(300)
    const zh = resolveMessages("zh")
    const en = resolveMessages("en")
    expect([zh.menu.timeInvalidIntervalSeconds, en.menu.timeInvalidIntervalSeconds]).toContain(
      toasts[0]?.message,
    )

    await cleanup?.()
  })

  test("时间子菜单：模式切换与 steps 步数设置写回", async () => {
    const saved: Settings[] = []
    const { context, layers, toasts } = fakeContext({
      // 进功能分类 → time → 切换到 steps 模式 → 非法步数 "0" → 合法步数 "5" → Esc 退出。
      picks: ["features", "time", "mode", "steps", "interval", "interval", undefined, undefined],
      prompts: ["0", "5"],
      onSettingsSet: (next) => {
        saved.push(next)
        return Promise.resolve(next)
      },
    })
    const cleanup = await plugin.setup(context)
    layers[0]?.commands?.[0]?.run()
    await Bun.sleep(20)

    expect(saved[0]?.time.mode).toBe("steps")
    expect(saved[1]?.time.intervalSteps).toBe(5)
    const zh = resolveMessages("zh")
    const en = resolveMessages("en")
    expect([zh.menu.timeInvalidInterval, en.menu.timeInvalidInterval]).toContain(toasts[0]?.message)

    await cleanup?.()
  })

  test("时间子菜单：格式模板与时区写回；非法时区弹 toast", async () => {
    const saved: Settings[] = []
    const { context, layers, toasts } = fakeContext({
      // 进功能分类 → time → 格式输入 → 时区先输非法 → 再输合法 → Esc。
      picks: ["features", "time", "format", "timezone", "timezone", undefined, undefined],
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

  test("主菜单功能分类含外部编辑器项，子菜单四项齐全且支持编辑与立即打开", async () => {
    const saved: Settings[] = []
    let dispatchedCommand: string | undefined
    const { context, layers, selects, promptCalls } = fakeContext({
      picks: ["features", "editor", "command", "showHint", "openNow", undefined],
      prompts: ["code --wait"],
      onSettingsSet: (next) => {
        saved.push(next)
        return Promise.resolve(next)
      },
    })
    context.keymap.dispatch = (id: string) => {
      dispatchedCommand = id
    }

    const cleanup = await plugin.setup(context)
    layers[0]?.commands?.[0]?.run()
    await Bun.sleep(30)

    const zh = resolveMessages("zh")
    const en = resolveMessages("en")
    expect([zh.menu.editor, en.menu.editor]).toContain(
      selects[1]?.options.find((o) => o.value === "editor")?.title,
    )
    expect(selects[2]?.title).toMatch(/External editor|外部编辑器/)
    expect(selects[2]?.options.map((option) => option.value)).toEqual([
      "enabled",
      "command",
      "showHint",
      "openNow",
    ])

    // command 修改为 "code --wait"，showHint 切换
    expect(promptCalls).toHaveLength(1)
    expect(saved).toHaveLength(2)
    expect(saved[0]?.editor.command).toBe("code --wait")
    expect(saved[1]?.editor.showHint).toBe(false)
    // 立即打开派发 prompt.editor
    expect(dispatchedCommand).toBe("prompt.editor")

    await cleanup?.()
  })
})
