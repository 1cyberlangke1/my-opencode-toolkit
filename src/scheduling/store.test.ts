// store.ts 单元测试：durable/session 存储语义、写盘剥离标志、恢复跳过坏条目、
// 7 天过期、50 上限、lastFiredAt 锚点。范式对齐 tmp/claude-code/.../cronTasks.baseline.test.ts。

/* eslint-disable @typescript-eslint/no-non-null-assertion */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createSchedulingStore, isRecurringTaskAged } from "./store";
import type { ScheduledJob } from "./types";

const JOBS_REL = join(".opencode-toolkit", "scheduling", "jobs.json");

let dir = "";
let store: ReturnType<typeof createSchedulingStore>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "sched-"));
  store = createSchedulingStore(dir);
  await store.load();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("addJob", () => {
  test("session-only 任务不写盘，仅驻留内存", async () => {
    const r = await store.addJob({
      sessionID: "s1",
      cron: "* * * * *",
      prompt: "session prompt",
      recurring: true,
      durable: false,
    });
    expect(r.ok).toBe(true);
    expect(existsSync(join(dir, JOBS_REL))).toBe(false);
    expect(store.listJobs("s1")).toHaveLength(1);
  });

  test("durable 任务写盘且剥离 durable/nextRunAt 标志", async () => {
    await store.addJob({
      sessionID: "s1",
      cron: "* * * * *",
      prompt: "durable prompt",
      recurring: true,
      durable: true,
    });
    const raw = readFileSync(join(dir, JOBS_REL), "utf-8");
    expect(raw).toContain("durable prompt");
    expect(raw).not.toContain('"durable"');
    expect(raw).not.toContain('"nextRunAt"');
  });

  test("生成 8 hex 字符 id", async () => {
    const r = await store.addJob({ sessionID: "s1", cron: "* * * * *", prompt: "x" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.job.id).toMatch(/^[0-9a-f]{8}$/);
  });

  test("非法 cron 拒绝", async () => {
    const r = await store.addJob({ sessionID: "s1", cron: "not cron", prompt: "x" });
    expect(r.ok).toBe(false);
  });

  test("未来一年无匹配拒绝（2/30 不存在）", async () => {
    const r = await store.addJob({ sessionID: "s1", cron: "0 0 30 2 *", prompt: "x" });
    expect(r.ok).toBe(false);
  });

  test("超过 50 上限拒绝", async () => {
    for (let i = 0; i < 50; i++) {
      const r = await store.addJob({
        sessionID: "s1",
        cron: "*/5 * * * *",
        prompt: `t${i}`,
        recurring: true,
        durable: false,
      });
      expect(r.ok).toBe(true);
    }
    const overflow = await store.addJob({
      sessionID: "s1",
      cron: "*/5 * * * *",
      prompt: "overflow",
      recurring: true,
      durable: false,
    });
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.error).toContain("50");
  });
});

describe("durable 持久化与恢复", () => {
  test("重启恢复写盘任务（file-backed，非 durable:false）", async () => {
    await store.addJob({
      sessionID: "s1",
      cron: "* * * * *",
      prompt: "persist",
      recurring: true,
      durable: true,
    });
    const store2 = createSchedulingStore(dir);
    await store2.load();
    const jobs = store2.listJobs("s1");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.durable).not.toBe(false);
  });

  test("恢复时跳过 malformed 与非法 cron 条目", async () => {
    mkdirSync(dirname(join(dir, JOBS_REL)), { recursive: true });
    writeFileSync(
      join(dir, JOBS_REL),
      JSON.stringify({
        tasks: [
          { id: "bad", prompt: "missing fields" },
          { id: "badcron01", cron: "invalid", prompt: "y", createdAt: 1 },
          { id: "good0001", sessionID: "s1", cron: "*/5 * * * *", prompt: "ok", createdAt: Date.now() },
        ],
      }),
    );
    await store.load();
    const jobs = store.listJobs();
    expect(jobs).toHaveLength(1);
    expect(store.getJob("good0001")).toBeDefined();
  });

  test("恢复后 nextRunAt 以 lastFiredAt ?? createdAt 为锚点", async () => {
    mkdirSync(dirname(join(dir, JOBS_REL)), { recursive: true });
    writeFileSync(
      join(dir, JOBS_REL),
      JSON.stringify({
        tasks: [
          { id: "anch0001", sessionID: "s1", cron: "*/5 * * * *", prompt: "anch", createdAt: 1000, lastFiredAt: 5000, recurring: true },
        ],
      }),
    );
    await store.load();
    const job = store.getJob("anch0001")!;
    expect(job.nextRunAt).toBeDefined();
    expect(job.nextRunAt!).toBeGreaterThan(5000);
  });
});

describe("markFired / removeJobs", () => {
  test("markFired 写 lastFiredAt 并从 now 重排 nextRunAt", async () => {
    await store.addJob({
      sessionID: "s1",
      cron: "*/5 * * * *",
      prompt: "rec",
      recurring: true,
      durable: true,
    });
    const job = store.listJobs("s1")[0]!;
    const firedAt = Date.now();
    await store.markFired([job.id], firedAt);
    const updated = store.getJob(job.id)!;
    expect(updated.lastFiredAt).toBe(firedAt);
    expect(updated.nextRunAt!).toBeGreaterThan(firedAt);
    const raw = readFileSync(join(dir, JOBS_REL), "utf-8");
    expect(raw).toContain('"lastFiredAt"');
  });

  test("removeJobs 同时清内存与写盘文件", async () => {
    await store.addJob({
      sessionID: "s1",
      cron: "* * * * *",
      prompt: "del",
      recurring: true,
      durable: true,
    });
    const job = store.listJobs("s1")[0]!;
    await store.removeJobs([job.id]);
    expect(store.getJob(job.id)).toBeUndefined();
    const parsed = JSON.parse(readFileSync(join(dir, JOBS_REL), "utf-8")) as { tasks: unknown[] };
    expect(parsed.tasks).toHaveLength(0);
  });
});

describe("isRecurringTaskAged", () => {
  const now = Date.now();
  const base: ScheduledJob = {
    id: "aged0001",
    sessionID: "s1",
    cron: "* * * * *",
    prompt: "x",
    createdAt: now,
  };
  test("7 天后过期", () => {
    const old = { ...base, createdAt: now - 8 * 24 * 60 * 60 * 1000 };
    expect(isRecurringTaskAged({ ...old, recurring: true }, now)).toBe(true);
  });
  test("7 天内不过期", () => {
    expect(isRecurringTaskAged({ ...base, recurring: true }, now)).toBe(false);
  });
  test("one-shot 永不因时长过期", () => {
    const old = { ...base, createdAt: now - 8 * 24 * 60 * 60 * 1000 };
    expect(isRecurringTaskAged(old, now)).toBe(false);
  });
  test("permanent 豁免", () => {
    const old = { ...base, createdAt: now - 8 * 24 * 60 * 60 * 1000 };
    expect(isRecurringTaskAged({ ...old, recurring: true, permanent: true }, now)).toBe(false);
  });
});
