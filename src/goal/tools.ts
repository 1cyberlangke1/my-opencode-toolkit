import type { Plugin } from "@opencode/plugin"
import { Schema } from "effect"

import { loadSettings } from "../shared/settings-store.ts"
import type { GoalController } from "./controller.ts"
import type { SessionRoles } from "./session-role.ts"
import type { Goal } from "./types.ts"

const DESCRIPTION_CREATE =
  "Create a persistent goal for the current session. Use this when the user asks you to set a goal, " +
  "or when you decide a new high-level objective is needed. The goal persists across turns and is shown " +
  "in the TUI. The objective should be concise and describe the desired outcome, not a single action. " +
  "If this thread already has an unfinished goal, creating a new one fails; complete or clear the " +
  "existing goal first."

const DESCRIPTION_GET =
  "Read the active goal for the current session. Returns the current objective, status, token budget " +
  "and usage accounting. Returns null if no goal is set."

const DESCRIPTION_UPDATE =
  "Update the status of the current session's goal. " +
  'Use "paused" to pause an active goal, "active" to resume a paused/completed goal, ' +
  '"cleared" to delete it, "complete" when it is achieved, or "blocked" when the same blocking ' +
  "condition has repeated for at least three consecutive goal turns (a single call immediately " +
  "stops continuations until resumed). " +
  'When you believe the goal has been achieved, first perform a completion audit against the actual ' +
  'current state (files, tests, command output), then call update_goal with status "complete".'

const CreateInput = Schema.Struct({
  objective: Schema.String,
  // 工具 schema 对外暴露 nullable；null 与不传同义，避免调用方传 null 时被 schema 拒绝。
  token_budget: Schema.optional(Schema.NullOr(Schema.Number)),
})

const EmptyInput = Schema.Struct({})

const UpdateInput = Schema.Struct({
  status: Schema.Literals(["complete", "blocked", "paused", "active", "cleared"]),
  block_reason: Schema.optional(Schema.String),
})

const EmptyOutput = Schema.Struct({})

/** 输入：目标；输出：给模型看的 JSON 文本。预期：`null` 也序列化成 `null`。 */
function formatGoal(goal: Goal | null): string {
  return JSON.stringify({ goal }, null, 2)
}

/**
 * 输入：插件上下文 + 存储 + 控制器 + 会话角色。
 * 输出：注册 `create_goal` / `get_goal` / `update_goal` 三个工具。
 * 预期：goal 关闭或子代理会话里返回错误文本；工具本身由 context 钩子从子代理工具表移除。
 */
export async function registerGoalTools(
  ctx: Plugin.Context,
  controller: GoalController,
  roles: SessionRoles,
  reset: (sessionID: string) => void,
): Promise<{ dispose(): Promise<void> }> {
  /** 输入：会话 ID；输出：不可用原因，可用时为 `null`。 */
  const unavailable = async (sessionID: string): Promise<string | null> => {
    const settings = await loadSettings(ctx)
    if (!settings.enabled || !settings.goal.enabled) return "Error: the goal feature is disabled in settings."
    if (await roles.isSubagent(sessionID)) return "Error: goal tools are not available to subagents."
    return null
  }

  return ctx.tool.transform((tools) => {
    tools.add({
      name: "create_goal",
      options: { codemode: false },
      description: DESCRIPTION_CREATE,
      input: CreateInput,
      output: EmptyOutput,
      execute: async (input, toolCtx) => {
        const sessionID = toolCtx.sessionID
        const blocked = await unavailable(sessionID)
        if (blocked !== null) return { output: {}, content: blocked }

        const objective = input.objective.trim()
        if (objective.length === 0) {
          return { output: {}, content: "Error: objective cannot be empty." }
        }
        const tokenBudget = input.token_budget ?? undefined
        if (tokenBudget !== undefined && (!Number.isFinite(tokenBudget) || tokenBudget <= 0)) {
          return { output: {}, content: "Error: token_budget must be a positive number." }
        }

        const existing = await controller.getGoal(sessionID)
        if (existing !== null && existing.status !== "complete" && existing.status !== "blocked") {
          return {
            output: {},
            content: "Error: this thread has an unfinished goal; complete or clear it before creating a new one.",
          }
        }

        await controller.setGoal(sessionID, objective, tokenBudget)
        reset(sessionID)
        return { output: {}, content: formatGoal(await controller.getGoal(sessionID)) }
      },
    })

    tools.add({
      name: "get_goal",
      options: { codemode: false },
      description: DESCRIPTION_GET,
      input: EmptyInput,
      output: EmptyOutput,
      execute: async (_input, toolCtx) => {
        const sessionID = toolCtx.sessionID
        const blocked = await unavailable(sessionID)
        if (blocked !== null) return { output: {}, content: blocked }
        return { output: {}, content: formatGoal(await controller.getGoal(sessionID)) }
      },
    })

    tools.add({
      name: "update_goal",
      options: { codemode: false },
      description: DESCRIPTION_UPDATE,
      input: UpdateInput,
      output: EmptyOutput,
      execute: async (input, toolCtx) => {
        const sessionID = toolCtx.sessionID
        const blocked = await unavailable(sessionID)
        if (blocked !== null) return { output: {}, content: blocked }

        if (input.status === "cleared") {
          await controller.clearGoal(sessionID)
          reset(sessionID)
          return { output: {}, content: "Goal cleared." }
        }
        if (input.status === "paused") {
          const goal = await controller.pauseGoal(sessionID)
          if (goal === null) return { output: {}, content: "Error: no active goal to pause." }
          return { output: {}, content: formatGoal(goal) }
        }
        if (input.status === "active") {
          const goal = await controller.resumeGoal(sessionID)
          if (goal === null) return { output: {}, content: "Error: no goal set for this session." }
          return { output: {}, content: formatGoal(goal) }
        }
        if (input.status === "complete") {
          const goal = await controller.markComplete(sessionID)
          if (goal === null) return { output: {}, content: "Error: no goal set for this session." }
          reset(sessionID)
          return { output: {}, content: formatGoal(goal) }
        }

        const reason = input.block_reason?.trim() ?? ""
        if (reason.length === 0) {
          return { output: {}, content: "Error: block_reason is required when status is blocked." }
        }
        const goal = await controller.markBlocked(sessionID, reason)
        if (goal === null) return { output: {}, content: "Error: no goal set for this session." }
        return { output: {}, content: formatGoal(goal) }
      },
    })
  })
}
