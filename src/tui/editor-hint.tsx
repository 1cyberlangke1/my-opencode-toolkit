import type { Context } from "@opencode/plugin/tui/context"
import { createSignal, Show } from "solid-js"

import type { Messages } from "../i18n/index.ts"
import type { Settings } from "../shared/settings.ts"

/**
 * 输入：TUI 上下文、设置访问器、文案访问器、当前 prompt 模式。
 * 输出：输入框底栏左侧的外部编辑器快捷键提示。
 * 预期：未启用或关闭提示时隐藏；shell 模式隐藏；点击时触发 prompt.editor。
 */
export function EditorHint(props: {
  readonly context: Context
  readonly settings: () => Settings
  readonly copy: () => Messages
  readonly mode?: string
}) {
  const [hovered, setHovered] = createSignal(false)
  const theme = props.context.theme
  const base = () => theme.text.base
  const muted = () => theme.text.muted

  /** 输入：无；输出：当前绑定的外部编辑器快捷键文本。预期：读取合法快捷键，未指定时为默认快捷键。 */
  const shortcut = (): string => {
    const keys = props.context.keymap.shortcuts("prompt.editor")
    const first = keys[0]
    if (first !== undefined && first.length > 0 && first !== "none") return first
    if (first === "none") return "/editor"
    return "ctrl+x e"
  }

  /** 输入：无；输出：无。预期：点击底栏提示直接派发唤起外部编辑器命令。 */
  const handleClick = (): void => {
    props.context.keymap.dispatch("prompt.editor")
  }

  return (
    <Show when={props.settings().editor.enabled && props.settings().editor.showHint && props.mode !== "shell"}>
      <box
        flexShrink={0}
        onMouseOver={() => setHovered(true)}
        onMouseOut={() => setHovered(false)}
        onMouseUp={handleClick}
      >
        <text fg={hovered() ? base() : muted()} wrapMode="none">
          <span style={{ fg: base() }}>{shortcut()}</span> {props.copy().footer.editorHint}
        </text>
      </box>
    </Show>
  )
}
