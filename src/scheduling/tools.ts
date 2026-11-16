import type { Plugin } from "@opencode/plugin"
import { Schema } from "effect"

import { diagnostic, diagnosticResult, type Diagnostic } from "../shared/diagnostic.ts"
import type { SessionRoles } from "../goal/session-role.ts"
import { loadSettings } from "../shared/settings-store.ts"
import { ToolOutput } from "../shared/tool-output.ts"
import { cronToHuman, explainCronError } from "./cron.ts"
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

const EmptyOutput = ToolOutput

import { truncate } from "../shared/format.ts"

/**
 * 输入：cron 表达式；输出：失败诊断，合法时 undefined。
 * 预期：字段数不对报「需要 5 段」，单字段出错由 explainCronError 精确到第几段、越界多少。
 */
function cronDiagnostic(cron: string): Diagnostic | undefined {
  const parts = cron.trim().split(/\s+/).filter((part) => part.length > 0)
  if (parts.length !== 5) {
    return diagnostic({
      tool: "cron_create",
      code: "CRON_FIELD_COUNT",
      summary: `cron expression needs exactly 5 fields, got ${String(parts.length)}`,
      at: "input.cron",
      expected: "M H DoM Mon DoW (5 space-separated fields)",
      got: cron,
      fix: "use 5 fields, e.g. \"0 9 * * 1-5\" for 09:00 on weekdays",
    })
  }
  const issue = explainCronError(cron)
  if (issue === undefined) return undefined
  return diagnostic({
    tool: "cron_create",
    code: "CRON_FIELD",
    summary: `invalid cron field ${String(issue.fieldIndex + 1)} (${issue.fieldName})`,
    at: `cron field ${String(issue.fieldIndex + 1)} (${issue.fieldName}), part ${String(issue.partIndex + 1)}`,
    expected: `${String(issue.min)}-${String(issue.max)} (or *, */n, a-b, a-b/n, comma list)`,
    got: `"${issue.part}" — ${issue.reason}`,
    excerpt: cron,
    fix: `fix field ${String(issue.fieldIndex + 1)} (${issue.fieldName}); allowed range ${String(issue.min)}-${String(issue.max)}`,
  })
}

/**
 * 输入：插件上下文、任务存储、循环调度器、会话角色、任务新增回调。
 * 输出：注册 cron_create / cron_list / cron_delete / schedule_wakeup。
 * 预期：关闭或子代理会话返回错误文本；不抛异常；新增任务时立即武装 timer。
 */
export async function registerSchedulingTools(
  ctx: Plugin.Context,
  store: SchedulingStore,
  scheduler: LoopScheduler,
  roles: SessionRoles,
  onJobAdded?: () => void,
): Promise<{ dispose(): Promise<void> }> {
  /** 输入：工具名 + 会话 ID；输出：不可用时的失败返回体，可用时为 null。 */
  const unavailable = async (tool: string, sessionID: string) => {
    const settings = await loadSettings(ctx)
    if (!settings.enabled || !settings.scheduling.enabled) {
      return diagnosticResult(
        diagnostic({
          tool,
          code: "FEATURE_DISABLED",
          summary: "the scheduling feature is disabled in settings",
          expected: "scheduling.enabled=true",
          got: "scheduling.enabled=false",
          fix: "turn the scheduling feature on in settings, then call again",
        }),
        {},
      )
    }
    if (await roles.isSubagent(sessionID)) {
      return diagnosticResult(
        diagnostic({
          tool,
          code: "SUBAGENT_DENIED",
          summary: "scheduling tools are not available to subagents",
          expected: "a top-level session",
          got: "a subagent session (parentID set)",
          fix: "call scheduling tools from the main session, not from a subagent",
        }),
        {},
      )
    }
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
        const blocked = await unavailable("cron_create", sessionID)
        if (blocked !== null) return blocked

        const prompt = input.prompt.trim()
        if (prompt.length === 0) {
          return diagnosticResult(
            diagnostic({
              tool: "cron_create",
              code: "EMPTY_PROMPT",
              summary: "prompt cannot be empty",
              at: "input.prompt",
              expected: "a non-empty prompt to inject at the scheduled time",
              got: "empty",
              fix: "describe what to run, e.g. { \"prompt\": \"check the build\" }",
            }),
            {},
          )
        }

        // 先做字段级精确校验：越界/步进/非法字段直接给出第几段、期望范围。
        const cronIssue = cronDiagnostic(input.cron)
        if (cronIssue !== undefined) return diagnosticResult(cronIssue, {})

        const result = await store.addJob({
          sessionID,
          cron: input.cron,
          prompt,
          recurring: input.recurring ?? true,
          // 默认持久化，与 /cron 对齐：工具创建的任务不该在插件重启后悄悄消失。
          durable: input.durable ?? true,
        })
        if (!result.ok) {
          return diagnosticResult(
            diagnostic({
              tool: "cron_create",
              code: "ADD_JOB_FAILED",
              summary: result.error,
              expected: "a schedulable job within limits",
              got: result.error,
              fix: "adjust the cron/prompt or cancel an existing job, then retry",
            }),
            {},
          )
        }
        onJobAdded?.()

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
        const blocked = await unavailable("cron_list", sessionID)
        if (blocked !== null) return blocked

        const jobs = store.listJobs(sessionID)
        if (jobs.length === 0) return { output: {}, content: "No scheduled jobs." }
        const lines = jobs.map((job) => {
          const kind = job.recurring === true ? "recurring" : "one-shot"
          const scope = job.durable === false ? " [session-only]" : ""
          return `${job.id} — ${cronToHuman(job.cron)} (${kind})${scope}: ${truncate(job.prompt, 80, 3)}`
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
        const blocked = await unavailable("cron_delete", sessionID)
        if (blocked !== null) return blocked

        const job = store.getJob(input.id)
        if (job === undefined) {
          return diagnosticResult(
            diagnostic({
              tool: "cron_delete",
              code: "JOB_NOT_FOUND",
              summary: `no scheduled job with id '${input.id}'`,
              at: "input.id",
              expected: "an existing 8-char job id",
              got: JSON.stringify(input.id),
              fix: "call cron_list first and copy an existing id",
            }),
            {},
          )
        }
        if (job.sessionID !== sessionID) {
          return diagnosticResult(
            diagnostic({
              tool: "cron_delete",
              code: "JOB_OTHER_SESSION",
              summary: `cron job '${input.id}' is owned by another session`,
              at: "input.id",
              expected: "a job belonging to this session",
              got: `job owned by session ${job.sessionID}`,
              fix: "call cron_list in this session and delete one of its own jobs",
            }),
            {},
          )
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
        const blocked = await unavailable("schedule_wakeup", sessionID)
        if (blocked !== null) return blocked

        if (input.stop === true) {
          const stopped = scheduler.stopLoopByPrompt(sessionID, input.prompt)
          if (!stopped) {
            return diagnosticResult(
              diagnostic({
                tool: "schedule_wakeup",
                code: "LOOP_NOT_FOUND",
                summary: `no active dynamic loop for prompt '${input.prompt}'`,
                at: "input.prompt",
                expected: "the exact prompt of an active dynamic loop",
                got: JSON.stringify(input.prompt),
                fix: "pass the same prompt that started the loop, or omit stop to schedule instead",
              }),
              {},
            )
          }
          return { output: {}, content: `Loop stopped: ${input.prompt}` }
        }

        const result = scheduler.scheduleWakeup(sessionID, input.prompt, input.delaySeconds, input.reason)
        if (!result.ok) {
          return diagnosticResult(
            diagnostic({
              tool: "schedule_wakeup",
              code: "WAKEUP_REJECTED",
              summary: result.error,
              at: "input.delaySeconds",
              expected: "60..3600 seconds with an active dynamic loop",
              got: String(input.delaySeconds),
              fix: "start a dynamic loop first and pass delaySeconds within 60-3600",
            }),
            {},
          )
        }
        return {
          output: {},
          content: `Wake-up scheduled for ${new Date(result.fireAt).toLocaleString()} (loop ${result.id}).`,
        }
      },
    })
  })
}
