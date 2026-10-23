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
import { buildSubagentDetail, hitRatePercent, listSubagents } from "./stats.ts"
import type { SessionStats } from "./stats.ts"
import { loadStats, removeStats, saveStats } from "./stats-store.ts"

/** 输入：RPC 参数；输出：配置层路径。 */
function readLayers(input: unknown): readonly string[] | undefined {
  const record = asRecord(input)
  const value = record?.["layers"]
  if (!Array.isArray(value)) return undefined
  const layers = value.filter((item): item is string => typeof item === "string" && item.length > 0)
  return layers.length === 0 ? undefined : layers
}

/** 输入：无；输出：空统计。 */
function emptyStats(): SessionStats {
  return { steps: 0, input: 0, output: 0, cached: 0, tools: {} }
}

/** 输入：任意值；输出：非负有限数，否则 0。 */
function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

/** 输入：step.ended 事件里的 tokens；输出：本步的 input/output/cached。 */
export function readStepTokens(tokens: unknown): { input: number; output: number; cached: number } {
  const record = asRecord(tokens)
  if (record === undefined) return { input: 0, output: 0, cached: 0 }
  const cache = asRecord(record["cache"]) ?? {}
  // 分母是完整提示词；cache.write 是写入成本，不算命中。
  return {
    input: count(record["input"]) + count(cache["read"]) + count(cache["write"]),
    output: count(record["output"]) + count(record["reasoning"]),
    cached: count(cache["read"]),
  }
}

export default Plugin.define({
  id: PLUGIN_ID,

  /**
   * 输入：OpenCode 注入的插件上下文。
   * 输出：设置/面板 RPC、Goal、定时任务、通知，以及卸载回调。
   * 预期：统计 = 纯加法一本账。内存 Map 是工作副本，每次累加完立刻整体落盘；
   *       存档只是内存的备份，读档一次、之后永远只加不减。
   */
  async setup(ctx) {
    const roles = createSessionRoles(ctx)
    const goalController = createGoalController(ctx.storage)

    /**
     * 输入：会话 ID。
     * 输出：该会话存档；没有就是 `null`。
     * 预期：每次记账前直接读存档——无内存缓存、无重建，存档是唯一账本。
     */
    const load = (sessionID: string): Promise<SessionStats | null> =>
      loadStats(ctx.storage, sessionID).catch(() => null)

    /**
     * 输入：会话 ID。
     * 输出：该会话是否属于当前插件实例的 location。
     * 预期：插件按 location 各加载一份，事件会广播到所有实例；
     *       只有会话所属实例记账。会话查不到（别的实例的会话）也拒绝，
     *       宁可少记不可重复累加。
     */
    const ownsSession = async (sessionID: string): Promise<boolean> => {
      const session = await ctx.session.get({ sessionID }).catch(() => undefined)
      return session?.location.directory === ctx.location.directory
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

        // 直接读存档；没有记录的会话（从未跑过 step）显示空统计。
        const stats =
          sessionID.length > 0 ? (await load(sessionID)) ?? emptyStats() : emptyStats()
        const tools = Object.entries(stats.tools)
          .map(([name, count]) => ({ name, count }))
          .sort((left, right) => right.count - left.count)

        const current = await goalController.getGoal(sessionID)

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
          stats: {
            ...stats,
            hitRate: hitRatePercent(stats.input, stats.cached),
            tools,
            subagents: (await listSubagents(ctx, sessionID)).length,
          },
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
    const toolAfter = await ctx.tool.hook("execute.after", async (input) => {
      if (!(await ownsSession(input.sessionID))) return
      const stats = (await load(input.sessionID)) ?? emptyStats()
      stats.tools[input.tool] = (stats.tools[input.tool] ?? 0) + 1
      await saveStats(ctx.storage, input.sessionID, stats).catch(() => undefined)
      // 工具刚执行完就通知侧栏刷新；失败不影响工具结果。
      void rpc.events.emit("panelUpdated", { sessionID: input.sessionID }).catch(() => undefined)
    })

    const handlers: EventHandler[] = [
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
      // 统计累加：token 在 step.ended，删除清理在 session.deleted。读存档 → 加 → 写回。
      (event) => {
        const data = readEventData(event)
        if (event.type === "session.step.ended") {
          const sessionID = readEventSessionID(event)
          if (sessionID === undefined) return Promise.resolve()
          return ownsSession(sessionID).then(async (owned) => {
            if (!owned) return
            const stats = (await load(sessionID)) ?? emptyStats()
            const step = readStepTokens(data?.["tokens"])
            stats.steps += 1
            stats.input += step.input
            stats.output += step.output
            stats.cached += step.cached
            await saveStats(ctx.storage, sessionID, stats).catch(() => undefined)
          })
        }
        if (event.type === "session.deleted") {
          const sessionID = readEventSessionID(event)
          if (sessionID === undefined) return Promise.resolve()
          return removeStats(ctx.storage, sessionID).catch(() => undefined)
        }
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
      await toolAfter.dispose()
      await toolBefore.dispose()
      await hook.dispose()
      await scheduling.dispose()
      await goal.dispose()
      await rpc.dispose()
    }
  },
})
