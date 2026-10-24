import type { Plugin } from "@opencode/plugin"
import { describe, expect, it } from "vitest"

import { MemoryStore } from "./helpers.ts"
import { registerGoalCommand } from "../src/goal/command.ts"
import { createGoalContinuation } from "../src/goal/continuation.ts"
import { createGoalController } from "../src/goal/controller.ts"
import type { SessionRoles } from "../src/goal/session-role.ts"
import { resolveMessages } from "../src/i18n/index.ts"

const SESSION = "ses_test"

/** 捕获到的命令定义。 */
type CapturedCommand = {
  readonly name: string
  readonly description?: string
  readonly execute: (input: {
    readonly sessionID: string
    readonly prompt: { readonly text: string }
    readonly delivery: "steer" | "queue"
  }) => Promise<void>
}

/**
 * 输入：prompt 日志 + 是否子代理。
 * 输出：假上下文与读取命令定义的函数。
 * 预期：command.transform 立即执行回调，reload 后可再次执行以验证描述更新。
 */
function fakeCtx(log: string[], subagent: boolean): { ctx: Plugin.Context; command: () => CapturedCommand } {
  let captured: CapturedCommand | undefined
  let render: (() => void) | undefined
  const ctx = {
    location: { directory: "/work" },
    storage: new MemoryStore(),
    session: {
      get: () =>
        Promise.resolve({ agent: "build", ...(subagent ? { parentID: "ses_parent" } : {}) }),
      prompt: (input: { text: string }) => {
        log.push(input.text)
        return Promise.resolve()
      },
      context: () => Promise.resolve([]),
    },
    command: {
      transform: (fn: (editor: { add: (command: CapturedCommand) => void }) => void) => {
        render = () => {
          fn({ add: (command) => (captured = command) })
        }
        render()
        return Promise.resolve({ dispose: () => Promise.resolve() })
      },
      reload: () => {
        render?.()
        return Promise.resolve()
      },
    },
  } as unknown as Plugin.Context
  return {
    ctx,
    command: () => {
      if (captured === undefined) throw new Error("command was not registered")
      return captured
    },
  }
}

/** 输入：是否子代理；输出：会话角色替身。 */
function rolesFor(subagent: boolean): SessionRoles {
  return { isSubagent: () => Promise.resolve(subagent), forget: () => undefined }
}

describe("/goal 命令", () => {
  it("子代理调用时拒绝并只回一条错误提示", async () => {
    const log: string[] = []
    const { ctx, command } = fakeCtx(log, true)
    const controller = createGoalController(ctx.storage)
    const continuation = createGoalContinuation({ ctx, controller, roles: rolesFor(true) })
    await registerGoalCommand(ctx, controller, continuation, rolesFor(true), () => undefined)

    await command().execute({ sessionID: SESSION, prompt: { text: "ship it" }, delivery: "steer" })

    expect(log).toHaveLength(1)
    expect(log[0]).toContain("not available to subagents")
    expect(await controller.getGoal(SESSION)).toBeNull()
  })

  it("refresh 后按新语言重注册描述", async () => {
    const log: string[] = []
    const { ctx, command } = fakeCtx(log, false)
    const controller = createGoalController(ctx.storage)
    const roles = rolesFor(false)
    const continuation = createGoalContinuation({ ctx, controller, roles })
    const handle = await registerGoalCommand(ctx, controller, continuation, roles, () => undefined)

    await handle.refresh("zh")

    expect(command().description).toBe(resolveMessages("zh").command.goal)
  })
})
