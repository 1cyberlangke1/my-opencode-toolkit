import type { Plugin } from "@opencode/plugin"

import type { SessionRoles } from "../goal/session-role.ts"
import { resolveMessages } from "../i18n/index.ts"
import { asRecord, type JsonStore } from "../shared/json.ts"
import { loadSettings } from "../shared/settings-store.ts"
import type { Settings } from "../shared/settings.ts"
import { createSender, type NotificationSender } from "./send.ts"

/** 通知类型。 */
type NotificationKind = "completed" | "question" | "permission"

/** 同一会话 idle 去重窗口。 */
const IDLE_DEDUPE_MS = 1000

/** 通知控制器。 */
export type Notifier = {
  /** 输入：会话事件；输出：无。预期：完成/权限事件按设置发系统通知。 */
  handle(event: { readonly type: string; readonly data: unknown }): Promise<void>
  /** 输入：工具名 + 会话；输出：无。预期：`question` 工具触发提问通知。 */
  handleToolBefore(input: { readonly tool: string; readonly sessionID: string }): Promise<void>
  /** 输入：无；输出：无。预期：清理去重缓存。 */
  dispose(): void
}

/**
 * 输入：插件上下文、存储、会话角色、可选发送函数与平台。
 * 输出：通知控制器。
 * 预期：所有发送失败都吞掉；子代理在 onlyMainSession 下不通知。
 */
export function createNotifier(args: {
  readonly ctx: Plugin.Context
  readonly store: JsonStore
  readonly roles: SessionRoles
  readonly send?: NotificationSender
  readonly platform?: NodeJS.Platform
  readonly now?: () => number
}): Notifier {
  const { ctx, store, roles } = args
  const send = args.send ?? createSender(args.platform ?? process.platform)
  const clock = args.now ?? Date.now
  const lastIdleAt = new Map<string, number>()

  /** 输入：设置里的语言；输出：`resolveMessages` 需要的 locale。 */
  const localeOf = (settings: Settings): string | undefined =>
    settings.lang === "auto" ? undefined : settings.lang

  /** 输入：会话 + 设置 + 通知类型；输出：无。预期：标题带会话名，发送失败静默。 */
  const notify = async (sessionID: string, settings: Settings, kind: NotificationKind): Promise<void> => {
    const messages = resolveMessages(localeOf(settings))
    const session = await ctx.session.get({ sessionID }).catch(() => undefined)
    const name = session?.title?.trim() ?? ""
    const title = name.length > 0 ? `${messages.notification.title} · ${name}` : messages.notification.title
    try {
      await send(title, messages.notification[kind])
    } catch {
      // 通知是尽力而为，失败不影响会话
    }
  }

  /** 输入：会话 ID + 设置；输出：是否应通知。预期：onlyMainSession 时跳过子代理。 */
  const allowed = async (sessionID: string, settings: Settings): Promise<boolean> => {
    if (!settings.notification.onlyMainSession) return true
    return !(await roles.isSubagent(sessionID))
  }

  return {
    async handle(event) {
      const data = asRecord(event.data)
      const sessionID = data?.["sessionID"]
      if (typeof sessionID !== "string" || sessionID.length === 0) return

      const settings = await loadSettings(store)
      if (!settings.enabled || !settings.notification.enabled) return

      if (event.type === "session.deleted") {
        lastIdleAt.delete(sessionID)
        return
      }

      if (!(await allowed(sessionID, settings))) return

      if (event.type === "session.idle") {
        if (!settings.notification.onComplete) return
        const at = clock()
        const last = lastIdleAt.get(sessionID)
        if (last !== undefined && at - last < IDLE_DEDUPE_MS) return
        lastIdleAt.set(sessionID, at)
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

      const settings = await loadSettings(store)
      if (!settings.enabled || !settings.notification.enabled || !settings.notification.onQuestion) return
      if (!(await allowed(input.sessionID, settings))) return
      await notify(input.sessionID, settings, "question")
    },

    dispose() {
      lastIdleAt.clear()
    },
  }
}
