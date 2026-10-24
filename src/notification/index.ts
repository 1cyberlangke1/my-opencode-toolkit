import type { Plugin } from "@opencode/plugin"

import type { SessionRoles } from "../goal/session-role.ts"
import { resolveMessages, type Messages } from "../i18n/index.ts"
import { readEventSessionID } from "../shared/events.ts"
import { isSyntheticUserMessage } from "../shared/messages.ts"
import { loadSettings } from "../shared/settings-store.ts"
import type { Settings } from "../shared/settings.ts"
import { createSender, type NotificationSender } from "./send.ts"

/** 通知类型。 */
type NotificationKind = "completed" | "question" | "permission"

/** 同一会话完成通知的去重窗口（idle 与 execution.succeeded 会同时到达）。 */
const COMPLETE_DEDUPE_MS = 1000

/** 预览文本上限。 */
const PREVIEW_MAX = 200

/** 通知控制器。 */
export type Notifier = {
  /** 输入：会话事件；输出：无。预期：完成/权限事件按设置发系统通知。 */
  handle(event: { readonly type: string; readonly data: unknown }): Promise<void>
  /** 输入：工具名 + 会话；输出：无。预期：`question` 工具触发提问通知。 */
  handleToolBefore(input: { readonly tool: string; readonly sessionID: string }): Promise<void>
  /** 输入：无；输出：无。预期：清理去重缓存。 */
  dispose(): void
}

/** 输入：文本；输出：空白折叠成单行。 */
function collapse(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
}

/** 输入：文本 + 上限；输出：截断后的文本。 */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text
}

/**
 * 输入：插件上下文、存储、会话角色、可选发送函数与平台。
 * 输出：通知控制器。
 * 预期：发送失败静默；子代理在 onlyMainSession 下不通知；完成通知带消息预览。
 */
export function createNotifier(args: {
  readonly ctx: Plugin.Context
  readonly roles: SessionRoles
  /** 测试注入；生产路径从 JSONC 读取。 */
  readonly settings?: Settings
  readonly send?: NotificationSender
  readonly platform?: NodeJS.Platform
  readonly now?: () => number
}): Notifier {
  const { ctx, roles } = args
  const currentSettings = async (): Promise<Settings> => args.settings ?? loadSettings(ctx)
  const send = args.send ?? createSender(args.platform ?? process.platform)
  const clock = args.now ?? Date.now
  const lastCompleteAt = new Map<string, number>()

  /** 输入：设置里的语言；输出：`resolveMessages` 需要的 locale。 */
  const localeOf = (settings: Settings): string | undefined =>
    settings.lang === "auto" ? undefined : settings.lang

  /**
   * 输入：会话 ID + 文案。
   * 输出：`User: ...` / `Assistant: ...` 两行（可能为空）。
   * 预期：取最后一条用户文本与最后一条助手文本的最后一行；读取失败返回空。
   */
  const buildPreview = async (sessionID: string, messages: Messages): Promise<string[]> => {
    const history = await ctx.session.context({ sessionID }).catch(() => undefined)
    if (history === undefined) return []

    let userText = ""
    let assistantText = ""
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const message = history[index]
      if (message === undefined) continue
      if (userText === "" && message.type === "user" && !isSyntheticUserMessage(message)) {
        userText = collapse(message.text)
      }
      if (assistantText === "" && message.type === "assistant") {
        const text = message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
        const lines = collapse(text)
        assistantText = lines
      }
      if (userText !== "" && assistantText !== "") break
    }

    return [
      userText === "" ? "" : `${messages.notification.user}: ${truncate(userText, PREVIEW_MAX)}`,
      assistantText === "" ? "" : `${messages.notification.assistant}: ${truncate(assistantText, PREVIEW_MAX)}`,
    ].filter(Boolean)
  }

  /** 输入：会话 + 设置 + 通知类型；输出：无。预期：标题带会话名，发送失败静默。 */
  const notify = async (sessionID: string, settings: Settings, kind: NotificationKind): Promise<void> => {
    const messages = resolveMessages(localeOf(settings))
    const session = await ctx.session.get({ sessionID }).catch(() => undefined)
    const name = session?.title?.trim() ?? ""
    const title = name.length > 0 ? `${messages.notification.title} · ${name}` : messages.notification.title
    const detail = kind === "completed" ? await buildPreview(sessionID, messages) : []
    const body = [messages.notification[kind], ...detail].join("\n")

    try {
      await send(title, body)
    } catch {
      // 通知是尽力而为，失败不影响会话
    }
  }

  /** 输入：会话 ID + 设置；输出：是否应通知。预期：onlyMainSession 时跳过子代理。 */
  const allowed = async (sessionID: string, settings: Settings): Promise<boolean> => {
    if (!settings.notification.onlyMainSession) return true
    return !(await roles.isSubagent(sessionID))
  }

  /**
   * 输入：会话 ID。
   * 输出：该会话是否属于当前插件实例的 location。
   * 预期：插件按 location 各加载一份，系统通知是副作用；只让会话所属 location 的实例发送，
   *       避免同一完成/权限事件弹出多次。读不到会话时拒绝——宁可少发一次，也不能重复弹窗。
   */
  const inLocation = async (sessionID: string): Promise<boolean> => {
    const session = await ctx.session.get({ sessionID }).catch(() => undefined)
    return session?.location.directory === ctx.location.directory
  }

  return {
    async handle(event) {
      const sessionID = readEventSessionID(event)
      if (sessionID === undefined) return

      const settings = await currentSettings()
      if (!settings.enabled || !settings.notification.enabled) return

      if (event.type === "session.deleted") {
        lastCompleteAt.delete(sessionID)
        return
      }

      if (!(await inLocation(sessionID))) return
      if (!(await allowed(sessionID, settings))) return

      // idle 与 execution.succeeded 是同一轮结束的两个信号，合并成一次通知。
      if (event.type === "session.idle" || event.type === "session.execution.succeeded") {
        if (!settings.notification.onComplete) return
        const at = clock()
        const last = lastCompleteAt.get(sessionID)
        if (last !== undefined && at - last < COMPLETE_DEDUPE_MS) return
        lastCompleteAt.set(sessionID, at)
        await notify(sessionID, settings, "completed")
        return
      }

      if (event.type === "permission.asked") {
        if (!settings.notification.onPermission) return
        await notify(sessionID, settings, "permission")
      }
    },

    async handleToolBefore(input) {
      if (input.tool.toLowerCase() !== "question") return

      const settings = await currentSettings()
      if (!settings.enabled || !settings.notification.enabled || !settings.notification.onQuestion) return
      if (!(await inLocation(input.sessionID))) return
      if (!(await allowed(input.sessionID, settings))) return
      await notify(input.sessionID, settings, "question")
    },

    dispose() {
      lastCompleteAt.clear()
    },
  }
}
