import type { Plugin } from "@opencode/plugin"
import { describe, expect, it, vi } from "vitest"

import { MemoryStore } from "./helpers.ts"
import { createSessionRoles } from "../src/goal/session-role.ts"
import { ownsSession } from "../src/shared/session.ts"
import { formatTime, formatTimeSafe, isValidTimezone, createTimePulse } from "../src/time/index.ts"

/** 构造一个 step.ended 插件事件。 */
function stepEvent(sessionID: string) {
  return { type: "session.step.ended", data: { sessionID } }
}

/** 构造一个 step.failed 插件事件（time 不应响应它）。 */
function failedEvent(sessionID: string) {
  return { type: "session.step.failed", data: { sessionID } }
}

/** 假上下文：记录 synthetic 调用；session.get 返回 sessionDirectory 目录的会话（默认同 location）。 */
function fakeCtx(options?: { readonly directory?: string; readonly sessionDirectory?: string }) {
  const synthetic = vi.fn(() => Promise.resolve())
  const directory = options?.directory ?? "/work"
  const sessionDirectory = options?.sessionDirectory ?? directory
  const ctx = {
    location: { directory },
    storage: new MemoryStore(),
    session: {
      get: () => Promise.resolve({ location: { directory: sessionDirectory } }),
      synthetic,
    },
  } as unknown as Plugin.Context
  return { ctx, synthetic }
}

const roles = createSessionRoles({
  location: { directory: "/work" },
  storage: new MemoryStore(),
  session: {
    get: () => Promise.resolve({ location: { directory: "/work" } }),
  },
} as unknown as Plugin.Context)

const DEFAULT_TIME = { enabled: true, intervalSteps: 3, format: "YYYY-MM-DD HH:mm:ss", timezone: "" }

describe("formatTime", () => {
  it("按 token 渲染模板，其余字符原样保留", () => {
    // 固定时区：UTC 2026-03-05 07:08:09
    const at = new Date("2026-03-05T07:08:09Z")
    const text = formatTime(at, "YYYY-MM-DD HH:mm:ss", "UTC")
    expect(text).toBe("2026-03-05 07:08:09")
  })

  it("时区影响渲染结果", () => {
    const at = new Date("2026-03-05T23:30:00Z")
    expect(formatTime(at, "YYYY-MM-DD HH:mm:ss", "UTC")).toBe("2026-03-05 23:30:00")
    expect(formatTime(at, "YYYY-MM-DD HH:mm:ss", "Asia/Shanghai")).toBe("2026-03-06 07:30:00")
  })

  it("非法时区时 formatTimeSafe 回落宿主时区", () => {
    const at = new Date("2026-03-05T07:08:09Z")
    const text = formatTimeSafe(at, "YYYY", "Not/AZone")
    expect(text).toBe("2026")
  })
})

describe("isValidTimezone", () => {
  it("空串是合法的（宿主时区）", () => {
    expect(isValidTimezone("")).toBe(true)
  })
  it("合法 IANA 名通过，乱码拒绝", () => {
    expect(isValidTimezone("Asia/Shanghai")).toBe(true)
    expect(isValidTimezone("Not/AZone")).toBe(false)
  })
})

describe("createTimePulse", () => {
  it("step.ended 仅累加步数，轮次触发时才注入，且注入的那一轮本身不算", async () => {
    const { ctx, synthetic } = fakeCtx()
    const pulse = createTimePulse(ctx, roles, () => Promise.resolve(DEFAULT_TIME))
    try {
      // 走 3 步：step.ended 绝不直接调用 synthetic（绝不打扰模型休眠）
      await pulse.handle(stepEvent("s1"))
      await pulse.handle(stepEvent("s1"))
      await pulse.handle(stepEvent("s1"))
      expect(synthetic).not.toHaveBeenCalled()

      // 新交互触发（如主人发了新 prompt 或 tool.after 续跑）：满 3 步，触发注入！
      await pulse.trigger("s1")
      expect(synthetic).toHaveBeenCalledTimes(1)
      const firstCall = synthetic.mock.calls[0] as unknown as [
        { sessionID: string; delivery: string; resume: boolean; metadata: Record<string, unknown> },
      ]
      expect(firstCall[0]).toMatchObject({
        sessionID: "s1",
        delivery: "steer",
        resume: false,
        metadata: { timePulse: true },
      })
      // 时间串带方括号外壳；注入文本末尾带换行，避免与下一条用户提问粘连。
      const firstPayload = firstCall[0] as unknown as { text: string; description: string }
      expect(firstPayload.description).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]$/)
      expect(firstPayload.text).toBe(`${firstPayload.description}\n`)

      // 规则：注入的那一轮本身不算步数！
      // 本轮执行完毕，step.ended 被消费并跳过计步
      await pulse.handle(stepEvent("s1"))
      // 此时立刻 trigger，步数依然是 0，绝不连续注入
      await pulse.trigger("s1")
      expect(synthetic).toHaveBeenCalledTimes(1)

      // 重新走满 3 步正常业务交互
      await pulse.handle(stepEvent("s1"))
      await pulse.handle(stepEvent("s1"))
      await pulse.handle(stepEvent("s1"))
      expect(synthetic).toHaveBeenCalledTimes(1)

      // 下一次触发，注入第二次时间！
      await pulse.trigger("s1")
      expect(synthetic).toHaveBeenCalledTimes(2)
    } finally {
      pulse.dispose()
    }
  })

  it("非 step.ended 事件不计数", async () => {
    const { ctx, synthetic } = fakeCtx()
    const pulse = createTimePulse(ctx, roles, () => Promise.resolve(DEFAULT_TIME))
    try {
      await pulse.handle(failedEvent("s1"))
      await pulse.handle({ type: "session.idle", data: { sessionID: "s1" } })
      await pulse.handle(stepEvent("s1"))
      await pulse.handle(stepEvent("s1"))
      await pulse.trigger("s1")
      // 只有 2 步，未达到 3 步，不注入
      expect(synthetic).not.toHaveBeenCalled()
    } finally {
      pulse.dispose()
    }
  })

  it("功能关闭时不注入", async () => {
    const { ctx, synthetic } = fakeCtx()
    const pulse = createTimePulse(ctx, roles, () =>
      Promise.resolve({ ...DEFAULT_TIME, enabled: false }),
    )
    try {
      for (let i = 0; i < 5; i++) await pulse.handle(stepEvent("s1"))
      await pulse.trigger("s1")
      expect(synthetic).not.toHaveBeenCalled()
    } finally {
      pulse.dispose()
    }
  })

  it("子代理会话不计数且不注入", async () => {
    const { ctx, synthetic } = fakeCtx()
    // 子代理角色：parentID 非空。
    const subagentRoles = createSessionRoles({
      location: { directory: "/work" },
      storage: new MemoryStore(),
      session: {
        get: () => Promise.resolve({ location: { directory: "/work" }, parentID: "ses_parent" }),
      },
    } as unknown as Plugin.Context)
    const pulse = createTimePulse(ctx, subagentRoles, () => Promise.resolve(DEFAULT_TIME))
    try {
      for (let i = 0; i < 5; i++) await pulse.handle(stepEvent("s1"))
      await pulse.trigger("s1")
      expect(synthetic).not.toHaveBeenCalled()
    } finally {
      pulse.dispose()
    }
  })

  it("异 location 会话拒绝计数与注入（宁少勿重）", async () => {
    // ctx.location 是 /work，但 session.get 返回 /other 的会话 → 不属于本实例。
    const { ctx, synthetic } = fakeCtx({ directory: "/work", sessionDirectory: "/other" })
    const pulse = createTimePulse(ctx, roles, () => Promise.resolve(DEFAULT_TIME))
    try {
      for (let i = 0; i < 5; i++) await pulse.handle(stepEvent("s1"))
      await pulse.trigger("s1")
      expect(synthetic).not.toHaveBeenCalled()
      expect(await ownsSession(ctx, "s1")).toBe(false)
    } finally {
      pulse.dispose()
    }
  })

  it("plan 会话照常注入（不跳过 plan agent）", async () => {
    const { ctx, synthetic } = fakeCtx()
    // agent=plan 但无 parentID → 非子代理，time 不区分 agent。
    const planRoles = createSessionRoles({
      location: { directory: "/work" },
      storage: new MemoryStore(),
      session: {
        get: () => Promise.resolve({ location: { directory: "/work" }, agent: "plan" }),
      },
    } as unknown as Plugin.Context)
    const pulse = createTimePulse(ctx, planRoles, () => Promise.resolve(DEFAULT_TIME))
    try {
      await pulse.handle(stepEvent("s1"))
      await pulse.handle(stepEvent("s1"))
      await pulse.handle(stepEvent("s1"))
      await pulse.trigger("s1")
      expect(synthetic).toHaveBeenCalledTimes(1)
    } finally {
      pulse.dispose()
    }
  })

  it("forget 清掉会话计数；dispose 清空全部", async () => {
    const { ctx, synthetic } = fakeCtx()
    const pulse = createTimePulse(ctx, roles, () => Promise.resolve(DEFAULT_TIME))
    try {
      await pulse.handle(stepEvent("s1"))
      await pulse.handle(stepEvent("s1"))
      pulse.forget("s1")
      await pulse.handle(stepEvent("s1"))
      await pulse.trigger("s1")
      expect(synthetic).not.toHaveBeenCalled()
      // 再走 2 步满 3 步才注入，说明之前的 2 步确实被 forget 清除
      await pulse.handle(stepEvent("s1"))
      await pulse.handle(stepEvent("s1"))
      await pulse.trigger("s1")
      expect(synthetic).toHaveBeenCalledTimes(1)
    } finally {
      pulse.dispose()
    }
    await pulse.handle(stepEvent("s1"))
    await pulse.trigger("s1")
    expect(synthetic).toHaveBeenCalledTimes(1)
  })
})
