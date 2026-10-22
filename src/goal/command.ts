import type { Plugin } from "@opencode/plugin"

import { loadSettings } from "../shared/settings-store.ts"
import type { GoalContinuation } from "./continuation.ts"
import type { GoalController } from "./controller.ts"
import { parseGoalCommand } from "./parse-command.ts"

const DESCRIPTION = "Set, inspect, pause, resume or clear the persistent goal for this session"

const USAGE = "Usage: /goal [<objective>|clear|edit|pause|resume]"

/**
 * 输入：控制器 + 续作控制器 + 会话 ID + 原始参数。
 * 输出：给模型看的英文反馈。
 * 预期：set 会清掉旧目标与锁死标志；pause/resume 只对已有目标生效。
 */
async function applyGoalCommand(
  controller: GoalController,
  continuation: GoalContinuation,
  sessionID: string,
  rawArgs: string,
): Promise<string> {
  const parsed = parseGoalCommand(rawArgs)
  switch (parsed.kind) {
    case "set": {
      await controller.setGoal(sessionID, parsed.objective)
      // 新目标 = 全新开始：清掉旧会话残留的打断/超长/余额锁死标志。
      continuation.resetRunState(sessionID)
      return `Goal set: ${parsed.objective}`
    }
    case "pause": {
      const goal = await controller.pauseGoal(sessionID)
      return goal !== null ? `Goal paused. Current goal: ${goal.objective}` : "No active goal"
    }
    case "resume": {
      const goal = await controller.resumeGoal(sessionID)
      continuation.resetRunState(sessionID)
      return goal !== null ? `Goal resumed. Current goal: ${goal.objective}` : "No active goal"
    }
    case "clear": {
      const existed = await controller.clearGoal(sessionID)
      return existed ? "Goal cleared" : "No active goal"
    }
    case "edit": {
      const goal = await controller.getGoal(sessionID)
      if (goal === null) return USAGE
      return `Current goal: ${goal.objective}. Edit with /goal <new objective>.\n${USAGE}`
    }
    case "show": {
      const goal = await controller.getGoal(sessionID)
      if (goal === null) return "No active goal"
      return `Goal (${goal.status}): ${goal.objective}`
    }
  }
}

/**
 * 输入：插件上下文 + 控制器 + 续作控制器。
 * 输出：注册 `/goal` 命令，返回注销句柄。
 * 预期：命令本身不进对话流；执行后把反馈作为普通 prompt 发给当前会话。
 */
export async function registerGoalCommand(
  ctx: Plugin.Context,
  controller: GoalController,
  continuation: GoalContinuation,
): Promise<{ dispose(): Promise<void> }> {
  const registration = await ctx.command.transform((editor) => {
    editor.add({
      name: "goal",
      description: DESCRIPTION,
      execute: async (input) => {
        const settings = await loadSettings(ctx.storage)
        const text =
          settings.enabled && settings.goal.enabled
            ? await applyGoalCommand(controller, continuation, input.sessionID, input.prompt.text)
            : "Error: the goal feature is disabled in settings."
        // /goal 只关心文本参数；附件不回传，避免把命令附件重复塞进会话。
        await ctx.session.prompt({ sessionID: input.sessionID, text, delivery: input.delivery })
      },
    })
  })
  await ctx.command.reload()
  return registration
}
