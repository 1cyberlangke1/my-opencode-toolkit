// L5 集成协调测试（「串起来不炸」核心）：把 index.ts 的组装搬进测试——
// goal + todo + scheduling 三 handler + hasActiveGoal 同挂 createEventHandler，用事件序列验证：
// 1) 一个 idle 只注入一条（goal > cron > todo）  2) goal active 时 cron/todo 让路
// 3) cron fire 后 todo 让路  4) 活动事件清 inFlight 不死锁

/* eslint-disable @typescript-eslint/no-non-null-assertion */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_CONFIG } from "../config/types";
import { createGoalContinuation } from "../goal/continuation";
import { createGoalController } from "../goal/controller";
import { createEventHandler } from "../notification/event";
import { createTodoReminder } from "../notification/todo-reminder";
import { createSchedulingContinuation } from "./continuation";
import { createSchedulingStore } from "./store";

interface MockMsg {
  info: Record<string, unknown>;
  parts?: Array<{ type?: string; text?: string; metadata?: Record<string, unknown> }>;
}

let dir = "";
let prompts: Array<{ text: string }>;
let messages: MockMsg[];
let todos: Array<{ status: string; content?: string }>;
let promptImpl: (id: string, body: { parts: Array<{ text: string }> }) => Promise<unknown>;
let goalController: ReturnType<typeof createGoalController>;
let schedulingStore: ReturnType<typeof createSchedulingStore>;
let fire: (type: string, sessionID?: string) => Promise<void>;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 3, 12, 10, 0, 0));
  dir = mkdtempSync(join(tmpdir(), "coord-"));
  prompts = [];
  messages = [];
  todos = [];
  promptImpl = (_id, body) => {
    prompts.push({ text: body.parts[0]!.text });
    return Promise.resolve();
  };

  const ctx = {
    client: {
      session: {
        get: () => Promise.resolve({}),
        messages: () => Promise.resolve(messages),
        todo: () => Promise.resolve(todos),
        prompt: (_id: string, body: { parts: Array<{ text: string }> }) => promptImpl(_id, body),
      },
      tui: { showToast: () => Promise.resolve() },
    },
    loadConfigOverride: () => structuredClone(DEFAULT_CONFIG),
  };

  goalController = createGoalController({ projectDir: dir });
  const goalContinuation = createGoalContinuation({ controller: goalController, ctx });
  const todoReminder = createTodoReminder(ctx);
  schedulingStore = createSchedulingStore(dir);
  await schedulingStore.load();
  const schedulingContinuation = createSchedulingContinuation({ store: schedulingStore, ctx });

  const event = createEventHandler({
    ctx,
    sessionNotification: null,
    todoReminder,
    goal: goalContinuation.handler,
    scheduling: schedulingContinuation,
    hasActiveGoal: (id) => {
      const goal = goalController.getGoal(id);
      return goal !== null && goal.status === "active";
    },
  });

  fire = async (type: string, sessionID = "s1") => {
    await event({ event: { type, properties: { sessionID } } });
  };
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

async function addDueCron(sessionID = "s1"): Promise<void> {
  await schedulingStore.addJob({
    sessionID,
    cron: "*/5 * * * *",
    prompt: "cron task",
    recurring: true,
    durable: false,
  });
  const job = schedulingStore.listJobs(sessionID)[0]!;
  vi.setSystemTime(new Date(Math.ceil(job.nextRunAt!)));
}

describe("一个 idle 只注入一条", () => {
  test("goal active + cron due + todo pending → 只注入 goal 续作", async () => {
    goalController.setGoal("s1", "goal objective");
    await addDueCron();
    todos.push({ status: "pending", content: "todo1" });

    await fire("session.idle");

    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.text).toContain("GOAL_CONTINUATION");
    expect(prompts[0]!.text).not.toContain("CRON_AUTONOMOUS");
  });

  test("goal 完成/暂停后 → cron fire，todo 让路", async () => {
    goalController.setGoal("s1", "goal objective");
    goalController.markComplete("s1");
    await addDueCron();
    todos.push({ status: "pending", content: "todo1" });

    await fire("session.idle");

    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.text).toContain("CRON_AUTONOMOUS");
    expect(prompts[0]!.text).not.toContain("TODO_CONTINUATION");
  });

  test("无 goal、无 cron → todo 注入（countdown 后）", async () => {
    todos.push({ status: "pending", content: "todo1" });
    await fire("session.idle");
    await vi.advanceTimersByTimeAsync(5_000);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.text).toContain("TODO_CONTINUATION");
  });

  test("cron 未到 due → todo 注入", async () => {
    await schedulingStore.addJob({ sessionID: "s1", cron: "*/5 * * * *", prompt: "cron task", recurring: true, durable: false });
    todos.push({ status: "pending", content: "todo1" });

    await fire("session.idle"); // now=10:00，cron 10:05 才 due
    await vi.advanceTimersByTimeAsync(5_000);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.text).toContain("TODO_CONTINUATION");
  });
});

describe("goal 暂停/恢复与 cron 的切换", () => {
  test("goal pause → cron fire；resume 后 goal 再优先", async () => {
    goalController.setGoal("s1", "goal objective");
    goalController.pauseGoal("s1");
    await addDueCron();

    await fire("session.idle");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.text).toContain("CRON_AUTONOMOUS");

    goalController.resumeGoal("s1");
    const job = schedulingStore.listJobs("s1")[0]!;
    vi.setSystemTime(new Date(Math.ceil(job.nextRunAt!)));
    await fire("session.idle");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.text).toContain("GOAL_CONTINUATION");
  });
});

describe("活动事件链路", () => {
  test("message.updated 等活动事件后，idle 注入不受影响", async () => {
    await addDueCron();
    await fire("message.updated");
    await fire("message.part.updated");
    await fire("session.idle");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.text).toContain("CRON_AUTONOMOUS");
  });

  test("session.deleted 清理该会话 cron", async () => {
    await addDueCron();
    await fire("session.deleted");
    expect(schedulingStore.listJobs("s1")).toHaveLength(0);
    await fire("session.idle");
    expect(prompts).toHaveLength(0);
  });
});
