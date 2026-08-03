// mirror.ts 测试：addJob/startLoop 等变更触发 onChanged → 写 TUI mirror；sidebar 可读回。

/* eslint-disable @typescript-eslint/no-non-null-assertion */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createSchedulingMirror, mirrorPath, readSchedulingMirror } from "./mirror";
import { createSchedulingScheduler } from "./scheduler";
import { createSchedulingStore } from "./store";

let dir = "";
let store: ReturnType<typeof createSchedulingStore>;
let scheduler: ReturnType<typeof createSchedulingScheduler>;
let mirror: { write: (sessionID: string) => void };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "sched-mirror-"));
  store = createSchedulingStore(dir);
  await store.load();
  scheduler = createSchedulingScheduler({
    ctx: {
      client: {
        session: {
          messages: () => Promise.resolve([]),
          prompt: () => Promise.resolve(),
        },
      },
    },
  });
  mirror = createSchedulingMirror(dir, store, scheduler);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("mirror 写入", () => {
  test("addJob 触发 onChanged 写快照（含 job 不含 loop）", async () => {
    store.onChanged = (sessionID) => {
      mirror.write(sessionID);
    };
    await store.addJob({ sessionID: "s1", cron: "*/5 * * * *", prompt: "poll", recurring: true, durable: false });

    expect(existsSync(mirrorPath(dir, "s1"))).toBe(true);
    const snap = readSchedulingMirror(dir, "s1");
    expect(snap).not.toBeNull();
    expect(snap!.jobs).toHaveLength(1);
    expect(snap!.jobs[0]!.prompt).toBe("poll");
    expect(snap!.loops).toHaveLength(0);
  });

  test("startLoop 触发 onChanged 写 loop 快照", () => {
    scheduler.onChanged = (sessionID) => {
      mirror.write(sessionID);
    };
    scheduler.startLoop("s1", "watch ci", 300);

    const snap = readSchedulingMirror(dir, "s1");
    expect(snap).not.toBeNull();
    expect(snap!.loops).toHaveLength(1);
    expect(snap!.loops[0]!.mode).toBe("fixed");
    expect(snap!.loops[0]!.intervalSeconds).toBe(300);
    expect(snap!.jobs).toHaveLength(0);
  });

  test("removeJobs 后 mirror 更新为空", async () => {
    store.onChanged = (sessionID) => {
      mirror.write(sessionID);
    };
    const r = await store.addJob({ sessionID: "s1", cron: "* * * * *", prompt: "x", durable: false });
    if (!r.ok) throw new Error("addJob failed");
    await store.removeJobs([r.job.id]);

    const snap = readSchedulingMirror(dir, "s1");
    expect(snap!.jobs).toHaveLength(0);
  });

  test("读取不存在的会话返回 null", () => {
    expect(readSchedulingMirror(dir, "none")).toBeNull();
  });
});
