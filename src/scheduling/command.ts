import { readFile } from "node:fs/promises"
import { join } from "node:path"

import type { Plugin } from "@opencode/plugin"

import type { SessionRoles } from "../goal/session-role.ts"
import { loadSettings } from "../shared/settings-store.ts"
import type { LoopScheduler } from "./loops.ts"
import type { SchedulingStore } from "./store.ts"
import { cronToHuman } from "./cron.ts"

/** 内置维护提示词（没有 `loop.md` 时的默认）。 */
export const DEFAULT_LOOP_MAINTENANCE_PROMPT =
  "Continue unfinished work in this session. Re-read AGENTS.md and progress files, pick the next concrete step, " +
  "and keep going. Run cleanup passes when appropriate."

/** `/loop` 解析结果。 */
export type LoopCommand =
  | { readonly kind: "start"; readonly prompt: string; readonly intervalSeconds?: number }
  | { readonly kind: "stop" }

/**
 * 输入：`5m` / `30s` / `2h` / `1d` 形式。
 * 输出：秒数（秒向上取整到分钟，最小 60），非法返回 undefined。
 */
export function parseIntervalSeconds(value: string): number | undefined {
  const match = /^(\d+)([smhd])$/.exec(value)
  if (match === null) return undefined
  const amount = Number.parseInt(match[1] ?? "", 10)
  const unit = match[2]
  if (!Number.isFinite(amount) || amount <= 0) return undefined
  switch (unit) {
    case "s":
      return Math.max(60, Math.ceil(amount / 60) * 60)
    case "m":
      return amount * 60
    case "h":
      return amount * 3600
    case "d":
      return amount * 86400
    default:
      return undefined
  }
}

/**
 * 输入：`/loop` 参数。
 * 输出：停止，或带可选固定间隔的启动参数。
 * 预期：首个 token 是合法间隔则剥离，剩余为 prompt；`stop` 单独处理。
 */
export function parseLoopCommand(rawArgs: string): LoopCommand {
  const trimmed = rawArgs.trim()
  if (trimmed.toLowerCase() === "stop") return { kind: "stop" }
  const parts = trimmed.split(/\s+/)
  const first = parts[0]
  if (first === undefined || first === "") return { kind: "start", prompt: "" }

  const intervalSeconds = parseIntervalSeconds(first)
  if (intervalSeconds === undefined) return { kind: "start", prompt: trimmed }
  return { kind: "start", prompt: parts.slice(1).join(" ").trim(), intervalSeconds }
}

/** 输入：项目目录；输出：维护提示词。预期：`loop.md` 非空时优先。 */
async function loadMaintenancePrompt(directory: string | undefined): Promise<string> {
  if (directory === undefined) return DEFAULT_LOOP_MAINTENANCE_PROMPT
  try {
    const raw = (await readFile(join(directory, "loop.md"), "utf8")).trim()
    return raw.length > 0 ? raw : DEFAULT_LOOP_MAINTENANCE_PROMPT
  } catch {
    return DEFAULT_LOOP_MAINTENANCE_PROMPT
  }
}

/**
 * 输入：`/cron` 参数。
 * 输出：`{ expr, prompt }` 或错误文本。
 * 预期：前 5 个 token 是 cron 表达式，剩余为 prompt。
 */
function splitCron(rest: string): { expr: string; prompt: string } | null {
  const parts = rest.trim().split(/\s+/)
  if (parts.length < 6) return null
  return { expr: parts.slice(0, 5).join(" "), prompt: parts.slice(5).join(" ") }
}

/**
 * 输入：插件上下文、任务存储、循环调度器、会话角色。
 * 输出：注册 `/loop` 与 `/cron` 命令。
 * 预期：命令自身不进对话流；执行结果作为普通 prompt 发回当前会话。
 */
export async function registerSchedulingCommands(
  ctx: Plugin.Context,
  store: SchedulingStore,
  scheduler: LoopScheduler,
  roles: SessionRoles,
): Promise<{ dispose(): Promise<void> }> {
  /** 输入：会话 ID；输出：不可用原因，可用时为 null。 */
  const unavailable = async (sessionID: string): Promise<string | null> => {
    const settings = await loadSettings(ctx.storage)
    if (!settings.enabled || !settings.scheduling.enabled) return "Error: the scheduling feature is disabled in settings."
    if (await roles.isSubagent(sessionID)) return "Error: scheduling commands are not available to subagents."
    return null
  }

  const registration = await ctx.command.transform((editor) => {
    editor.add({
      name: "loop",
      description: "Start or stop a recurring prompt loop in this session",
      execute: async (input) => {
        const parsed = parseLoopCommand(input.prompt.text)
        // stop 即使功能关闭也要能执行，否则用户没法停掉正在跑的循环。
        const blocked = parsed.kind === "stop" ? null : await unavailable(input.sessionID)
        const text = await (async (): Promise<string> => {
          if (blocked !== null) return blocked
          if (parsed.kind === "stop") {
            const count = scheduler.stopAllLoops(input.sessionID)
            return count === 0 ? "No active loop." : `Stopped ${String(count)} loop(s).`
          }
          const prompt = parsed.prompt.length > 0 ? parsed.prompt : await loadMaintenancePrompt(ctx.location.directory)
          const loop = scheduler.startLoop(input.sessionID, prompt, parsed.intervalSeconds)
          return loop.mode === "fixed"
            ? `Loop ${loop.id} started: every ${String(loop.intervalSeconds ?? 0)}s — ${prompt}`
            : `Loop ${loop.id} started (dynamic): ${prompt}`
        })()
        await ctx.session.prompt({ sessionID: input.sessionID, text, delivery: input.delivery })
      },
    })

    editor.add({
      name: "cron",
      description: "Create, list or delete scheduled prompts for this session",
      execute: async (input) => {
        const raw = input.prompt.text.trim()
        // list / delete 属于清理操作，功能关闭时也允许；只有创建需要开关。
        const readOnly = raw === "" || raw.toLowerCase() === "list" || /^delete\s+\S+$/i.test(raw)
        const blocked = readOnly ? null : await unavailable(input.sessionID)
        const text = await (async (): Promise<string> => {
          if (blocked !== null) return blocked

          if (raw === "" || raw.toLowerCase() === "list") {
            const jobs = store.listJobs(input.sessionID)
            if (jobs.length === 0) return "No scheduled jobs."
            return jobs
              .map((job) => {
                const kind = job.recurring === true ? "recurring" : "one-shot"
                return `${job.id} — ${cronToHuman(job.cron)} (${kind}): ${job.prompt}`
              })
              .join("\n")
          }

          const deleteMatch = /^delete\s+(\S+)$/i.exec(raw)
          if (deleteMatch !== null) {
            const id = deleteMatch[1] ?? ""
            const job = store.getJob(id)
            if (job === undefined) return `Error: No scheduled job with id '${id}'`
            if (job.sessionID !== input.sessionID) return `Error: Cannot delete cron job '${id}': owned by another session`
            await store.removeJobs([id])
            return `Cancelled job ${id}.`
          }

          const once = /^once\s+(.+)$/is.exec(raw)
          const body = once === null ? raw : (once[1] ?? "")
          const split = splitCron(body)
          if (split === null) return "Usage: /cron <expr> <prompt> | /cron once <expr> <prompt> | /cron list | /cron delete <id>"

          const result = await store.addJob({
            sessionID: input.sessionID,
            cron: split.expr,
            prompt: split.prompt,
            recurring: once === null,
            durable: true,
          })
          if (!result.ok) return `Error: ${result.error}`
          const job = result.job
          return job.recurring === true
            ? `Scheduled recurring job ${job.id} (${cronToHuman(job.cron)}): ${job.prompt}`
            : `Scheduled one-shot task ${job.id} (${cronToHuman(job.cron)}): ${job.prompt}`
        })()
        await ctx.session.prompt({ sessionID: input.sessionID, text, delivery: input.delivery })
      },
    })
  })
  await ctx.command.reload()
  return registration
}
