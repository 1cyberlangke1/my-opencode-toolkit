import { describe, expect, test } from "bun:test"
import type { Context, DialogAlertOptions } from "@opencode/plugin/tui/context"

import { resolveMessages } from "../src/i18n/index.ts"
import { DEFAULT_SETTINGS, type Settings } from "../src/shared/settings.ts"
import { PLUGIN_PACKAGE, PLUGIN_VERSION } from "../src/shared/version.ts"
import {
  updateCommandLine,
  type UpdateCheckResult,
  type UpdateProgress,
  type UpdateStartResult,
} from "../src/shared/update.ts"
import plugin, { createUpdateMenu, type UpdateDeps } from "../src/tui/main.tsx"

/** 一次对话框调用。 */
type SelectOption = {
  readonly title: string
  readonly value: unknown
  readonly footer?: string
  readonly description?: string
  readonly disabled?: boolean
}

type SelectCall = {
  readonly title: string
  readonly options: readonly SelectOption[]
}

type ToastCall = {
  readonly title?: string
  readonly message: string
  readonly variant?: string
  readonly duration?: number
}

type RegisteredLayer = {
  readonly commands?: readonly {
    readonly slash?: { readonly name: string }
    readonly run: () => void | Promise<void>
  }[]
}

/** 输入：色值与选项；输出：只实现菜单测试依赖的假 TUI 上下文。 */
function menuContext(picks: readonly (string | undefined)[]): {
  readonly context: Context
  readonly selects: SelectCall[]
  readonly toasts: ToastCall[]
  readonly alerts: DialogAlertOptions[]
} {
  const selects: SelectCall[] = []
  const toasts: ToastCall[] = []
  const alerts: DialogAlertOptions[] = []
  let index = 0
  const context = {
    ui: {
      dialog: {
        alert: (call: DialogAlertOptions) => {
          alerts.push(call)
          return Promise.resolve()
        },
        select: (call: SelectCall) => {
          selects.push(call)
          return Promise.resolve(picks[index++])
        },
      },
      toast: {
        show: (call: ToastCall) => {
          toasts.push(call)
        },
      },
    },
  } as unknown as Context
  return { context, selects, toasts, alerts }
}

/** 输入：菜单选择序列与语言；输出：setup 依赖的假上下文与注册项。 */
function setupContext(options: {
  readonly picks: readonly (string | undefined)[]
  readonly lang: "zh" | "en"
}): {
  readonly context: Context
  readonly layers: RegisteredLayer[]
  readonly selects: SelectCall[]
} {
  const layers: RegisteredLayer[] = []
  const selects: SelectCall[] = []
  let index = 0
  const initial: Settings = { ...DEFAULT_SETTINGS, lang: options.lang }
  const context = {
    client: {
      rpc: () => ({
        settingsGet: () => Promise.resolve(initial),
        settingsSet: (next: Settings) => Promise.resolve(next),
        panelGet: () =>
          Promise.resolve({
            goal: null,
            loops: [],
            jobs: [],
            stats: { steps: 0, input: 0, output: 0, cached: 0, hitRate: 0, subagents: 0, lastTool: null, tools: [] },
            subagents: [],
          }),
        events: { on: () => () => undefined },
      }),
    },
    ui: {
      dialog: {
        select: (call: SelectCall) => {
          selects.push(call)
          return Promise.resolve(options.picks[index++])
        },
      },
      toast: { show: () => undefined },
      slot: () => () => undefined,
    },
    keymap: {
      layer: (factory: () => RegisteredLayer) => {
        layers.push(factory())
      },
    },
    data: {
      listen: () => () => undefined,
      session: { get: () => undefined },
    },
  } as unknown as Context
  return { context, layers, selects }
}

/** 输入：检查结果与真实运行函数；输出：菜单依赖。 */
function depsFor(
  check: UpdateCheckResult | (() => Promise<UpdateCheckResult>),
  run: UpdateDeps["run"] = () => Promise.resolve({ ok: true, command: updateCommandLine() }),
): UpdateDeps {
  return {
    check: typeof check === "function" ? check : () => Promise.resolve(check),
    run,
  }
}

const NEW_VERSION: UpdateCheckResult = {
  kind: "update-available",
  currentVersion: PLUGIN_VERSION,
  latestVersion: "9.9.9",
}

const UP_TO_DATE: UpdateCheckResult = {
  kind: "up-to-date",
  currentVersion: PLUGIN_VERSION,
  latestVersion: PLUGIN_VERSION,
}

describe("更新入口菜单", () => {
  test("英文主菜单最后一项是更新入口，顺序与 footer 正确", async () => {
    const text = resolveMessages("en")
    const { context, layers, selects } = setupContext({ picks: [undefined], lang: "en" })
    const cleanup = await plugin.setup(context)

    layers[0]?.commands?.[0]?.run()
    await Bun.sleep(20)

    const options = selects[0]?.options ?? []
    expect(options.map((option) => option.value)).toEqual([
      "language",
      "goal",
      "scheduling",
      "sidebar",
      "contextStats",
      "notifications",
      "update",
    ])
    expect(options.at(-1)).toMatchObject({
      title: text.menu.checkUpdates,
      value: "update",
      footer: `v${PLUGIN_VERSION}`,
    })

    await cleanup?.()
  })

  test("中文主菜单最后一项是更新入口", async () => {
    const text = resolveMessages("zh")
    const { context, layers, selects } = setupContext({ picks: [undefined], lang: "zh" })
    const cleanup = await plugin.setup(context)

    layers[0]?.commands?.[0]?.run()
    await Bun.sleep(20)

    const last = selects[0]?.options.at(-1)
    expect(last).toMatchObject({
      title: text.menu.checkUpdates,
      value: "update",
      footer: `v${PLUGIN_VERSION}`,
    })

    await cleanup?.()
  })

  test("主菜单选择更新进入更新菜单而不是其它分支", async () => {
    const text = resolveMessages("en")
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() => Promise.reject(new Error("offline"))) as typeof fetch
    try {
      const { context, layers, selects } = setupContext({
        picks: ["update", undefined, undefined],
        lang: "en",
      })
      const cleanup = await plugin.setup(context)

      layers[0]?.commands?.[0]?.run()
      await Bun.sleep(20)

      expect(selects[1]?.title).toBe(text.update.title)

      await cleanup?.()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("发现新版本时展示结构、顺序、禁用项、footer 与动作", async () => {
    const text = resolveMessages("en")
    let starts = 0
    const { context, selects } = menuContext(["close"])
    const deps = depsFor(NEW_VERSION, () => {
      starts += 1
      return Promise.resolve({ ok: true, command: updateCommandLine() })
    })

    await createUpdateMenu(context, () => resolveMessages("en"), deps)()

    const call = selects[0]
    expect(call?.title).toBe(text.update.title)
    expect(call?.options.map((option) => option.value)).toEqual([
      "current",
      "latest",
      "status",
      "update",
      "again",
      "close",
    ])
    expect(call?.options.find((option) => option.value === "current")).toMatchObject({
      title: text.update.current,
      footer: `v${PLUGIN_VERSION}`,
    })
    expect(call?.options.find((option) => option.value === "latest")).toMatchObject({
      title: text.update.latest,
      footer: "v9.9.9",
    })
    expect(call?.options.find((option) => option.value === "status")).toMatchObject({
      title: text.update.available,
    })
    expect(call?.options.filter((option) => ["current", "latest", "status"].includes(String(option.value))).every(
      (option) => option.disabled !== true,
    )).toBe(true)
    expect(call?.options.find((option) => option.value === "update")).toMatchObject({
      title: text.update.updateNow,
    })
    expect(call?.options.find((option) => option.value === "again")?.title).toBe(text.update.checkAgain)
    expect(call?.options.find((option) => option.value === "close")?.title).toBe(text.update.close)
    expect(starts).toBe(0)
  })

  test("已是最新时展示 up-to-date 状态且不提供立即更新", async () => {
    const text = resolveMessages("en")
    const { context, selects } = menuContext(["close"])
    const deps = depsFor(UP_TO_DATE)

    await createUpdateMenu(context, () => resolveMessages("en"), deps)()

    const call = selects[0]
    expect(call?.title).toBe(text.update.title)
    expect(call?.options.map((option) => option.value)).toEqual([
      "current",
      "latest",
      "status",
      "again",
      "close",
    ])
    expect(call?.options.find((option) => option.value === "status")).toMatchObject({
      title: text.update.upToDate,
    })
    expect(call?.options.find((option) => option.value === "latest")?.footer).toBe(`v${PLUGIN_VERSION}`)
    expect(call?.options.map((option) => option.value)).not.toContain("update")
  })

  test("无法检查更新时展示失败态且不提供立即更新", async () => {
    const text = resolveMessages("zh")
    const { context, selects } = menuContext(["close"])
    const deps = depsFor({ kind: "failed", reason: "network" })

    await createUpdateMenu(context, () => resolveMessages("zh"), deps)()

    const call = selects[0]
    expect(call?.title).toBe(text.update.title)
    expect(call?.options.map((option) => option.value)).toEqual([
      "current",
      "latest",
      "status",
      "again",
      "close",
    ])
    expect(call?.options.find((option) => option.value === "status")).toMatchObject({
      title: text.update.failed,
    })
    expect(call?.options.find((option) => option.value === "latest")?.footer).toBe("—")
    expect(call?.options.find((option) => option.value === "again")?.title).toBe(text.update.checkAgain)
    expect(call?.options.find((option) => option.value === "close")?.title).toBe(text.update.close)
    expect(call?.options.map((option) => option.value)).not.toContain("update")
  })

  test("检查函数意外 reject 时兜底为失败态，不产生未处理拒绝", async () => {
    const text = resolveMessages("en")
    const { context, selects } = menuContext(["close"])
    const deps = depsFor(() => Promise.reject(new Error("boom")))

    await expect(createUpdateMenu(context, () => resolveMessages("en"), deps)()).resolves.toBeUndefined()

    const call = selects[0]
    expect(call?.title).toBe(text.update.title)
    expect(call?.options.find((option) => option.value === "status")?.title).toBe(text.update.failed)
    expect(call?.options.map((option) => option.value)).not.toContain("update")
  })

  test("重新检查会再次请求 registry", async () => {
    const text = resolveMessages("en")
    let checks = 0
    const { context, selects } = menuContext(["again", "close"])
    const deps = depsFor(async () => {
      checks += 1
      return NEW_VERSION
    })

    await createUpdateMenu(context, () => resolveMessages("en"), deps)()

    expect(checks).toBe(2)
    expect(selects).toHaveLength(2)
    expect(selects.map((call) => call.title)).toEqual([text.update.title, text.update.title])
  })

  test("更新期间显示真实进度，完成后再提示重启", async () => {
    const text = resolveMessages("en")
    let report: UpdateProgress | undefined
    let finish: ((result: UpdateStartResult) => void) | undefined
    let started: (() => void) | undefined
    const runStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const { context, toasts, alerts } = menuContext(["update"])
    const deps = depsFor(
      NEW_VERSION,
      (onProgress) =>
        new Promise((resolve) => {
          report = onProgress
          finish = resolve
          started?.()
        }),
    )

    const running = createUpdateMenu(context, () => resolveMessages("en"), deps)()
    await runStarted

    expect(toasts[0]).toMatchObject({
      title: text.update.title,
      message: text.update.running,
      variant: "info",
    })
    expect(toasts[0]?.duration).toBeGreaterThan(5_000)

    report?.("Downloading my-opencode-toolkit")
    expect(toasts[1]).toMatchObject({
      title: text.update.title,
      message: "Downloading my-opencode-toolkit",
      variant: "info",
    })
    expect(toasts[1]?.duration).toBeGreaterThan(5_000)

    finish?.({ ok: true, command: updateCommandLine() })
    await running

    expect(alerts).toEqual([
      {
        title: text.update.title,
        message: text.update.succeeded,
      },
    ])
  })

  test("更新失败时提示失败并给出可执行命令", async () => {
    const text = resolveMessages("en")
    const { context, toasts, alerts } = menuContext(["update"])
    const deps = depsFor(NEW_VERSION, async (onProgress) => {
      onProgress("npm exited with code 1")
      return { ok: false, command: updateCommandLine() }
    })

    await createUpdateMenu(context, () => resolveMessages("en"), deps)()

    expect(toasts[1]?.message).toBe("npm exited with code 1")
    expect(alerts[0]?.title).toBe(text.update.title)
    expect(alerts[0]?.message).toBe(`${text.update.runFailed} ${updateCommandLine()}`)
  })
})
