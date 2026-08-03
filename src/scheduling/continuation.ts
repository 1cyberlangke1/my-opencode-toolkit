// cron 任务 idle 触发（对齐 Claude Code cronScheduler + useScheduledTasks 语义）：
// - 只在 session idle 时 fire（openCode 的 idle 事件等价 Claude 的 isLoading gate + 轮间 drain）。
// - recurring fire 后从 now 重排（无 catch-up）；one-shot fire 后自删；7 天过期最后火一次。
// - 复用 goal 续作的注入模式：同步 prompt + inFlight + 活动事件清 inFlight（勿改 promptAsync）。
// - 注入带哨兵 marker（<!-- CRON_AUTONOMOUS -->），模型知道自己在无人值守循环里。

import type { ToolkitConfig } from "../config/types";
import { loadConfig } from "../config/load";
import { getSessionID } from "../notification/event-properties";
import { isRecurringTaskAged, type SchedulingStore } from "./store";
import type { ScheduledJob } from "./types";

const CRON_MARKER = "<!-- CRON_AUTONOMOUS -->";

export interface SchedulingContext {
  client: {
    session: {
      messages(id: string): Promise<
        Array<{ info: Record<string, unknown>; parts?: Array<{ type?: string; text?: string; state?: { status?: string } }> }> | undefined
      >;
      prompt(
        id: string,
        body: {
          agent?: string;
          parts: Array<{ type: "text"; text: string; metadata?: Record<string, unknown> }>;
        },
      ): Promise<unknown>;
    };
  };
  loadConfigOverride?: () => ToolkitConfig;
}

interface EventInput {
  event: { type: string; properties?: unknown };
}

/** 对齐 goal 的 formatCronFireTime 风格：`Running scheduled task (Nov 3, 2:30pm)`。 */
function formatFireTime(d: Date): string {
  return d
    .toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })
    .replace(/,? at |, /, " ")
    .replace(/ ([AP]M)/, (_, ampm: string) => ampm.toLowerCase());
}

function buildFirePrompt(job: ScheduledJob, now: Date): string {
  return `Running scheduled task (${formatFireTime(now)})\n\n${job.prompt}\n\n${CRON_MARKER}`;
}

/** 末条消息是 user（上次注入还没被 AI 回复）→ 跳过，防重复注入。 */
async function lastMessageIsUser(ctx: SchedulingContext, sessionID: string): Promise<boolean> {
  const messages = await ctx.client.session.messages(sessionID).catch(() => undefined);
  if (!messages || messages.length === 0) return false;
  const last = messages.at(-1);
  return last?.info.role === "user";
}

export function createSchedulingContinuation(args: {
  store: SchedulingStore;
  ctx: SchedulingContext;
}): (input: EventInput) => Promise<boolean> {
  const { store, ctx } = args;
  const loadConfigFn = ctx.loadConfigOverride ?? loadConfig;
  const inFlight = new Set<string>();

  const inject = async (sessionID: string, text: string): Promise<boolean> => {
    if (inFlight.has(sessionID)) return false;
    inFlight.add(sessionID);
    try {
      await ctx.client.session.prompt(sessionID, {
        parts: [{ type: "text", text, metadata: { cronContinuation: true } }],
      });
      return true;
    } catch {
      return false;
    } finally {
      inFlight.delete(sessionID);
    }
  };

  /** 返回 true = 本次 idle 注入了一条续作（协调层据此跳过 todo）。 */
  const handleIdle = async (sessionID: string): Promise<boolean> => {
    const cfg = loadConfigFn();
    if (!cfg.enabled || !cfg.scheduling.enabled) return false;

    const now = Date.now();
    const due = store
      .listJobs(sessionID)
      .filter((job) => job.nextRunAt !== undefined && job.nextRunAt <= now)
      .sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity));
    const job = due[0];
    if (!job) return false;

    // 上次注入还没被 AI 回复 → 不重复 fire。
    if (await lastMessageIsUser(ctx, sessionID)) return false;

    const ok = await inject(sessionID, buildFirePrompt(job, new Date(now)));
    if (!ok) return false;

    if (isRecurringTaskAged(job, now)) {
      // 7 天过期：最后 fire 一次后删除。
      await store.removeJobs([job.id]);
    } else if (job.recurring) {
      // recurring：从 now 重排（无 catch-up），锚点持久化。
      await store.markFired([job.id], now);
    } else {
      // one-shot：fire 后自删。
      await store.removeJobs([job.id]);
    }
    return true;
  };

  return async (input: EventInput): Promise<boolean> => {
    const { event } = input;
    const props = event.properties as Record<string, unknown> | undefined;

    if (event.type === "session.idle") {
      const sessionID = getSessionID(props);
      if (sessionID) return await handleIdle(sessionID);
      return false;
    }

    if (event.type === "session.deleted") {
      const sessionID = getSessionID(props);
      if (sessionID) {
        const jobs = store.listJobs(sessionID);
        await store.removeJobs(jobs.map((job) => job.id));
        inFlight.delete(sessionID);
      }
      return false;
    }

    // 活动事件释放 inFlight，防止同步 prompt 挂起锁死后续 fire。
    if (
      event.type === "message.updated" ||
      event.type === "message.part.updated" ||
      event.type === "message.part.delta" ||
      event.type === "tool.execute.before" ||
      event.type === "tool.execute.after"
    ) {
      const sessionID = getSessionID(props);
      if (sessionID) inFlight.delete(sessionID);
      return false;
    }
    return false;
  };
}
