// scheduling 存储：durable 任务写盘、session 任务仅内存、重启恢复、7 天过期、50 上限。
// 语义对齐 Claude Code cronTasks.ts（见 PLAN.md §0）；写盘剥离 durable/nextRunAt 运行时字段。

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_CRON_JITTER_CONFIG,
  jitteredNextCronRunMs,
  nextCronRunMs,
  oneShotJitteredNextCronRunMs,
  parseCronExpression,
} from "./cron";
import { JOB_ID_LENGTH, MAX_JOBS, type ScheduledJob } from "./types";

/** 持久化文件路径（相对项目根）。 */
const JOBS_FILE = path.join(".opencode-toolkit", "scheduling", "jobs.json");

/** 磁盘上的任务形状：无 durable/nextRunAt 运行时字段。 */
type StoredTask = Omit<ScheduledJob, "durable" | "nextRunAt">;
type JobsFile = { tasks: StoredTask[] };

export interface AddJobInput {
  sessionID: string;
  cron: string;
  prompt: string;
  recurring?: boolean;
  durable?: boolean;
  permanent?: boolean;
}

export type AddJobResult = { ok: true; job: ScheduledJob } | { ok: false; error: string };

export interface SchedulingStore {
  /** 插件启动时恢复 durable 任务（幂等）。 */
  load(): Promise<void>;
  /** 新增定时任务（校验 + 计算 nextRunAt）。 */
  addJob(input: AddJobInput): Promise<AddJobResult>;
  /** 列出全部或某会话任务（含 session + durable）。 */
  listJobs(sessionID?: string): ScheduledJob[];
  getJob(id: string): ScheduledJob | undefined;
  /** 按 id 删除（内存 + durable 写盘）。 */
  removeJobs(ids: string[]): Promise<void>;
  /** 标记已 fire：写 lastFiredAt，recurring 从 now 重排 nextRunAt（无 catch-up），durable 写盘。 */
  markFired(ids: string[], firedAt: number): Promise<void>;
  count(): number;
}

/**
 * recurring 任务创建超过 maxAgeMs 且非 permanent 即视为过期（7 天）。
 * maxAgeMs=0 表示永不过期。
 */
export function isRecurringTaskAged(
  task: ScheduledJob,
  nowMs: number,
  maxAgeMs: number = DEFAULT_CRON_JITTER_CONFIG.recurringMaxAgeMs,
): boolean {
  if (maxAgeMs === 0) return false;
  return Boolean(task.recurring && !task.permanent && nowMs - task.createdAt >= maxAgeMs);
}

/** nextRunAt：recurring 用 jittered、one-shot 用 oneShotJittered。 */
function computeNextRunAt(job: ScheduledJob, fromMs: number): number | null {
  return job.recurring
    ? jitteredNextCronRunMs(job.cron, fromMs, job.id)
    : oneShotJitteredNextCronRunMs(job.cron, fromMs, job.id);
}

function toStoredTask(job: ScheduledJob): StoredTask {
  // 显式构造以剥离 durable/nextRunAt 运行时字段（磁盘上即 durable）。
  return {
    id: job.id,
    sessionID: job.sessionID,
    cron: job.cron,
    prompt: job.prompt,
    createdAt: job.createdAt,
    ...(job.lastFiredAt !== undefined ? { lastFiredAt: job.lastFiredAt } : {}),
    ...(job.recurring ? { recurring: true } : {}),
    ...(job.permanent ? { permanent: true } : {}),
  };
}

export function createSchedulingStore(dir: string): SchedulingStore {
  const jobs = new Map<string, ScheduledJob>();
  const filePath = path.join(dir, JOBS_FILE);

  const writeDurable = async (): Promise<void> => {
    const durable = [...jobs.values()].filter((j) => j.durable !== false);
    await mkdir(path.dirname(filePath), { recursive: true });
    const body: JobsFile = { tasks: durable.map(toStoredTask) };
    const tmp = `${filePath}.tmp`;
    await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf-8");
    await rename(tmp, filePath);
  };

  const load = async (): Promise<void> => {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch {
      return; // 文件不存在 = 无 durable 任务
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const tasks = (parsed as { tasks?: unknown[] }).tasks;
    if (!Array.isArray(tasks)) return;

    for (const raw of tasks) {
      if (typeof raw !== "object" || raw === null) continue;
      // 运行时字段未知，用 Record 收窄做逐字段校验，跳过 malformed / 非法 cron。
      const t = raw as Record<string, unknown>;
      if (
        typeof t.id !== "string" ||
        typeof t.sessionID !== "string" ||
        typeof t.cron !== "string" ||
        typeof t.prompt !== "string" ||
        typeof t.createdAt !== "number"
      ) {
        continue;
      }
      if (!parseCronExpression(t.cron)) continue;
      const job: ScheduledJob = {
        id: t.id,
        sessionID: t.sessionID,
        cron: t.cron,
        prompt: t.prompt,
        createdAt: t.createdAt,
        ...(typeof t.lastFiredAt === "number" ? { lastFiredAt: t.lastFiredAt } : {}),
        ...(t.recurring ? { recurring: true } : {}),
        ...(t.permanent ? { permanent: true } : {}),
      };
      // 锚点：lastFiredAt ?? createdAt，重建与内存一致的 nextRunAt。
      const next = computeNextRunAt(job, job.lastFiredAt ?? job.createdAt);
      if (next !== null) job.nextRunAt = next;
      jobs.set(job.id, job);
    }
  };

  const addJob = async (input: AddJobInput): Promise<AddJobResult> => {
    const { sessionID, cron, prompt, recurring = false, durable = false, permanent = false } = input;
    if (!parseCronExpression(cron)) {
      return { ok: false, error: `Invalid cron expression '${cron}'. Expected 5 fields: M H DoM Mon DoW.` };
    }
    if (nextCronRunMs(cron, Date.now()) === null) {
      return { ok: false, error: `Cron expression '${cron}' does not match any calendar date in the next year.` };
    }
    if (jobs.size >= MAX_JOBS) {
      return { ok: false, error: `Too many scheduled jobs (max ${MAX_JOBS}). Cancel one first.` };
    }

    const id = randomUUID().slice(0, JOB_ID_LENGTH);
    const now = Date.now();
    const job: ScheduledJob = {
      id,
      sessionID,
      cron,
      prompt,
      createdAt: now,
      ...(recurring ? { recurring: true } : {}),
      ...(permanent ? { permanent: true } : {}),
      durable,
    };
    const next = computeNextRunAt(job, now);
    if (next !== null) job.nextRunAt = next;
    jobs.set(job.id, job);
    if (durable) await writeDurable();
    return { ok: true, job };
  };

  const listJobs = (sessionID?: string): ScheduledJob[] => {
    const all = [...jobs.values()];
    return sessionID === undefined ? all : all.filter((j) => j.sessionID === sessionID);
  };

  const getJob = (id: string): ScheduledJob | undefined => jobs.get(id);

  const removeJobs = async (ids: string[]): Promise<void> => {
    if (ids.length === 0) return;
    let touchedDurable = false;
    for (const id of ids) {
      const job = jobs.get(id);
      if (!job) continue;
      jobs.delete(id);
      if (job.durable !== false) touchedDurable = true;
    }
    if (touchedDurable) await writeDurable();
  };

  const markFired = async (ids: string[], firedAt: number): Promise<void> => {
    if (ids.length === 0) return;
    let touchedDurable = false;
    for (const id of ids) {
      const job = jobs.get(id);
      if (!job || !job.recurring) continue;
      job.lastFiredAt = firedAt;
      // reschedule from now（无 catch-up），并保持锚点可持久化。
      const next = computeNextRunAt(job, firedAt);
      if (next !== null) job.nextRunAt = next;
      if (job.durable !== false) touchedDurable = true;
    }
    if (touchedDurable) await writeDurable();
  };

  return { load, addJob, listJobs, getJob, removeJobs, markFired, count: () => jobs.size };
}
