// CronCreate/CronList/CronDelete 工具（对齐 Claude Code Cron* 契约，见 PLAN.md §0）。
// 工具对子代理不可用（isSubagent 阻断）；任务按会话归属，跨会话不可删。

import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { cronToHuman } from "./cron";
import type { SchedulingScheduler } from "./scheduler";
import type { SchedulingStore } from "./store";
import { DEFAULT_MAX_AGE_DAYS } from "./types";

export interface SchedulingToolsDeps {
  store: SchedulingStore;
  scheduler: SchedulingScheduler;
  getSessionID: () => string | undefined;
  isSubagent: (sessionID: string) => Promise<boolean>;
}

const SUBAGENT_MSG = "Error: scheduling tools are not available to subagents.";

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

export function cronCreateTool(deps: SchedulingToolsDeps): ToolDefinition {
  return tool({
    description: `Schedule a recurring or one-shot prompt in this session using a 5-field cron expression (local time: "M H DoM Mon DoW").

The prompt is auto-injected when the session is idle at the scheduled time (no catch-up for missed fires). Recurring tasks auto-expire after ${DEFAULT_MAX_AGE_DAYS} days. Use cron_delete to cancel sooner.`,
    args: {
      cron: tool.schema
        .string()
        .describe('Standard 5-field cron expression in local time: "M H DoM Mon DoW" (e.g. "*/5 * * * *" = every 5 minutes)'),
      prompt: tool.schema.string().describe("The prompt to inject at each fire time."),
      recurring: tool.schema
        .boolean()
        .optional()
        .describe("true (default) = fire on every cron match until deleted or auto-expired after 7 days. false = fire once at the next match, then auto-delete."),
      durable: tool.schema
        .boolean()
        .optional()
        .describe("true = persist to disk and survive restarts. false (default) = in-memory only, dies when this session ends."),
    },
    execute: async (args, context) => {
      const sessionID = deps.getSessionID() ?? context.sessionID;
      if (await deps.isSubagent(sessionID)) return SUBAGENT_MSG;

      const prompt = args.prompt.trim();
      if (prompt.length === 0) return "Error: prompt cannot be empty.";

      const recurring = args.recurring ?? true;
      const durable = args.durable ?? false;
      const result = await deps.store.addJob({
        sessionID,
        cron: args.cron,
        prompt,
        recurring,
        durable,
      });
      if (!result.ok) return `Error: ${result.error}`;

      const job = result.job;
      const where = job.durable
        ? "Persisted to .opencode-toolkit/scheduling/jobs.json"
        : "Session-only (not written to disk, dies when the session ends)";
      return job.recurring
        ? `Scheduled recurring job ${job.id} (${cronToHuman(job.cron)}). ${where}. Auto-expires after ${DEFAULT_MAX_AGE_DAYS} days. Use cron_delete to cancel sooner.`
        : `Scheduled one-shot task ${job.id} (${cronToHuman(job.cron)}). ${where}. It will fire once then auto-delete.`;
    },
  });
}

export function cronListTool(deps: SchedulingToolsDeps): ToolDefinition {
  return tool({
    description: "List all scheduled jobs for this session with their ids, schedules, and prompts.",
    args: {},
    execute: async (_args, context) => {
      const sessionID = deps.getSessionID() ?? context.sessionID;
      if (await deps.isSubagent(sessionID)) return SUBAGENT_MSG;

      const jobs = deps.store.listJobs(sessionID);
      if (jobs.length === 0) return "No scheduled jobs.";
      return jobs
        .map((job) => {
          const kind = job.recurring ? "recurring" : "one-shot";
          const session = job.durable === false ? " [session-only]" : "";
          return `${job.id} — ${cronToHuman(job.cron)} (${kind})${session}: ${truncate(job.prompt, 80)}`;
        })
        .join("\n");
    },
  });
}

export function cronDeleteTool(deps: SchedulingToolsDeps): ToolDefinition {
  return tool({
    description: "Cancel a scheduled job by its 8-character id (returned by cron_create).",
    args: {
      id: tool.schema.string().describe("Job ID returned by cron_create."),
    },
    execute: async (args, context) => {
      const sessionID = deps.getSessionID() ?? context.sessionID;
      if (await deps.isSubagent(sessionID)) return SUBAGENT_MSG;

      const job = deps.store.getJob(args.id);
      if (job === undefined) return `Error: No scheduled job with id '${args.id}'`;
      if (job.sessionID !== sessionID) {
        return `Error: Cannot delete cron job '${args.id}': owned by another session`;
      }
      await deps.store.removeJobs([args.id]);
      return `Cancelled job ${args.id}.`;
    },
  });
}

export function scheduleWakeupTool(deps: SchedulingToolsDeps): ToolDefinition {
  return tool({
    description: `Schedule when to resume work in /loop dynamic mode.

Only works when there is an active dynamic loop in this session with the exact same prompt. Pass the loop prompt back verbatim to continue; omit this call to end the loop. delaySeconds is clamped to [60, 3600]. Set stop: true to end the loop immediately.`,
    args: {
      delaySeconds: tool.schema.number().describe("Seconds until wake-up. Clamped to 60-3600."),
      prompt: tool.schema.string().describe("The /loop prompt to fire on wake-up. Pass it back verbatim to continue."),
      reason: tool.schema.string().describe("One sentence explaining why this wake-up is scheduled."),
      stop: tool.schema.boolean().optional().describe("true = end the loop immediately."),
    },
    execute: async (args, context) => {
      const sessionID = deps.getSessionID() ?? context.sessionID;
      if (await deps.isSubagent(sessionID)) return SUBAGENT_MSG;
      if (args.stop) {
        const stopped = deps.scheduler.stopLoopByPrompt(sessionID, args.prompt);
        return stopped
          ? `Loop stopped: ${args.prompt}`
          : `Error: no active dynamic loop for prompt '${args.prompt}'`;
      }
      const result = deps.scheduler.scheduleWakeup(sessionID, args.prompt, args.delaySeconds, args.reason);
      if (!result.ok) return `Error: ${result.error}`;
      return `Wake-up scheduled for ${new Date(result.fireAt).toLocaleString()} (loop ${result.id}).`;
    },
  });
}

export function createSchedulingTools(deps: SchedulingToolsDeps): Record<string, ToolDefinition> {
  return {
    cron_create: cronCreateTool(deps),
    cron_list: cronListTool(deps),
    cron_delete: cronDeleteTool(deps),
    schedule_wakeup: scheduleWakeupTool(deps),
  };
}
