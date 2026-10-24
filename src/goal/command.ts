import type { Plugin } from "@opencode/plugin"

import { resolveMessages } from "../i18n/index.ts"
import type { Lang } from "../shared/settings.ts"
import { loadSettings } from "../shared/settings-store.ts"
import type { GoalContinuation } from "./continuation.ts"
import type { GoalController } from "./controller.ts"
import { parseGoalCommand } from "./parse-command.ts"
import type { SessionRoles } from "./session-role.ts"

const USAGE = "Usage: /goal [<objective>|pause|resume|clear|edit]"

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
  notify: (sessionID: string) => void,
): Promise<string> {
  const parsed = parseGoalCommand(rawArgs)
  switch (parsed.kind) {
    case "set": {
      await controller.setGoal(sessionID, parsed.objective)
      // 新目标 = 全新开始：清掉旧会话残留的打断/超长/余额锁死标志。
      continuation.resetRunState(sessionID)
      notify(sessionID)
      return `Goal set: ${parsed.objective}`
    }
    case "pause": {
      const goal = await controller.pauseGoal(sessionID)
      notify(sessionID)
      return goal !== null ? `Goal paused. Current goal: ${goal.objective}` : "No active goal"
    }
    case "resume": {
      const goal = await controller.resumeGoal(sessionID)
      continuation.resetRunState(sessionID)
      notify(sessionID)
      return goal !== null ? `Goal resumed. Current goal: ${goal.objective}` : "No active goal"
    }
    case "clear": {
      const existed = await controller.clearGoal(sessionID)
      notify(sessionID)
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
 * 输入：插件上下文 + 控制器 + 续作控制器 + 会话角色。
 * 输出：注册 `/goal` 命令，返回注销与刷新句柄。
 * 预期：命令本身不进对话流；执行后把反馈作为普通 prompt 发给当前会话。
 *       描述文案在 refresh 后按新语言重注册，不再固定 setup 时的语言。
 */
export async function registerGoalCommand(
  ctx: Plugin.Context,
  controller: GoalController,
  continuation: GoalContinuation,
  roles: SessionRoles,
  notify: (sessionID: string) => void,
): Promise<{ dispose(): Promise<void>; refresh(lang: Lang): Promise<void> }> {
  const settings = await loadSettings(ctx)
  let messages = resolveMessages(settings.lang === "auto" ? undefined : settings.lang)

  const registration = await ctx.command.transform((editor) => {
    editor.add({
      name: "goal",
      description: messages.command.goal,
      execute: async (input) => {
        // 子代理不能操作目标：它不会续作，记账还会污染父会话的预算。
        if (await roles.isSubagent(input.sessionID)) {
          await ctx.session.prompt({
            sessionID: input.sessionID,
            text: "Error: /goal is not available to subagents.",
            delivery: input.delivery,
          })
          return
        }
        const settings = await loadSettings(ctx)
        const parsed = parseGoalCommand(input.prompt.text)
        // clear / show 是清理与查看，功能关闭时也允许，避免目标被永久锁在存储里。
        const readOnly = parsed.kind === "clear" || parsed.kind === "show"
        const text =
          (settings.enabled && settings.goal.enabled) || readOnly
            ? await applyGoalCommand(controller, continuation, input.sessionID, input.prompt.text, notify)
            : "Error: the goal feature is disabled in settings."
        // /goal 只关心文本参数；附件不回传，避免把命令附件重复塞进会话。
        await ctx.session.prompt({ sessionID: input.sessionID, text, delivery: input.delivery })
      },
    })
  })
  await ctx.command.reload()
  return {
    dispose: () => registration.dispose(),
    async refresh(lang) {
      messages = resolveMessages(lang === "auto" ? undefined : lang)
      await ctx.command.reload()
    },
  }
}
