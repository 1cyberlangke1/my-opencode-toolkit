import { Plugin } from "@opencode/plugin"

import { hideGoalTools } from "./goal/filter.ts"
import { registerGoal } from "./goal/index.ts"
import { createGoalController } from "./goal/controller.ts"
import { createSessionRoles } from "./goal/session-role.ts"
import { createNotifier } from "./notification/index.ts"
import { hideSchedulingTools } from "./scheduling/filter.ts"
import { registerScheduling } from "./scheduling/index.ts"
import { dispatchEvent, type EventHandler } from "./shared/events.ts"
import { asRecord } from "./shared/json.ts"
import { ToolkitRpc } from "./shared/rpc.ts"
import { loadSettings, saveSettings } from "./shared/settings-store.ts"
import { normalizeSettings } from "./shared/settings.ts"
import { buildStats, createStatsTracker, hitRatePercent, trackEvent } from "./stats.ts"
import { registerPingTool } from "./tools/ping.ts"

export default Plugin.define({
  id: "my-opencode-toolkit",

  /**
   * 输入：OpenCode 注入的插件上下文。
   * 输出：设置/面板 RPC、`toolkit_ping`、Goal、定时任务、通知，以及卸载回调。
   * 预期：首次启动把 options 归一化后写入存储；之后以存储里的设置为准。
   */
  async setup(ctx) {
    await loadSettings(ctx.storage, ctx.options)

    const roles = createSessionRoles(ctx)
    const goalController = createGoalController(ctx.storage)
    const tracker = createStatsTracker()

    const tool = await registerPingTool(ctx)
    const goal = await registerGoal(ctx, ctx.storage, roles, goalController)
    const scheduling = await registerScheduling(ctx, ctx.storage, roles, async (sessionID) => {
      const current = await goalController.getGoal(sessionID)
      return current?.status === "active"
    })

    const rpc = await ctx.rpc.register(ToolkitRpc, {
      settingsGet: async () => loadSettings(ctx.storage, ctx.options),
      settingsSet: async (input) => {
        // RPC 定义是 PortableDefinition，运行时才知道 input 形状；这里再归一化一次兜底。
        await saveSettings(ctx.storage, normalizeSettings(input))
        return loadSettings(ctx.storage, ctx.options)
      },
      panelGet: async (input) => {
        const record = asRecord(input)
        const requested = record?.["sessionID"]
        const sessionID = typeof requested === "string" ? requested : ""

        // 统计不落盘：每个会话第一次打开面板时，从 OpenCode 已存消息重建一次。
        if (sessionID.length > 0 && !tracker.isSeeded(sessionID)) {
          tracker.seed(sessionID, await buildStats(ctx, sessionID))
        }

        const current = await goalController.getGoal(sessionID)
        const stats = tracker.get(sessionID)
        const tools = Object.entries(stats.tools)
          .map(([name, count]) => ({ name, count }))
          .sort((left, right) => right.count - left.count)

        return {
          goal:
            current === null
              ? null
              : {
                  objective: current.objective,
                  status: current.status,
                  tokensUsed: current.tokensUsed,
                  timeUsedSeconds: current.timeUsedSeconds,
                  ...(current.tokenBudget === undefined ? {} : { tokenBudget: current.tokenBudget }),
                },
          loops: scheduling.scheduler.listLoops(sessionID).map((loop) => ({
            id: loop.id,
            mode: loop.mode,
            prompt: loop.prompt,
            ...(loop.nextFireAt === undefined ? {} : { nextFireAt: loop.nextFireAt }),
          })),
          jobs: scheduling.jobs.listJobs(sessionID).map((job) => ({
            id: job.id,
            cron: job.cron,
            prompt: job.prompt,
            ...(job.nextRunAt === undefined ? {} : { nextRunAt: job.nextRunAt }),
          })),
          stats: { ...stats, hitRate: hitRatePercent(stats.input, stats.cached), tools },
        }
      },
    })

    // 功能关闭或子代理会话时，请求发给模型前就把对应工具从工具表移除。
    const hook = await ctx.session.hook("context", async (event) => {
      const settings = await loadSettings(ctx.storage)
      if (!settings.enabled) {
        hideGoalTools(event.tools)
        hideSchedulingTools(event.tools)
        return
      }
      const subagent = await roles.isSubagent(event.sessionID)
      if (subagent || !settings.goal.enabled) hideGoalTools(event.tools)
      if (subagent || !settings.scheduling.enabled) hideSchedulingTools(event.tools)
    })

    const notifier = createNotifier({ ctx, store: ctx.storage, roles })

    const toolBefore = await ctx.tool.hook("execute.before", async (input) => {
      await notifier.handleToolBefore({ tool: input.tool, sessionID: input.sessionID })
    })
    const toolAfter = await ctx.tool.hook("execute.after", (input) => {
      tracker.recordTool(input.sessionID, input.tool)
    })

    const handlers: EventHandler[] = [
      (event) => {
        trackEvent(tracker, event)
        return Promise.resolve()
      },
      (event) => notifier.handle(event),
      (event) => goal.handle(event),
      (event) => scheduling.handle(event),
    ]

    const events = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: events.signal })) {
          await dispatchEvent(handlers, event)
        }
      } catch {
        // aborted 或连接断开：卸载时正常路径
      }
    })()

    // 工具注册后刷新一次工具表，让当前会话的下一次请求就能看到新工具。
    await ctx.tool.reload()

    return async () => {
      events.abort()
      notifier.dispose()
      tracker.clear()
      await toolAfter.dispose()
      await toolBefore.dispose()
      await hook.dispose()
      await scheduling.dispose()
      await goal.dispose()
      await tool.dispose()
      await rpc.dispose()
    }
  },
})
