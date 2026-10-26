import { describe, expect, test } from "bun:test"
import type {
  Context,
  DialogAlertOptions,
  DialogConfirmOptions,
} from "@opencode/plugin/tui/context"
import { RGBA } from "@opentui/core"

import { resolveMessages } from "../src/i18n/index.ts"
import { DEFAULT_SETTINGS, type Settings } from "../src/shared/settings.ts"
import { PLUGIN_VERSION } from "../src/shared/version.ts"
import {
  updateCommandLine,
  type UpdateCheckResult,
  type UpdateProgress,
  type UpdateStartResult,
} from "../src/shared/update.ts"
import plugin, { createUpdateMenu, type UpdateDeps } from "../src/tui/main.tsx"

type SelectOption = {
  readonly title: string
  readonly value: unknown
  readonly footer?: string
  readonly footerColor?: RGBA
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

type UpdateCapture = {
  readonly picks: (string | undefined)[]
  readonly confirmAnswers: (boolean | undefined)[]
  readonly selects: SelectCall[]
  readonly confirms: DialogConfirmOptions[]
  readonly alerts: DialogAlertOptions[]
  readonly toasts: ToastCall[]
  shows: number
  clears: number
}

const COLORS = {
  warning: RGBA.fromInts(255, 193, 7, 255),
  error: RGBA.fromInts(255, 0, 0, 255),
}

/** 输入：状态判定；输出：是否在超时前满足。预期：按状态推进，不依赖固定等待。 */
async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < 2_000) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error("condition was not met")
}

/** 输入：选择与确认序列；输出：更新菜单测试上下文与捕获对象。 */
function menuContext(
  picks: readonly (string | undefined)[],
  confirmAnswers: readonly (boolean | undefined)[] = [],
): { readonly context: Context; readonly captured: UpdateCapture } {
  const captured: UpdateCapture = {
    picks: [...picks],
    confirmAnswers: [...confirmAnswers],
    selects: [],
    confirms: [],
    alerts: [],
    toasts: [],
    shows: 0,
    clears: 0,
  }
  const context = {
    theme: {
      text: {
        base: COLORS.warning,
        muted: COLORS.error,
        feedback: {
          warning: { base: COLORS.warning },
          error: { base: COLORS.error },
        },
      },
    },
    ui: {
      dialog: {
        alert: (call: DialogAlertOptions) => {
          captured.alerts.push(call)
          return Promise.resolve()
        },
        confirm: (call: DialogConfirmOptions) => {
          captured.confirms.push(call)
          return Promise.resolve(captured.confirmAnswers.shift())
        },
        select: (call: SelectCall) => {
          captured.selects.push(call)
          return Promise.resolve(captured.picks.shift())
        },
        show: () => {
          captured.shows += 1
        },
        clear: () => {
          captured.clears += 1
        },
      },
      toast: {
        show: (call: ToastCall) => {
          captured.toasts.push(call)
        },
      },
    },
  } as unknown as Context
  return { context, captured }
}

/** 输入：菜单选择、确认序列与语言；输出：真实 TUI setup 所需的假上下文。 */
function setupContext(options: {
  readonly picks: readonly (string | undefined)[]
  readonly confirms?: readonly (boolean | undefined)[]
  readonly lang: "zh" | "en"
}): {
  readonly context: Context
  readonly layers: RegisteredLayer[]
  readonly captured: UpdateCapture
} {
  const layers: RegisteredLayer[] = []
  const captured: UpdateCapture = {
    picks: [...options.picks],
    confirmAnswers: [...(options.confirms ?? [])],
    selects: [],
    confirms: [],
    alerts: [],
    toasts: [],
    shows: 0,
    clears: 0,
  }
  const initial: Settings = { ...DEFAULT_SETTINGS, lang: options.lang }
  const context = {
    theme: {
      text: {
        base: COLORS.warning,
        muted: COLORS.error,
        feedback: {
          warning: { base: COLORS.warning },
          error: { base: COLORS.error },
        },
      },
    },
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
        alert: (call: DialogAlertOptions) => {
          captured.alerts.push(call)
          return Promise.resolve()
        },
        confirm: (call: DialogConfirmOptions) => {
          captured.confirms.push(call)
          return Promise.resolve(captured.confirmAnswers.shift())
        },
        select: (call: SelectCall) => {
          captured.selects.push(call)
          return Promise.resolve(captured.picks.shift())
        },
        show: () => {
          captured.shows += 1
        },
        clear: () => {
          captured.clears += 1
        },
      },
      toast: {
        show: (call: ToastCall) => {
          captured.toasts.push(call)
        },
      },
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
  return { context, layers, captured }
}

/** 输入：检查结果与运行函数；输出：更新依赖。 */
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

describe("更新入口", () => {
  test("主菜单标题直接显示当前版本", async () => {
    const text = resolveMessages("en")
    const { context, layers, captured } = setupContext({ picks: [undefined], lang: "en" })
    const cleanup = await plugin.setup(context)

    layers[0]?.commands?.[0]?.run()
    await waitFor(() => captured.selects.length >= 1)

    expect(captured.selects[0]?.options.at(-1)).toMatchObject({
      title: `${text.menu.checkUpdates} v${PLUGIN_VERSION}`,
      value: "update",
    })
    await cleanup?.()
  })

  test("新版确认框显示版本，取消后主菜单保留星标与 warning 色", async () => {
    const text = resolveMessages("zh")
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() =>
      Promise.resolve(Response.json({ version: "9.9.9" }))) as typeof fetch
    try {
      const { context, layers, captured } = setupContext({
        picks: ["update", undefined],
        confirms: [false],
        lang: "zh",
      })
      const cleanup = await plugin.setup(context)

      layers[0]?.commands?.[0]?.run()
      await waitFor(() => captured.selects.length >= 2 && captured.confirms.length >= 1)

      expect(captured.confirms[0]).toMatchObject({
        title: text.update.title,
        message: text.update.confirm(PLUGIN_VERSION, "9.9.9"),
      })
      expect(captured.selects[1]?.options.at(-1)).toMatchObject({
        title: `${text.menu.checkUpdates} v${PLUGIN_VERSION} *`,
        footer: text.update.latestFooter("9.9.9"),
        footerColor: COLORS.warning,
      })
      await cleanup?.()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("确认后原地显示进度，成功时关闭进度框并发成功 toast", async () => {
    const text = resolveMessages("en")
    let report: UpdateProgress | undefined
    let finish: ((result: UpdateStartResult) => void) | undefined
    let started: (() => void) | undefined
    const runStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const { context, captured } = menuContext([], [true])
    const deps = depsFor(
      NEW_VERSION,
      (onProgress) =>
        new Promise((resolve) => {
          report = onProgress
          finish = resolve
          started?.()
        }),
    )

    const running = createUpdateMenu(context, () => resolveMessages("en"), { deps })()
    await runStarted

    expect(captured.confirms[0]?.message).toBe(text.update.confirm(PLUGIN_VERSION, "9.9.9"))
    expect(captured.shows).toBe(1)
    report?.("Downloading my-opencode-toolkit")
    finish?.({ ok: true, command: updateCommandLine() })
    await running

    expect(captured.toasts[0]).toMatchObject({
      title: text.update.title,
      message: text.update.succeeded,
      variant: "success",
    })
    expect(captured.clears).toBe(1)
    expect(captured.alerts).toHaveLength(0)
  })

  test("更新失败时以 error toast 给出可执行命令", async () => {
    const text = resolveMessages("en")
    const { context, captured } = menuContext([], [true])
    const deps = depsFor(NEW_VERSION, async (onProgress) => {
      onProgress("npm exited with code 1")
      return { ok: false, command: updateCommandLine() }
    })

    await createUpdateMenu(context, () => resolveMessages("en"), { deps })()

    expect(captured.toasts[0]).toMatchObject({
      title: text.update.title,
      message: `${text.update.runFailed} ${updateCommandLine()}`,
      variant: "error",
    })
    expect(captured.clears).toBe(1)
    expect(captured.alerts).toHaveLength(0)
  })

  test("已是最新版本时直接 alert，不弹确认也不运行更新", async () => {
    const text = resolveMessages("zh")
    let starts = 0
    const { context, captured } = menuContext([])
    const deps = depsFor(UP_TO_DATE, () => {
      starts += 1
      return Promise.resolve({ ok: true, command: updateCommandLine() })
    })

    await createUpdateMenu(context, () => resolveMessages("zh"), { deps })()

    expect(captured.alerts).toEqual([{ title: text.update.title, message: text.update.upToDate }])
    expect(captured.confirms).toHaveLength(0)
    expect(starts).toBe(0)
  })

  test("检查函数 reject 时兜底为失败 alert", async () => {
    const text = resolveMessages("en")
    const { context, captured } = menuContext([])
    const deps = depsFor(() => Promise.reject(new Error("offline")))

    await expect(
      createUpdateMenu(context, () => resolveMessages("en"), { deps })(),
    ).resolves.toBe(false)

    expect(captured.alerts).toEqual([{ title: text.update.title, message: text.update.failed }])
  })
})
