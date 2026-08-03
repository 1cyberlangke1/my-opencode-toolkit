// scheduling 工具（cron_create/cron_list/cron_delete）测试。
// 用真实 store（temp dir）驱动 execute；isSubagent/归属校验走 mock。

/* eslint-disable @typescript-eslint/no-non-null-assertion */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createSchedulingStore, type SchedulingStore } from "./store";
import { createSchedulingTools } from "./tools";
import type { ToolDefinition } from "@opencode-ai/plugin";

let dir = "";
let store: SchedulingStore;
let isSub = false;
let currentSessionID = "s1";
let tools: ReturnType<typeof createSchedulingTools>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "sched-tools-"));
  store = createSchedulingStore(dir);
  await store.load();
  isSub = false;
  currentSessionID = "s1";
  tools = createSchedulingTools({
    store,
    getSessionID: () => currentSessionID,
    isSubagent: () => Promise.resolve(isSub),
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx() {
  return { sessionID: currentSessionID } as unknown as Parameters<ToolDefinition["execute"]>[1];
}

describe("cron_create", () => {
  test("创建 recurring 任务，返回 id/humanSchedule/Persisted 文案", async () => {
    const out = await tools.cron_create!.execute(
      { cron: "*/5 * * * *", prompt: "poll deploy" },
      ctx(),
    );
    expect(out).toContain("Scheduled recurring job");
    expect(out).toMatch(/[0-9a-f]{8}/);
    expect(out).toContain("Every 5 minutes");
    expect(out).toContain("Session-only");
  });

  test("durable 任务写盘并返回 Persisted 文案", async () => {
    const out = await tools.cron_create!.execute(
      { cron: "0 9 * * *", prompt: "daily", recurring: true, durable: true },
      ctx(),
    );
    expect(out).toContain("Persisted to .opencode-toolkit");
  });

  test("one-shot 返回一次性文案", async () => {
    const out = await tools.cron_create!.execute(
      { cron: "30 14 15 3 *", prompt: "remind", recurring: false },
      ctx(),
    );
    expect(out).toContain("one-shot");
    expect(out).toContain("fire once then auto-delete");
  });

  test("空 prompt 拒绝", async () => {
    const out = await tools.cron_create!.execute({ cron: "* * * * *", prompt: "  " }, ctx());
    expect(out).toContain("Error");
  });

  test("非法 cron 拒绝", async () => {
    const out = await tools.cron_create!.execute({ cron: "not cron", prompt: "x" }, ctx());
    expect(out).toContain("Error");
  });

  test("超过 50 上限拒绝", async () => {
    for (let i = 0; i < 50; i++) {
      await store.addJob({ sessionID: "s1", cron: "*/5 * * * *", prompt: `t${i}`, recurring: true, durable: false });
    }
    const out = await tools.cron_create!.execute({ cron: "*/5 * * * *", prompt: "overflow" }, ctx());
    expect(out).toContain("50");
  });

  test("子代理拒绝", async () => {
    isSub = true;
    const out = await tools.cron_create!.execute({ cron: "* * * * *", prompt: "x" }, ctx());
    expect(out).toContain("not available to subagents");
  });
});

describe("cron_list / cron_delete", () => {
  test("空列表返回 No scheduled jobs", async () => {
    const out = await tools.cron_list!.execute({}, ctx());
    expect(out).toBe("No scheduled jobs.");
  });

  test("列出任务含 id/schedule/prompt", async () => {
    await store.addJob({ sessionID: "s1", cron: "*/5 * * * *", prompt: "poll", recurring: true, durable: false });
    const out = await tools.cron_list!.execute({}, ctx());
    expect(out).toContain("Every 5 minutes");
    expect(out).toContain("poll");
    expect(out).toContain("recurring");
  });

  test("删除存在的任务", async () => {
    const r = await store.addJob({ sessionID: "s1", cron: "* * * * *", prompt: "del", durable: false });
    if (!r.ok) throw new Error("addJob failed");
    const out = await tools.cron_delete!.execute({ id: r.job.id }, ctx());
    expect(out).toBe(`Cancelled job ${r.job.id}.`);
    expect(store.getJob(r.job.id)).toBeUndefined();
  });

  test("删除不存在的任务报错", async () => {
    const out = await tools.cron_delete!.execute({ id: "00000000" }, ctx());
    expect(out).toContain("No scheduled job with id");
  });

  test("跨会话删除被拒", async () => {
    const r = await store.addJob({ sessionID: "s1", cron: "* * * * *", prompt: "mine", durable: false });
    if (!r.ok) throw new Error("addJob failed");
    currentSessionID = "s2";
    const out = await tools.cron_delete!.execute({ id: r.job.id }, ctx());
    expect(out).toContain("owned by another session");
  });
});
