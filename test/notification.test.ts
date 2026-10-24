import type { Plugin } from "@opencode/plugin"
import { describe, expect, it } from "vitest"

import { createNotifier } from "../src/notification/index.ts"
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from "../src/shared/settings.ts"

const SESSION = "ses_test"

const mainRoles = {
  isSubagent: () => Promise.resolve(false),
  forget: () => undefined,
}

/** 输入：标题 + 可选历史消息 + location；输出：只实现 session 的假上下文。 */
function fakeCtx(
  title = "My Session",
  messages: unknown[] = [],
  location = "/test",
  sessionLocation = location,
): Plugin.Context {
  return {
    location: { directory: location },
    session: {
      get: () => Promise.resolve({ title, location: { directory: sessionLocation } }),
      context: () => Promise.resolve(messages),
    },
  } as unknown as Plugin.Context
}

/** 输入：设置；输出：规范化设置。默认固定英文，避免跟随系统语言。 */
function makeStore(settings: Settings = { ...DEFAULT_SETTINGS, lang: "en" }): Settings {
  return normalizeSettings(settings)
}

/** 输入：无；输出：记录发送内容的数组与发送函数。 */
function makeSender(): { sent: [string, string][]; send: (title: string, message: string) => Promise<void> } {
  const sent: [string, string][] = []
  return {
    sent,
    send: (title, message) => {
      sent.push([title, message])
      return Promise.resolve()
    },
  }
}

describe("notifier", () => {
  it("idle 发完成通知，标题带会话名", async () => {
    const { sent, send } = makeSender()
    const notifier = createNotifier({ ctx: fakeCtx(), settings: makeStore(), roles: mainRoles, send })

    await notifier.handle({ type: "session.idle", data: { sessionID: SESSION } })

    expect(sent).toEqual([["OpenCode · My Session", "Task completed"]])
  })

  it("同一会话 1 秒内只通知一次", async () => {
    const { sent, send } = makeSender()
    let now = 1000
    const notifier = createNotifier({ ctx: fakeCtx(), settings: makeStore(), roles: mainRoles, send, now: () => now })

    await notifier.handle({ type: "session.idle", data: { sessionID: SESSION } })
    now += 500
    await notifier.handle({ type: "session.idle", data: { sessionID: SESSION } })
    expect(sent).toHaveLength(1)

    now += 1000
    await notifier.handle({ type: "session.idle", data: { sessionID: SESSION } })
    expect(sent).toHaveLength(2)
  })

  it("idle 与 execution.succeeded 合并成一次通知", async () => {
    const { sent, send } = makeSender()
    const notifier = createNotifier({ ctx: fakeCtx(), settings: makeStore(), roles: mainRoles, send })

    await notifier.handle({ type: "session.execution.succeeded", data: { sessionID: SESSION } })
    await notifier.handle({ type: "session.idle", data: { sessionID: SESSION } })
    expect(sent).toHaveLength(1)
  })

  it("只让会话所属 location 的实例发通知", async () => {
    const first = makeSender()
    const second = makeSender()
    const owner = createNotifier({
      ctx: fakeCtx("My Session", [], "/project-a", "/project-a"),
      settings: makeStore(),
      roles: mainRoles,
      send: first.send,
    })
    const other = createNotifier({
      ctx: fakeCtx("My Session", [], "/project-b", "/project-a"),
      settings: makeStore(),
      roles: mainRoles,
      send: second.send,
    })

    await owner.handle({ type: "session.idle", data: { sessionID: SESSION } })
    await other.handle({ type: "session.idle", data: { sessionID: SESSION } })

    expect(first.sent).toHaveLength(1)
    expect(second.sent).toHaveLength(0)
  })

  it("完成通知带最后一条用户与助手文本", async () => {
    const { sent, send } = makeSender()
    const messages = [
      { type: "user", text: "把 bug 修一下" },
      { type: "assistant", content: [{ type: "text", text: "修好了" }] },
    ]
    const notifier = createNotifier({ ctx: fakeCtx("会话", messages), settings: makeStore(), roles: mainRoles, send })

    await notifier.handle({ type: "session.idle", data: { sessionID: SESSION } })

    const body = sent[0]?.[1] ?? ""
    expect(body).toContain("Task completed")
    expect(body).toContain("User: 把 bug 修一下")
    expect(body).toContain("Assistant: 修好了")
  })

  it("完成预览跳过插件注入的续作消息", async () => {
    const { sent, send } = makeSender()
    const messages = [
      { type: "user", text: "真实问题" },
      { type: "assistant", content: [{ type: "text", text: "回答" }] },
      {
        type: "user",
        text: "Continue working toward the active thread goal.",
        metadata: { goalContinuation: true },
      },
    ]
    const notifier = createNotifier({ ctx: fakeCtx("会话", messages), settings: makeStore(), roles: mainRoles, send })

    await notifier.handle({ type: "session.idle", data: { sessionID: SESSION } })

    const body = sent[0]?.[1] ?? ""
    expect(body).toContain("User: 真实问题")
    expect(body).not.toContain("Continue working")
  })

  it("通知总开关关闭时不发", async () => {
    const { sent, send } = makeSender()
    const settings: Settings = { ...DEFAULT_SETTINGS, notification: { ...DEFAULT_SETTINGS.notification, enabled: false } }
    const notifier = createNotifier({ ctx: fakeCtx(), settings: makeStore(settings), roles: mainRoles, send })

    await notifier.handle({ type: "session.idle", data: { sessionID: SESSION } })
    expect(sent).toHaveLength(0)
  })

  it("onComplete 关闭时不发完成通知", async () => {
    const { sent, send } = makeSender()
    const settings: Settings = { ...DEFAULT_SETTINGS, notification: { ...DEFAULT_SETTINGS.notification, onComplete: false } }
    const notifier = createNotifier({ ctx: fakeCtx(), settings: makeStore(settings), roles: mainRoles, send })

    await notifier.handle({ type: "session.idle", data: { sessionID: SESSION } })
    expect(sent).toHaveLength(0)
  })

  it("onlyMainSession 时跳过子代理", async () => {
    const { sent, send } = makeSender()
    const notifier = createNotifier({
      ctx: fakeCtx(),
      settings: makeStore(),
      roles: { isSubagent: () => Promise.resolve(true), forget: () => undefined },
      send,
    })

    await notifier.handle({ type: "session.idle", data: { sessionID: SESSION } })
    expect(sent).toHaveLength(0)
  })

  it("permission.asked 发权限通知", async () => {
    const { sent, send } = makeSender()
    const notifier = createNotifier({ ctx: fakeCtx(), settings: makeStore(), roles: mainRoles, send })

    await notifier.handle({ type: "permission.asked", data: { sessionID: SESSION } })
    expect(sent[0]?.[1]).toBe("Permission required")
  })

  it("onPermission 关闭时不发权限通知", async () => {
    const { sent, send } = makeSender()
    const settings: Settings = { ...DEFAULT_SETTINGS, notification: { ...DEFAULT_SETTINGS.notification, onPermission: false } }
    const notifier = createNotifier({ ctx: fakeCtx(), settings: makeStore(settings), roles: mainRoles, send })

    await notifier.handle({ type: "permission.asked", data: { sessionID: SESSION } })
    expect(sent).toHaveLength(0)
  })

  it("question 工具触发提问通知", async () => {
    const { sent, send } = makeSender()
    const notifier = createNotifier({ ctx: fakeCtx(), settings: makeStore(), roles: mainRoles, send })

    await notifier.handleToolBefore({ tool: "question", sessionID: SESSION })
    expect(sent[0]?.[1]).toBe("Agent needs input")
  })

  it("其他工具不触发", async () => {
    const { sent, send } = makeSender()
    const notifier = createNotifier({ ctx: fakeCtx(), settings: makeStore(), roles: mainRoles, send })

    await notifier.handleToolBefore({ tool: "read", sessionID: SESSION })
    expect(sent).toHaveLength(0)
  })

  it("中文设置用中文文案", async () => {
    const { sent, send } = makeSender()
    const settings: Settings = { ...DEFAULT_SETTINGS, lang: "zh" }
    const notifier = createNotifier({ ctx: fakeCtx("会话"), settings: makeStore(settings), roles: mainRoles, send })

    await notifier.handle({ type: "session.idle", data: { sessionID: SESSION } })
    expect(sent).toEqual([["OpenCode · 会话", "任务完成"]])
  })

  it("发送失败不影响后续事件", async () => {
    const notifier = createNotifier({
      ctx: fakeCtx(),
      settings: makeStore(),
      roles: mainRoles,
      send: () => Promise.reject(new Error("boom")),
    })

    await expect(notifier.handle({ type: "session.idle", data: { sessionID: SESSION } })).resolves.toBeUndefined()
  })

  it("读不到会话时不发通知，避免多实例重复弹窗", async () => {
    const { sent, send } = makeSender()
    const ctx = {
      location: { directory: "/test" },
      session: {
        get: () => Promise.resolve(undefined),
        context: () => Promise.resolve([]),
      },
    } as unknown as Plugin.Context
    const notifier = createNotifier({ ctx, settings: makeStore(), roles: mainRoles, send })

    await notifier.handle({ type: "session.idle", data: { sessionID: SESSION } })

    expect(sent).toHaveLength(0)
  })
})
