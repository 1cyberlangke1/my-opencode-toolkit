// scheduling TUI mirror：把当前会话的 cron jobs + loops 快照写到
// {projectDir}/.opencode-toolkit/scheduling-tui/{sessionID}.json，供 sidebar 面板读取。
// 对齐 goal 的 goal-tui mirror（loop 在内存、session job 不落盘，只能靠 mirror 暴露给 TUI）。

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SchedulingScheduler } from "./scheduler";
import type { SchedulingStore } from "./store";

export interface SchedulingTuiSnapshot {
  version: 1;
  sessionID: string;
  jobs: Array<{
    id: string;
    cron: string;
    prompt: string;
    recurring?: boolean;
    durable?: boolean;
    nextRunAt?: number;
  }>;
  loops: Array<{
    id: string;
    prompt: string;
    mode: "fixed" | "dynamic";
    intervalSeconds?: number;
    fires: number;
    nextFireAt?: number;
  }>;
}

/** 写快照的镜像目录（相对 projectDir）。 */
const MIRROR_REL = join(".opencode-toolkit", "scheduling-tui");

export function mirrorPath(projectDir: string, sessionID: string): string {
  return join(projectDir, MIRROR_REL, `${encodeURIComponent(sessionID)}.json`);
}

export function createSchedulingMirror(
  projectDir: string,
  store: SchedulingStore,
  scheduler: SchedulingScheduler,
): { write: (sessionID: string) => void } {
  const write = (sessionID: string): void => {
    const snapshot: SchedulingTuiSnapshot = {
      version: 1,
      sessionID,
      jobs: store.listJobs(sessionID).map((job) => ({
        id: job.id,
        cron: job.cron,
        prompt: job.prompt,
        ...(job.recurring ? { recurring: true } : {}),
        ...(job.durable === false ? { durable: false } : {}),
        ...(job.nextRunAt !== undefined ? { nextRunAt: job.nextRunAt } : {}),
      })),
      loops: scheduler.listLoops(sessionID).map((loop) => ({
        id: loop.id,
        prompt: loop.prompt,
        mode: loop.mode,
        ...(loop.intervalSeconds !== undefined ? { intervalSeconds: loop.intervalSeconds } : {}),
        fires: loop.fires,
        ...(loop.nextFireAt !== undefined ? { nextFireAt: loop.nextFireAt } : {}),
      })),
    };
    const path = mirrorPath(projectDir, sessionID);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    } catch {
      // fail-soft：mirror 只是给 TUI 看的，写失败不影响调度逻辑
    }
  };
  return { write };
}

/** sidebar 读取快照；文件缺失/损坏返回 null。 */
export function readSchedulingMirror(worktree: string, sessionID: string): SchedulingTuiSnapshot | null {
  try {
    const raw = readFileSync(mirrorPath(worktree, sessionID), "utf8");
    return JSON.parse(raw) as SchedulingTuiSnapshot;
  } catch {
    return null;
  }
}

/** 清空全部 mirror 快照（插件初始化时调用：重启后内存态任务丢失，残留快照会显示幽灵任务）。 */
export function clearSchedulingMirrors(projectDir: string): void {
  try {
    const dir = join(projectDir, MIRROR_REL);
    for (const file of readdirSync(dir)) {
      if (file.endsWith(".json")) rmSync(join(dir, file), { force: true });
    }
  } catch {
    // 目录不存在 = 无残留
  }
}
