import { testRender } from "@opentui/solid"
import { describe, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal } from "solid-js"

import { resolveMessages } from "../src/i18n/index.ts"
import { DEFAULT_SETTINGS, type Settings } from "../src/shared/settings.ts"
import { EditorHint } from "../src/tui/editor-hint.tsx"

/** 输入：可选的快捷键配置与派发监听器；输出：EditorHint 测试假上下文。 */
function fakeContext(options?: {
  readonly shortcut?: string
  readonly onDispatch?: (id: string) => void
}): Context {
  return {
    theme: {
      text: {
        base: "#ffffff",
        muted: "#888888",
      },
    },
    keymap: {
      shortcuts: () => (options?.shortcut !== undefined ? [options.shortcut] : ["ctrl+x e"]),
      dispatch: (id: string) => {
        options?.onDispatch?.(id)
      },
    },
  } as unknown as Context
}

describe("EditorHint", () => {
  test("enabled 与 showHint 为 true 且非 shell 模式时正常渲染快捷键与文案", async () => {
    const [settings] = createSignal<Settings>({
      ...DEFAULT_SETTINGS,
      editor: { enabled: true, command: "notepad", showHint: true },
    })
    const copy = () => resolveMessages("zh")
    const context = fakeContext({ shortcut: "ctrl+x e" })

    const app = await testRender(
      () => <EditorHint context={context} settings={settings} copy={copy} mode="normal" />,
      { width: 40, height: 1 },
    )
    const frame = await app.waitForFrame((text) => text.includes("ctrl+x e"))
    expect(frame).toContain("ctrl+x e")
    expect(frame).toContain(copy().footer.editorHint)

    await app.dispose()
  })

  test("enabled 为 false 时不渲染任何内容", async () => {
    const [settings] = createSignal<Settings>({
      ...DEFAULT_SETTINGS,
      editor: { enabled: false, command: "notepad", showHint: true },
    })
    const copy = () => resolveMessages("zh")
    const context = fakeContext({ shortcut: "ctrl+x e" })

    const app = await testRender(
      () => <EditorHint context={context} settings={settings} copy={copy} mode="normal" />,
      { width: 40, height: 1 },
    )
    const frame = await app.waitForFrame((text) => !text.includes("ctrl+x e"))
    expect(frame).not.toContain("ctrl+x e")
    expect(frame).not.toContain(copy().footer.editorHint)

    await app.dispose()
  })

  test("showHint 为 false 时不渲染任何内容", async () => {
    const [settings] = createSignal<Settings>({
      ...DEFAULT_SETTINGS,
      editor: { enabled: true, command: "notepad", showHint: false },
    })
    const copy = () => resolveMessages("zh")
    const context = fakeContext({ shortcut: "ctrl+x e" })

    const app = await testRender(
      () => <EditorHint context={context} settings={settings} copy={copy} mode="normal" />,
      { width: 40, height: 1 },
    )
    const frame = await app.waitForFrame((text) => !text.includes("ctrl+x e"))
    expect(frame).not.toContain("ctrl+x e")
    expect(frame).not.toContain(copy().footer.editorHint)

    await app.dispose()
  })

  test("shell 模式下隐藏外部编辑器提示", async () => {
    const [settings] = createSignal<Settings>({
      ...DEFAULT_SETTINGS,
      editor: { enabled: true, command: "notepad", showHint: true },
    })
    const copy = () => resolveMessages("zh")
    const context = fakeContext({ shortcut: "ctrl+x e" })

    const app = await testRender(
      () => <EditorHint context={context} settings={settings} copy={copy} mode="shell" />,
      { width: 40, height: 1 },
    )
    const frame = await app.waitForFrame((text) => !text.includes("ctrl+x e"))
    expect(frame).not.toContain("ctrl+x e")
    expect(frame).not.toContain(copy().footer.editorHint)

    await app.dispose()
  })

  test("快捷键为 none 时回退到 /editor 显示", async () => {
    const [settings] = createSignal<Settings>({
      ...DEFAULT_SETTINGS,
      editor: { enabled: true, command: "notepad", showHint: true },
    })
    const copy = () => resolveMessages("en")
    const context = fakeContext({ shortcut: "none" })

    const app = await testRender(
      () => <EditorHint context={context} settings={settings} copy={copy} mode="normal" />,
      { width: 40, height: 1 },
    )
    const frame = await app.waitForFrame((text) => text.includes("/editor"))
    expect(frame).toContain("/editor")
    expect(frame).toContain(copy().footer.editorHint)

    await app.dispose()
  })
})
