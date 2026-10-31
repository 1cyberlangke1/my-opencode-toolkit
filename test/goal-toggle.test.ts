import type { Plugin } from "@opencode/plugin"
import { describe, expect, it } from "vitest"

import { MemoryStore } from "./helpers.ts"
import { registerGoal } from "../src/goal/index.ts"
import { createGoalController } from "../src/goal/controller.ts"
import type { SessionRoles } from "../src/goal/session-role.ts"

const SESSION = "ses_test"

/** 捕获到的命令定义（与 goal-command.test.ts 同形）。 */
type CapturedCommand = {
  readonly name: string
  readonly execute: (input: { readonly sessionID: string }) => Promise<void>
}

/** 捕获到的工具定义。 */
type CapturedTool = { readonly name: string }

/**
 * 输入：无。
 * 输出：假上下文与读取当前命令/工具表的函数。
 * 预期：command.transform / tool.transform 立即执行回调；dispose 清空注册表，
 *       用来断言「功能关闭后命令与工具从注册表里消失」。
 *       设置文件不存在 → loadSettings 回落默认值（goal.enabled=false）。
 */
function fakeCtx(): {
  ctx: Plugin.Context
  storage: MemoryStore
  commands: () => readonly string[]
  tools: () => readonly string[]
} {
  let commandNames: string[] = []
  let toolNames: string[] = []
  const storage = new MemoryStore()
  const ctx = {
    location: { directory: "/work" },
    storage,
    session: {
      get: () => Promise.resolve({ agent: "build" }),
      prompt: () => Promise.resolve(),
      context: () => Promise.resolve([]),
    },
    command: {
      transform: (fn: (editor: { add: (command: CapturedCommand) => void }) => void) => {
        commandNames = []
        fn({ add: (command) => commandNames.push(command.name) })
        return Promise.resolve({
          dispose: () => {
            commandNames = []
            return Promise.resolve()
          },
        })
      },
      reload: () => Promise.resolve(),
    },
    tool: {
      transform: (fn: (tools: { add: (tool: CapturedTool) => void }) => void) => {
        toolNames = []
        fn({ add: (tool) => toolNames.push(tool.name) })
        return Promise.resolve({
          dispose: () => {
            toolNames = []
            return Promise.resolve()
          },
        })
      },
      reload: () => Promise.resolve(),
    },
  } as unknown as Plugin.Context
  return {
    ctx,
    storage,
    commands: () => commandNames,
    tools: () => toolNames,
  }
}

const roles: SessionRoles = {
  isSubagent: () => Promise.resolve(false),
  forget: () => undefined,
}

describe("registerGoal 动态启停", () => {
  it("关闭时启动：不注册命令与工具，事件 handler 空转", async () => {
    const { ctx, storage, commands, tools } = fakeCtx()
    const controller = createGoalController(ctx.storage)
    // 设置文件不存在 → 默认 goal.enabled=false。
    const goal = await registerGoal(ctx, roles, controller, () => undefined)
    try {
      expect(commands()).toEqual([])
      expect(tools()).toEqual([])
      // 已有 active goal 也不会续作，但目标静默保留在存储里。
      await controller.setGoal(SESSION, "ship it")
      await goal.handle({ type: "session.idle", data: { sessionID: SESSION } })
      expect(storage.values.has(`goal:${SESSION}`)).toBe(true)
    } finally {
      await goal.dispose()
    }
  })

  it("setEnabled(true) 注册命令与工具，setEnabled(false) 注销", async () => {
    const { ctx, commands, tools } = fakeCtx()
    const controller = createGoalController(ctx.storage)
    const goal = await registerGoal(ctx, roles, controller, () => undefined)
    try {
      expect(commands()).toEqual([])
      expect(tools()).toEqual([])

      await goal.setEnabled(true)
      expect(commands()).toEqual(["goal"])
      expect(tools()).toEqual(["create_goal", "get_goal", "update_goal"])

      await goal.setEnabled(false)
      expect(commands()).toEqual([])
      expect(tools()).toEqual([])
    } finally {
      await goal.dispose()
    }
  })
})
