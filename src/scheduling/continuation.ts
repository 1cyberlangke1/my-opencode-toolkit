// cron 任务触发（timer 为主 + idle 兜底，对齐 Claude Code cronScheduler 语义）：
// - 到点（nextRunAt）由 setTimeout 触发，即使会话静止也 fire；idle 事件兜底补查。
// - 到点「先无条件重排/删除」——无论注入成败时间都重置（倒计时不卡 0）。
// - 注入尽力而为：goal active 让路（shouldDeferFire）/ 末条 user 防叠加 / inFlight 防重。
// - 复用 goal 续作的注入模式：同步 prompt + 活动事件清 inFlight（勿改 promptAsync）。
// - 注入带哨兵 marker（<!-- CRON_AUTONOMOUS -->）+ 多语言 toast。

import type { ToolkitConfig } from "../config/types";
import { loadConfig } from "../config/load";
import { createTranslator, resolveLang } from "../i18n";
import { getSessionID } from "../notification/event-properties";
import { isRecurringTaskAged, type SchedulingStore } from "./store";
import type { ScheduledJob } from "./types";

const CRON_MARKER = "<!-- CRON_AUTONOMOUS -->";

export interface SchedulingContext {
  client: {
    session: {
      messages(id: string): Promise<
        Array<{
          info?: Record<string, unknown>;
          parts?: Array<{ type?: string; text?: string; state?: { status?: string } }>;
        }> | undefined
      >;
      prompt(
        id: string,
        body: {
          agent?: string;
          parts: Array<{ type: "text"; text: string; metadata?: Record<string, unknown> }>;
        },
      ): Promise<unknown>;
    };
    tui?: {
      showToast(body: {
        title?: string;
        message: string;
        variant: "info" | "success" | "warning" | "error";
        duration?: number;
      }): Promise<unknown>;
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
  return last?.info?.role === "user";
}

/** 读会话末条消息的 agent（plan 特判用，对齐 todo 的 resolveSessionAgent）。 */
export async function resolveSessionAgent(ctx: SchedulingContext, sessionID: string): Promise<string | undefined> {
  try {
    const messages = await ctx.client.session.messages(sessionID);
    if (!messages || messages.length === 0) return undefined;
    const last = messages.at(-1);
    const agent = last?.info?.agent;
    return typeof agent === "string" && agent.length > 0 ? agent : undefined;
  } catch {
    return undefined;
  }
}

export type SchedulingContinuation = ((input: EventInput) => Promise<boolean>) & {
  /** 为所有未到期的 cron 重新武装到点 timer（addJob/load 后调用）。 */
  armTimers: () => void;
};

export function createSchedulingContinuation(args: {
  store: SchedulingStore;
  ctx: SchedulingContext;
  /** 返回 true 时本轮注入让路（如 goal active 优先），但到点重排仍执行。 */
  shouldDeferFire?: (sessionID: string) => boolean | Promise<boolean>;
}): SchedulingContinuation {
  const { store, ctx, shouldDeferFire } = args;
  const loadConfigFn = ctx.loadConfigOverride ?? loadConfig;
  const inFlight = new Set<string>();
  const cronTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const inject = async (sessionID: string, text: string): Promise<boolean> => {
    if (inFlight.has(sessionID)) return false;
    inFlight.add(sessionID);
    try {
      // 消息发送后立即弹 toast（不等 prompt resolve——同步 prompt 会挂起到 AI 回复完）。
      const pending = ctx.client.session.prompt(sessionID, {
        parts: [{ type: "text", text, metadata: { cronContinuation: true } }],
      });
      showInjectedToast();
      await pending;
      return true;
    } catch {
      return false;
    } finally {
      inFlight.delete(sessionID);
    }
  };

  /** 注入成功后的多语言 toast（对齐 goal 的 showInjectedToast）。 */
  const showInjectedToast = (): void => {
    const cfg = loadConfigFn();
    if (!cfg.enabled || !cfg.scheduling.enabled) return;
    const lang = resolveLang(cfg.lang, process.env);
    const t = createTranslator(lang);
    void ctx.client.tui?.showToast({
      title: t("schedulingCommand.title"),
      message: t("schedulingCommand.injected"),
      variant: "info",
    }).catch(() => undefined);
  };

  /**
   * 处理一次到点：① 先无条件重排/删除（倒计时立即恢复，不依赖注入结果）② 再尽力注入。
   * 返回是否注入了（协调层据此跳过 todo）。
   */
  const handleCronFire = async (job: ScheduledJob): Promise<boolean> => {
    const now = Date.now();
    const aged = isRecurringTaskAged(job, now);
    // ① 先重排/删除——到 0 无论成败都重置（主人要求），不被同步 prompt 挂起阻塞。
    if (aged || !job.recurring) {
      await store.removeJobs([job.id]);
    } else {
      await store.markFired([job.id], now);
    }
    armCronTimers();
    // ② 尽力注入：goal active / plan 让路（shouldDeferFire）、末条 user 防叠加、inFlight 防重。
    if (shouldDeferFire !== undefined && (await shouldDeferFire(job.sessionID))) return false;
    if (await lastMessageIsUser(ctx, job.sessionID)) return false;
    return await inject(job.sessionID, buildFirePrompt(job, new Date(now)));
  };

  /** 为所有未到期的 cron 武装 setTimeout（到点触发 handleCronFire；不依赖 idle 事件）。 */
  const armCronTimers = (): void => {
    for (const job of store.listJobs()) {
      if (job.nextRunAt === undefined) continue;
      const delay = job.nextRunAt - Date.now();
      if (delay <= 0) continue; // 已到点：由 idle 兜底处理
      if (cronTimers.has(job.id)) continue;
      const handle = setTimeout(() => {
        cronTimers.delete(job.id);
        const fresh = store.getJob(job.id);
        if (fresh !== undefined) void handleCronFire(fresh);
      }, delay);
      handle.unref();
      cronTimers.set(job.id, handle);
    }
  };

  const clearTimers = (): void => {
    for (const timer of cronTimers.values()) clearTimeout(timer);
    cronTimers.clear();
  };

  /** idle 兜底：到点任务处理；无到点则 arm 未来 timer。 */
  const handleIdle = async (sessionID: string): Promise<boolean> => {
    const cfg = loadConfigFn();
    if (!cfg.enabled || !cfg.scheduling.enabled) return false;
    const now = Date.now();
    const due = store
      .listJobs(sessionID)
      .filter((job) => job.nextRunAt !== undefined && job.nextRunAt <= now)
      .sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity));
    const job = due[0];
    if (job) return await handleCronFire(job);
    armCronTimers();
    return false;
  };

  const handler = async (input: EventInput): Promise<boolean> => {
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
      clearTimers();
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

  return Object.assign(handler, { armTimers: armCronTimers });
}
