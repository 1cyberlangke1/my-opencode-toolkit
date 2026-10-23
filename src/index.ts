import { Plugin } from "@opencode/plugin"

import { hideGoalTools } from "./goal/filter.ts"
import { registerGoal } from "./goal/index.ts"
import { createGoalController } from "./goal/controller.ts"
import { createSessionRoles } from "./goal/session-role.ts"
import { createNotifier } from "./notification/index.ts"
import { hideSchedulingTools } from "./scheduling/filter.ts"
import { registerScheduling } from "./scheduling/index.ts"
import { dispatchEvent, readEventData, readEventSessionID, type EventHandler } from "./shared/events.ts"
import { PLUGIN_ID } from "./shared/identity.ts"
import { asRecord } from "./shared/json.ts"
import { ToolkitRpc } from "./shared/rpc.ts"
import { loadSettings, saveSettings } from "./shared/settings-store.ts"
import { normalizeSettings } from "./shared/settings.ts"
import { buildStats, buildSubagentDetail, createStatsTracker, hitRatePercent, listSubagents, trackEvent } from "./stats.ts"
import { applyDelta, loadStats, removeStats, saveStats } from "./stats-store.ts"

/** 输入：RPC 参数；输出：配置层路径。 */
function readLayers(input: unknown): readonly string[] | undefined {
  const record = asRecord(input)
  const value = record?.["layers"]
  if (!Array.isArray(value)) return undefined
  const layers = value.filter((item): item is string => typeof item === "string" && item.length > 0)
  return layers.length === 0 ? undefined : layers
}

export default Plugin.define({
  id: PLUGIN_ID,

  /**
   * 输入：OpenCode 注入的插件上下文。
   * 输出：设置/面板 RPC、Goal、定时任务、通知，以及卸载回调。
   * 预期：首次启动把 options 归一化后写入存储；之后以存储里的设置为准。
   */
  async setup(ctx) {
    const roles = createSessionRoles(ctx)
    const goalController = createGoalController(ctx.storage)
    const tracker = createStatsTracker()
    // 事件重放去重：同一个 assistant 消息只记一次账，键挂 globalThis 跨实例共享。
    const seenRegistry = globalThis as unknown as Record<symbol, Map<string, string> | undefined>
    const seenKey = Symbol.for("my-opencode-toolkit.stats.seen")
    const seenAll = seenRegistry[seenKey] ?? new Map<string, string>()
    seenRegistry[seenKey] = seenAll

    /**
     * 输入：会话 ID。
     * 输出：该会话是否属于当前插件实例的 location。
     * 预期：插件按 location 各加载一份，step 事件会广播到所有实例；
     *       只有会话所属实例落盘统计，其余实例跳过，避免同一 step 被重复累加。
     */
    const ownsSession = async (sessionID: string): Promise<boolean> => {
      const session = await ctx.session.get({ sessionID }).catch(() => undefined)
      return session === undefined || session.location.directory === ctx.location.directory
    }
    // RPC 在 goal 之后注册；先用可替换发射器，命令执行时已指向真实 RPC。
    let emitPanelUpdated: (sessionID: string) => void = () => undefined
    const goal = await registerGoal(ctx, roles, goalController, (sessionID) => {
      emitPanelUpdated(sessionID)
    })
    // RPC 注册在后面；先用一个可替换的发射器，避免定时器回调早于 rpc 就绪。
    let emitToast: (kind: "cron" | "loop") => void = () => undefined
    const scheduling = await registerScheduling(
      ctx,
      ctx.storage,
      roles,
      async (sessionID) => {
        const current = await goalController.getGoal(sessionID)
        return current?.status === "active"
      },
      (kind) => {
        emitToast(kind)
      },
    )

    const rpc = await ctx.rpc.register(ToolkitRpc, {
      settingsGet: async (input) => loadSettings(ctx, readLayers(input)),
      settingsSet: async (input) => {
        // RPC 定义是 PortableDefinition，运行时才知道 input 形状；这里再归一化一次兜底。
        const layers = readLayers(input)
        const next = normalizeSettings(input)
        await saveSettings(ctx, next, layers)
        return loadSettings(ctx, layers)
      },
      panelGet: async (input) => {
        const record = asRecord(input)
        const requested = record?.["sessionID"]
        const sessionID = typeof requested === "string" ? requested : ""

        // 统计持久化在 storage：显示值 = 存档（全量权威）+ 内存未落盘增量。
        // 没有存档的旧会话先从 OpenCode 消息重建一次并落盘；重载/重启/压缩删消息都不丢历史。
        let stats = tracker.get(sessionID)
        if (sessionID.length > 0) {
          const stored = await loadStats(ctx.storage, sessionID).catch(() => null)
          if (stored === null) {
            const rebuilt = await buildStats(ctx, sessionID)
            await saveStats(ctx.storage, sessionID, rebuilt).catch(() => undefined)
          }
          const base = stored ?? { steps: 0, input: 0, output: 0, cached: 0, tools: {}, subagents: 0 }
          stats = applyDelta(base, tracker.get(sessionID))
        }

        const current = await goalController.getGoal(sessionID)
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
                  updatedAt: current.updatedAt,
                  ...(current.inputTokens === undefined ? {} : { inputTokens: current.inputTokens }),
                  ...(current.outputTokens === undefined ? {} : { outputTokens: current.outputTokens }),
                  ...(current.cachedTokens === undefined ? {} : { cachedTokens: current.cachedTokens }),
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
          subagents: await listSubagents(ctx, sessionID),
        }
      },
      subagentGet: async (input) => {
        const record = asRecord(input)
        const requested = record?.["sessionID"]
        const sessionID = typeof requested === "string" ? requested : ""
        if (sessionID.length === 0) {
          return { steps: 0, input: 0, output: 0, cached: 0, hitRate: 0, tools: [] }
        }
        return buildSubagentDetail(ctx, sessionID)
      },
    })

    emitPanelUpdated = (sessionID) => {
      void rpc.events.emit("panelUpdated", { sessionID }).catch(() => undefined)
    }

    // Plan 模式跳过 cron/loop 时通知 TUI 弹 toast；只提示，不改变调度结果。
    emitToast = (kind) => {
      void rpc.events.emit("toast", { reason: "planSkipped", kind }).catch(() => undefined)
    }

    // 功能关闭或子代理会话时，请求发给模型前就把对应工具从工具表移除。
    const hook = await ctx.session.hook("context", async (event) => {
      const settings = await loadSettings(ctx)
      if (!settings.enabled) {
        hideGoalTools(event.tools)
        hideSchedulingTools(event.tools)
        return
      }
      const subagent = await roles.isSubagent(event.sessionID)
      if (subagent || !settings.goal.enabled) hideGoalTools(event.tools)
      if (subagent || !settings.scheduling.enabled) hideSchedulingTools(event.tools)
    })

    const notifier = createNotifier({ ctx, roles })

    const toolBefore = await ctx.tool.hook("execute.before", async (input) => {
      await notifier.handleToolBefore({ tool: input.tool, sessionID: input.sessionID })
    })
    const toolAfter = await ctx.tool.hook("execute.after", (input) => {
      tracker.recordTool(input.sessionID, input.tool)
      // 工具刚执行完就通知侧栏刷新；失败不影响工具结果。
      void rpc.events.emit("panelUpdated", { sessionID: input.sessionID }).catch(() => undefined)
    })

    /**
     * 输入：事件数据（含 sessionID / tokens / assistantMessageID）。
     * 输出：无。
     * 预期：step 结束时把统计增量写入存储。口径：
     *       存档（storage）= 全量权威；内存 tracker = 距上次落盘的增量（落盘后清零）。
     *       落盘值 = 存档 + 内存增量；无存档的旧会话先从消息重建全量（含本步），
     *       直接作为新存档。重载/重启后内存从 0 开始，存档不受影响，不会重复累加。
     *       只有会话所属 location 的实例落盘；同一 assistant 消息只记一次（防事件重放）。
     */
    const persistStep = async (data: Record<string, unknown> | undefined): Promise<void> => {
      if (data === undefined) return
      const sessionID = data["sessionID"]
      if (typeof sessionID !== "string" || sessionID.length === 0) return
      // 只有会话所属实例落盘，其余实例跳过，避免同一 step 被重复累加。
      if (!(await ownsSession(sessionID))) return
      const messageID = data["assistantMessageID"]
      if (typeof messageID === "string" && messageID.length > 0) {
        if (seenAll.get(sessionID) === messageID) return
        seenAll.set(sessionID, messageID)
      }
      const stored = await loadStats(ctx.storage, sessionID).catch(() => null)
      if (stored === null) {
        // 无存档：消息里已含本步全量，直接建档；内存增量清零，避免下次落盘重复。
        const rebuilt = await buildStats(ctx, sessionID)
        await saveStats(ctx.storage, sessionID, rebuilt, typeof messageID === "string" ? messageID : undefined).catch(
          () => undefined,
        )
      } else {
        const merged = applyDelta(stored, tracker.get(sessionID))
        await saveStats(ctx.storage, sessionID, merged, typeof messageID === "string" ? messageID : undefined).catch(
          () => undefined,
        )
      }
      // 增量已并入存档：内存清零，回到"距上次落盘 = 0"的基线。
      tracker.seed(sessionID, { steps: 0, input: 0, output: 0, cached: 0, tools: {}, subagents: 0 })
    }

    /**
     * 输入：事件数据。
     * 输出：无。
     * 预期：会话删除时同步清掉内存统计、去重键与存储存档；重复删除幂等。
     */
    const forgetSession = async (data: Record<string, unknown> | undefined): Promise<void> => {
      const sessionID = typeof data?.["sessionID"] === "string" ? data["sessionID"] : undefined
      if (sessionID === undefined || sessionID.length === 0) return
      tracker.forget(sessionID)
      seenAll.delete(sessionID)
      await removeStats(ctx.storage, sessionID).catch(() => undefined)
    }

    const handlers: EventHandler[] = [
      (event) => {
        trackEvent(tracker, event)
        return Promise.resolve()
      },
      (event) => notifier.handle(event),
      (event) => goal.handle(event),
      (event) => {
        // goal 记账发生在 step.ended；记账后再刷新，避免 TUI 读到旧 tokensUsed。
        if (event.type === "session.step.ended") {
          const sessionID = readEventSessionID(event)
          if (sessionID !== undefined) emitPanelUpdated(sessionID)
        }
        return Promise.resolve()
      },
      (event) => scheduling.handle(event),
      // 统计持久化：内存累加交给 trackEvent，这里只负责落盘与删除清理。
      (event) => {
        const data = readEventData(event)
        if (event.type === "session.step.ended") return persistStep(data)
        if (event.type === "session.deleted") return forgetSession(data)
        return Promise.resolve()
      },
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
      await rpc.dispose()
    }
  },
})
