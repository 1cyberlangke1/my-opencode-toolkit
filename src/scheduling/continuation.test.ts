// continuation.ts 测试：cron idle fire 语义（due 触发、recurring 重排、one-shot 自删、
// 7 天过期、lastMessageIsUser 防重复、inFlight 挂起兜底、session 清理）。
// 用 vi.useFakeTimers + vi.setSystemTime 控制时间（store 的 nextRunAt 依赖 Date.now）。

/* eslint-disable @typescript-eslint/no-non-null-assertion */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_CONFIG } from "../config/types";
import { createSchedulingContinuation, type SchedulingContinuation } from "./continuation";
import { createSchedulingStore } from "./store";

let dir = "";
let store: ReturnType<typeof createSchedulingStore>;
let prompts: Array<{ sessionID: string; text: string }>;
let messages: Array<{ info: { role?: string } }>;
let promptImpl: (id: string, body: { parts: Array<{ text: string }> }) => Promise<unknown>;
let handler: SchedulingContinuation;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 3, 12, 10, 0, 0));
  dir = mkdtempSync(join(tmpdir(), "sched-cont-"));
  store = createSchedulingStore(dir);
  await store.load();
  prompts = [];
  messages = [];
  promptImpl = (_id, body) => {
    prompts.push({ sessionID: _id, text: body.parts[0]!.text });
    return Promise.resolve();
  };
  handler = createSchedulingContinuation({
    store,
    ctx: {
      client: {
        session: {
          messages: vi.fn(() => Promise.resolve(messages)),
          prompt: vi.fn(promptImpl),
        },
      },
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const fire = (type: string, sessionID: string) =>
  handler({ event: { type, properties: { sessionID } } });

/** 把假时钟推进到该会话最近一个任务的 nextRunAt（含 jitter，非整 5 分钟）。 */
const advanceToNextRun = (sessionID = "s1") => {
  const job = store.listJobs(sessionID)[0]!;
  // ceil：jitter 产生浮点毫秒，setSystemTime(new Date(ms)) 会截断小数。
  vi.setSystemTime(new Date(Math.ceil(job.nextRunAt!)));
};

async function addDueRecurring(sessionID = "s1"): Promise<void> {
  await store.addJob({
    sessionID,
    cron: "*/5 * * * *",
    prompt: "poll deploy",
    recurring: true,
    durable: false,
  });
}

describe("cron idle fire", () => {
  test("due 任务 fire 一次，prompt 带哨兵与任务标识", async () => {
    await addDueRecurring();
    advanceToNextRun();
    await fire("session.idle", "s1");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.text).toContain("Running scheduled task");
    expect(prompts[0]!.text).toContain("poll deploy");
    expect(prompts[0]!.text).toContain("<!-- CRON_AUTONOMOUS -->");
  });

  test("未到 nextRunAt 不 fire", async () => {
    await addDueRecurring(); // nextRunAt = 10:05 + jitter
    await fire("session.idle", "s1"); // now = 10:00
    expect(prompts).toHaveLength(0);
  });

  test("recurring fire 后从 now 重排，未到新时刻不重复 fire", async () => {
    await addDueRecurring();
    advanceToNextRun();
    await fire("session.idle", "s1"); // fire #1 → nextRunAt 重排到未来
    expect(prompts).toHaveLength(1);

    // 同一时刻再 idle：nextRunAt > now → 不 fire。
    await fire("session.idle", "s1");
    expect(prompts).toHaveLength(1);

    advanceToNextRun();
    await fire("session.idle", "s1"); // fire #2
    expect(prompts).toHaveLength(2);
  });

  test("one-shot fire 后自删", async () => {
    await store.addJob({
      sessionID: "s1",
      cron: "*/1 * * * *",
      prompt: "one shot",
      recurring: false,
      durable: false,
    });
    vi.setSystemTime(new Date(2026, 3, 12, 10, 1, 0));
    await fire("session.idle", "s1");
    expect(prompts).toHaveLength(1);
    expect(store.listJobs("s1")).toHaveLength(0);
  });

  test("7 天过期 recurring：最后 fire 一次后删除", async () => {
    await addDueRecurring();
    vi.setSystemTime(new Date(2026, 3, 20, 10, 5, 0)); // +8 天
    await fire("session.idle", "s1");
    expect(prompts).toHaveLength(1);
    expect(store.listJobs("s1")).toHaveLength(0);
  });

  test("lastMessageIsUser 时跳过（上次注入未回复）", async () => {
    await addDueRecurring();
    messages.push({ info: { role: "user" } });
    advanceToNextRun();
    await fire("session.idle", "s1");
    expect(prompts).toHaveLength(0);
  });

  test("scheduling.enabled=false 不 fire", async () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.scheduling.enabled = false;
    handler = createSchedulingContinuation({
      store,
      ctx: {
        client: {
          session: {
            messages: vi.fn(() => Promise.resolve(messages)),
            prompt: vi.fn(promptImpl),
          },
        },
        loadConfigOverride: () => cfg,
      },
    });
    await addDueRecurring();
    vi.setSystemTime(new Date(2026, 3, 12, 10, 5, 0));
    await fire("session.idle", "s1");
    expect(prompts).toHaveLength(0);
  });
});

describe("inFlight 兜底", () => {
  test("同步 prompt 挂起时活动事件释放，注入完成且不重复 fire", async () => {
    let resolvePrompt: (v: unknown) => void = () => undefined;
    const pending = new Promise<unknown>((resolve) => {
      resolvePrompt = resolve;
    });
    const promptMock = vi.fn(() => pending);
    handler = createSchedulingContinuation({
      store,
      ctx: {
        client: {
          session: {
            messages: vi.fn(() => Promise.resolve(messages)),
            prompt: promptMock,
          },
        },
      },
    });

    await addDueRecurring();
    advanceToNextRun();

    const p1 = fire("session.idle", "s1"); // handleCronFire：先重排 nextRunAt → inject 挂起
    await vi.advanceTimersByTimeAsync(0); // 推进微任务到注入开始
    expect(promptMock).toHaveBeenCalledTimes(1); // 注入已开始

    await fire("message.updated", "s1"); // 活动事件清 inFlight（挂起期间不锁死）
    resolvePrompt(undefined);
    await p1; // 注入 resolve 完成

    await fire("session.idle", "s1"); // 到点已重排 → 不再重复 fire
    expect(promptMock).toHaveBeenCalledTimes(1);
  });
});

describe("cron timer 触发与 toast", () => {
  test("armTimers 后到点 timer fire（不依赖 idle 事件）", async () => {
    const promptMock = vi.fn(() => Promise.resolve());
    handler = createSchedulingContinuation({
      store,
      ctx: {
        client: {
          session: {
            messages: vi.fn(() => Promise.resolve(messages)),
            prompt: promptMock,
          },
        },
      },
    });
    await addDueRecurring();
    handler.armTimers();

    const job = store.listJobs("s1")[0]!;
    const delay = job.nextRunAt! - Date.now();
    await vi.advanceTimersByTimeAsync(Math.max(0, delay)); // 到点 → timer fire

    expect(promptMock).toHaveBeenCalledTimes(1); // 不依赖 idle 也触发
  });

  test("注入成功后弹多语言 toast", async () => {
    const toast = vi.fn(() => Promise.resolve());
    handler = createSchedulingContinuation({
      store,
      ctx: {
        client: {
          session: {
            messages: vi.fn(() => Promise.resolve(messages)),
            prompt: vi.fn(() => Promise.resolve()),
          },
          tui: { showToast: toast },
        },
      },
    });
    await addDueRecurring();
    advanceToNextRun();
    await fire("session.idle", "s1");

    expect(toast).toHaveBeenCalledTimes(1);
  });

  test("toast 在消息发送时立即弹（不等 prompt resolve）", async () => {
    let resolvePrompt: (v: unknown) => void = () => undefined;
    const pending = new Promise<unknown>((resolve) => {
      resolvePrompt = resolve;
    });
    const toast = vi.fn(() => Promise.resolve());
    handler = createSchedulingContinuation({
      store,
      ctx: {
        client: {
          session: {
            messages: vi.fn(() => Promise.resolve(messages)),
            prompt: vi.fn(() => pending),
          },
          tui: { showToast: toast },
        },
      },
    });
    await addDueRecurring();
    advanceToNextRun();

    const p = fire("session.idle", "s1"); // inject 挂起（prompt 未 resolve）
    await vi.advanceTimersByTimeAsync(0); // 推进到 prompt 调用
    expect(toast).toHaveBeenCalledTimes(1); // 不等 resolve 已弹 toast

    resolvePrompt(undefined);
    await p;
  });

  test("plan 模式（shouldDeferFire=true）不注入但 nextRunAt 仍重排", async () => {
    const prompt = vi.fn(() => Promise.resolve());
    handler = createSchedulingContinuation({
      store,
      ctx: {
        client: {
          session: {
            messages: vi.fn(() => Promise.resolve(messages)),
            prompt,
          },
        },
      },
      shouldDeferFire: () => Promise.resolve(true),
    });
    await addDueRecurring();
    advanceToNextRun();
    const before = store.listJobs("s1")[0]!.nextRunAt!;

    await fire("session.idle", "s1");

    expect(prompt).not.toHaveBeenCalled(); // plan 让路，不注入
    const after = store.listJobs("s1")[0]!.nextRunAt!;
    expect(after).toBeGreaterThan(before); // 到点仍重排，倒计时不卡 0
  });
});

describe("session 生命周期", () => {
  test("session.deleted 清理该会话全部任务", async () => {
    await store.addJob({ sessionID: "s1", cron: "* * * * *", prompt: "a", durable: true });
    await store.addJob({ sessionID: "s2", cron: "* * * * *", prompt: "b", durable: false });
    await fire("session.deleted", "s1");
    expect(store.listJobs("s1")).toHaveLength(0);
    expect(store.listJobs("s2")).toHaveLength(1);
  });
});
