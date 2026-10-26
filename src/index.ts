import { Plugin } from "@opencode/plugin"

import { hideGoalTools } from "./goal/filter.ts"
import { registerGoal } from "./goal/index.ts"
import { createGoalController } from "./goal/controller.ts"
import { createSessionRoles } from "./goal/session-role.ts"
import { createNotifier } from "./notification/index.ts"
import { hideSchedulingTools } from "./scheduling/filter.ts"
import { DEFAULT_MAX_AGE_DAYS } from "./scheduling/types.ts"
import { registerScheduling } from "./scheduling/index.ts"
import { dispatchEvent, readEventData, readEventSessionID, type EventHandler } from "./shared/events.ts"
import { PLUGIN_ID } from "./shared/identity.ts"
import { asRecord } from "./shared/json.ts"
import { ToolkitRpc, type PanelData, type PanelSubagentDetail } from "./shared/rpc.ts"
import { globalSerialRegistry, runSerial } from "./shared/serial.ts"
import { ownsSession } from "./shared/session.ts"
import { loadSettings, saveSettings } from "./shared/settings-store.ts"
import { normalizeSettings } from "./shared/settings.ts"
import { buildStats, buildSubagentDetail, hitRatePercent, listSubagents, tokenParts } from "./stats.ts"
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

/** 统计读改写必须按会话串行，否则并发 step 事件会互相覆盖。 */
const STATS_CHAINS = globalSerialRegistry(Symbol.for("my-opencode-toolkit.stats-chains"))

/** 输入：无；输出：空面板。预期：会话不属于本实例时返回它，而不是别的目录的数据。 */
function emptyPanel(): PanelData {
  return {
    goal: null,
    loops: [],
    jobs: [],
    stats: { steps: 0, input: 0, output: 0, cached: 0, hitRate: 0, subagents: 0, lastTool: null, tools: [] },
    subagents: [],
  }
}

/** 输入：无；输出：空子代理详情。 */
function emptyDetail(): PanelSubagentDetail {
  return { steps: 0, input: 0, output: 0, cached: 0, hitRate: 0, tools: [] }
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
     * 本实例已完成首次完整历史重建的会话。
     * 输入：会话 ID；输出：是否已重建。
     * 预期：首次 panelGet 从完整历史重建一次并落盘，之后直接读增量存档；会话删除时清掉标记。
     */
    const statsRebuilt = new Set<string>()

    /**
     * 本实例已删除的会话墓碑。
     * 输入：会话 ID；输出：是否已删除。
     * 预期：删除与统计写入共用串行链，删除后迟到的工具/step 写入不得把统计复活。
     */
    const statsDeleted = new Set<string>()

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
    /** 输入：会话 ID；输出：是否属于本实例 location。预期：查询失败视为不属于。 */
    const owns = (sessionID: string): Promise<boolean> => ownsSession(ctx, sessionID)

    // RPC 在 goal 之后注册；先用可替换发射器，命令执行时已指向真实 RPC。
    let emitPanelUpdated: (sessionID: string) => void = () => undefined
    const goal = await registerGoal(ctx, roles, goalController, (sessionID) => {
      emitPanelUpdated(sessionID)
    })
    // RPC 注册在后面；先用一个可替换的发射器，避免定时器回调早于 rpc 就绪。
    let emitToast: (kind: "cron" | "loop", sessionID: string) => void = () => undefined
    const scheduling = await registerScheduling(
      ctx,
      ctx.storage,
      roles,
      async (sessionID) => {
        const current = await goalController.getGoal(sessionID)
        return current?.status === "active"
      },
      (kind, sessionID) => {
        emitToast(kind, sessionID)
      },
    )

    const rpc = await ctx.rpc.register(ToolkitRpc, {
      settingsGet: async (input) => loadSettings(ctx, readLayers(input)),
      settingsSet: async (input) => {
        // RPC 定义是 PortableDefinition，运行时才知道 input 形状；这里再归一化一次兜底。
        const layers = readLayers(input)
        const next = normalizeSettings(input)
        await saveSettings(ctx, next, layers)
        // 命令描述在注册时生成；语言变了必须重注册，否则 /goal /cron /loop 一直显示旧语言。
        await Promise.all([goal.refreshCommands(next.lang), scheduling.refreshCommands(next.lang)]).catch(
          () => undefined,
        )
        return loadSettings(ctx, layers)
      },
      panelGet: async (input) => {
        const record = asRecord(input)
        const requested = record?.["sessionID"]
        const sessionID = typeof requested === "string" ? requested : ""

        // RPC 可能被任意实例接收；不属于本实例的会话读不到数据，直接返回空面板。
        if (sessionID.length > 0 && !(await owns(sessionID))) return emptyPanel()

        // 首次 panelGet 从完整消息历史重建：存档可能只是部分增量，不能直接当全量；
        // 否则旧会话在启用插件后永远显示残缺数据，与子代理详情的 buildStats 口径也不一致。
        let stats: SessionStats = emptyStats()
        if (sessionID.length > 0) {
          // 首次重复完整历史必须与 step/tool 增量、删除同链，避免并发读写互相覆盖。
          stats = await runSerial(STATS_CHAINS, sessionID, async () => {
            // 删除可能已排在链上；串行链内复查，迟到的重建不能复活统计。
            if (statsDeleted.has(sessionID)) return emptyStats()
            if (!(await owns(sessionID))) return emptyStats()
            const stored = await load(sessionID).catch(() => null)
            if (statsRebuilt.has(sessionID)) {
              if (stored !== null) return stored
              statsRebuilt.delete(sessionID)
            }
            const rebuilt = await buildStats(ctx, sessionID)
            if (rebuilt === undefined) return stored ?? emptyStats()
            const merged: SessionStats = {
              ...rebuilt,
              ...(rebuilt.lastTool === undefined && stored?.lastTool !== undefined
                ? { lastTool: stored.lastTool }
                : {}),
            }
            try {
              await saveStats(ctx.storage, sessionID, merged)
              statsRebuilt.add(sessionID)
            } catch {
              // 保存失败时保留已存值并允许下次重试，不能把内存标记当成已落盘。
            }
            return merged
          })
        }
        const tools = Object.entries(stats.tools)
          .map(([name, count]) => ({ name, count }))
          .sort((left, right) => right.count - left.count)

        const current = await goalController.getGoal(sessionID)
        // 子代理列表只翻一次页：之前算数量与返回列表各查一遍。
        const subagents = await listSubagents(ctx, sessionID)

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
            recurring: job.recurring === true,
            ...(job.requestedAt === undefined ? {} : { requestedAt: job.requestedAt }),
            ...(job.recurring === true && job.permanent !== true
              ? { expiresAt: job.createdAt + DEFAULT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000 }
              : {}),
            ...(job.nextRunAt === undefined ? {} : { nextRunAt: job.nextRunAt }),
          })),
          stats: {
            ...stats,
            hitRate: hitRatePercent(stats.input, stats.cached),
            lastTool: stats.lastTool ?? null,
            tools,
            subagents: subagents.length,
          },
          subagents,
        }
      },
      subagentGet: async (input) => {
        const record = asRecord(input)
        const requested = record?.["sessionID"]
        const sessionID = typeof requested === "string" ? requested : ""
        if (sessionID.length === 0) return emptyDetail()
        // 子代理会话同样必须属于本实例目录，避免跨 location 读别人的统计。
        if (!(await owns(sessionID))) return emptyDetail()
        return buildSubagentDetail(ctx, sessionID)
      },
    })

    emitPanelUpdated = (sessionID) => {
      void rpc.events.emit("panelUpdated", { sessionID }).catch(() => undefined)
    }

    // Plan 模式跳过 cron/loop 时通知 TUI 弹 toast；只提示，不改变调度结果。
    emitToast = (kind, sessionID) => {
      void rpc.events.emit("toast", { reason: "planSkipped", kind, sessionID }).catch(() => undefined)
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

    // 系统通知可能跑十几秒（PowerShell 探测）；必须在后台发，不能阻塞工具执行与事件分发。
    const toolBefore = await ctx.tool.hook("execute.before", (input) => {
      void notifier
        .handleToolBefore({ tool: input.tool, sessionID: input.sessionID })
        .catch(() => undefined)
      return Promise.resolve()
    })
    const toolAfter = await ctx.tool.hook("execute.after", async (input) => {
      // 与 token 记账、首次重建共用同一条会话串行链：并发工具调用不会互相覆盖计数与 lastTool。
      await runSerial(STATS_CHAINS, input.sessionID, async () => {
        // 归属与删除都在链内复查：会话可能在这条写入排队期间被删掉。
        if (statsDeleted.has(input.sessionID)) return
        if (!(await owns(input.sessionID))) return
        const stats = (await load(input.sessionID)) ?? emptyStats()
        stats.tools[input.tool] = (stats.tools[input.tool] ?? 0) + 1
        stats.lastTool = input.tool
        await saveStats(ctx.storage, input.sessionID, stats).catch(() => undefined)
      })
      // 工具刚执行完就通知侧栏刷新；失败不影响工具结果。
      void rpc.events.emit("panelUpdated", { sessionID: input.sessionID }).catch(() => undefined)
    })

    const handlers: EventHandler[] = [
      (event) => {
        // 通知是副作用且可能很慢；后台跑，不阻塞后面的 goal / 调度 / 记账 handler。
        void notifier.handle(event).catch(() => undefined)
        return Promise.resolve()
      },
      (event) => goal.handle(event),
      (event) => {
        // goal 记账发生在 step.ended；记账后再刷新，避免 TUI 读到旧 tokensUsed。
        if (event.type === "session.step.ended" || event.type === "session.step.failed") {
          const sessionID = readEventSessionID(event)
          if (sessionID !== undefined) emitPanelUpdated(sessionID)
        }
        return Promise.resolve()
      },
      (event) => scheduling.handle(event),
      // 统计累加：token 在 step.ended / step.failed，删除清理在 session.deleted。
      // 读存档 → 加 → 写回按会话串行；并发 step 事件共享同一个存档，不排队会互相覆盖。
      (event) => {
        const data = readEventData(event)
        if (event.type === "session.step.ended" || event.type === "session.step.failed") {
          const sessionID = readEventSessionID(event)
          if (sessionID === undefined) return Promise.resolve()
          const step = tokenParts(data?.["tokens"])
          // step.failed 只有部分失败带 tokens；没有就跳过，避免写一条空记录。
          if (event.type === "session.step.failed" && step.input === 0 && step.output === 0) {
            return Promise.resolve()
          }
          return runSerial(STATS_CHAINS, sessionID, async () => {
            // 已经删除的会话不再累计；迟到事件不能复活统计。
            if (statsDeleted.has(sessionID)) return
            if (!(await owns(sessionID))) return
            const stats = (await load(sessionID)) ?? emptyStats()
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
          // 与重建/增量同链：删除排在它们之后，先落墓碑再清存档，迟到保存会被墓碑挡住。
          return runSerial(STATS_CHAINS, sessionID, async () => {
            statsDeleted.add(sessionID)
            statsRebuilt.delete(sessionID)
            await removeStats(ctx.storage, sessionID).catch(() => undefined)
          })
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
