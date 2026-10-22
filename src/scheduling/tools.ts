import type { Plugin } from "@opencode/plugin"
import { Schema } from "effect"

import type { SessionRoles } from "../goal/session-role.ts"
import { loadSettings } from "../shared/settings-store.ts"
import { cronToHuman } from "./cron.ts"
import type { LoopScheduler } from "./loops.ts"
import type { SchedulingStore } from "./store.ts"
import { DEFAULT_MAX_AGE_DAYS } from "./types.ts"

const DESCRIPTION_CREATE =
  'Schedule a recurring or one-shot prompt in this session using a 5-field cron expression ' +
  '(local time: "M H DoM Mon DoW"). The prompt is auto-injected when the session is idle at the ' +
  `scheduled time (no catch-up for missed fires). Recurring tasks auto-expire after ${String(DEFAULT_MAX_AGE_DAYS)} ` +
  "days. Use cron_delete to cancel sooner."

const DESCRIPTION_LIST = "List all scheduled jobs for this session with their ids, schedules, and prompts."

const DESCRIPTION_DELETE = "Cancel a scheduled job by its 8-character id (returned by cron_create)."

const DESCRIPTION_WAKEUP =
  "Schedule when to resume work in /loop dynamic mode. Only works when there is an active dynamic " +
  "loop in this session with the exact same prompt. Pass the loop prompt back verbatim to continue; " +
  "omit this call to end the loop. delaySeconds is clamped to 60-3600. Set stop: true to end the " +
  "loop immediately."

const CreateInput = Schema.Struct({
  cron: Schema.String,
  prompt: Schema.String,
  recurring: Schema.optional(Schema.Boolean),
  durable: Schema.optional(Schema.Boolean),
})

const EmptyInput = Schema.Struct({})

const DeleteInput = Schema.Struct({ id: Schema.String })

const WakeupInput = Schema.Struct({
  delaySeconds: Schema.Number,
  prompt: Schema.String,
  reason: Schema.String,
  stop: Schema.optional(Schema.Boolean),
})

const EmptyOutput = Schema.Struct({})

/** 输入：文本 + 上限；输出：超长时截断并加省略号。 */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

/**
 * 输入：插件上下文、任务存储、循环调度器、会话角色。
 * 输出：注册 cron_create / cron_list / cron_delete / schedule_wakeup。
 * 预期：关闭或子代理会话返回错误文本；不抛异常。
 */
export async function registerSchedulingTools(
  ctx: Plugin.Context,
  store: SchedulingStore,
  scheduler: LoopScheduler,
  roles: SessionRoles,
): Promise<{ dispose(): Promise<void> }> {
  /** 输入：会话 ID；输出：不可用原因，可用时为 null。 */
  const unavailable = async (sessionID: string): Promise<string | null> => {
    const settings = await loadSettings(ctx.storage)
    if (!settings.enabled || !settings.scheduling.enabled) {
      return "Error: the scheduling feature is disabled in settings."
    }
    if (await roles.isSubagent(sessionID)) return "Error: scheduling tools are not available to subagents."
    return null
  }

  return ctx.tool.transform((tools) => {
    tools.add({
      name: "cron_create",
      options: { codemode: false },
      description: DESCRIPTION_CREATE,
      input: CreateInput,
      output: EmptyOutput,
      execute: async (input, toolCtx) => {
        const sessionID = toolCtx.sessionID
        const blocked = await unavailable(sessionID)
        if (blocked !== null) return { output: {}, content: blocked }

        const prompt = input.prompt.trim()
        if (prompt.length === 0) return { output: {}, content: "Error: prompt cannot be empty." }

        const result = await store.addJob({
          sessionID,
          cron: input.cron,
          prompt,
          recurring: input.recurring ?? true,
          durable: input.durable ?? false,
        })
        if (!result.ok) return { output: {}, content: `Error: ${result.error}` }

        const job = result.job
        const where =
          job.durable === true
            ? "Persisted in plugin storage and survives restarts"
            : "Session-only (dies when the plugin restarts)"
        const content =
          job.recurring === true
            ? `Scheduled recurring job ${job.id} (${cronToHuman(job.cron)}). ${where}. Auto-expires after ${String(DEFAULT_MAX_AGE_DAYS)} days. Use cron_delete to cancel sooner.`
            : `Scheduled one-shot task ${job.id} (${cronToHuman(job.cron)}). ${where}. It will fire once then auto-delete.`
        return { output: {}, content }
      },
    })

    tools.add({
      name: "cron_list",
      options: { codemode: false },
      description: DESCRIPTION_LIST,
      input: EmptyInput,
      output: EmptyOutput,
      execute: async (_input, toolCtx) => {
        const sessionID = toolCtx.sessionID
        const blocked = await unavailable(sessionID)
        if (blocked !== null) return { output: {}, content: blocked }

        const jobs = store.listJobs(sessionID)
        if (jobs.length === 0) return { output: {}, content: "No scheduled jobs." }
        const lines = jobs.map((job) => {
          const kind = job.recurring === true ? "recurring" : "one-shot"
          const scope = job.durable === false ? " [session-only]" : ""
          return `${job.id} — ${cronToHuman(job.cron)} (${kind})${scope}: ${truncate(job.prompt, 80)}`
        })
        return { output: {}, content: lines.join("\n") }
      },
    })

    tools.add({
      name: "cron_delete",
      options: { codemode: false },
      description: DESCRIPTION_DELETE,
      input: DeleteInput,
      output: EmptyOutput,
      execute: async (input, toolCtx) => {
        const sessionID = toolCtx.sessionID
        const blocked = await unavailable(sessionID)
        if (blocked !== null) return { output: {}, content: blocked }

        const job = store.getJob(input.id)
        if (job === undefined) return { output: {}, content: `Error: No scheduled job with id '${input.id}'` }
        if (job.sessionID !== sessionID) {
          return { output: {}, content: `Error: Cannot delete cron job '${input.id}': owned by another session` }
        }
        await store.removeJobs([input.id])
        return { output: {}, content: `Cancelled job ${input.id}.` }
      },
    })

    tools.add({
      name: "schedule_wakeup",
      options: { codemode: false },
      description: DESCRIPTION_WAKEUP,
      input: WakeupInput,
      output: EmptyOutput,
      execute: async (input, toolCtx) => {
        const sessionID = toolCtx.sessionID
        const blocked = await unavailable(sessionID)
        if (blocked !== null) return { output: {}, content: blocked }

        if (input.stop === true) {
          const stopped = scheduler.stopLoopByPrompt(sessionID, input.prompt)
          return {
            output: {},
            content: stopped
              ? `Loop stopped: ${input.prompt}`
              : `Error: no active dynamic loop for prompt '${input.prompt}'`,
          }
        }

        const result = scheduler.scheduleWakeup(sessionID, input.prompt, input.delaySeconds, input.reason)
        if (!result.ok) return { output: {}, content: `Error: ${result.error}` }
        return {
          output: {},
          content: `Wake-up scheduled for ${new Date(result.fireAt).toLocaleString()} (loop ${result.id}).`,
        }
      },
    })
  })
}
