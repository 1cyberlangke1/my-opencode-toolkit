// scheduler.ts（/loop 运行时）测试：fixed/dynamic loop、ScheduleWakeup clamp/分钟取整、
// fallback、同 prompt 一个 live loop、inFlight 兜底、lastMessageIsUser 防叠加、session 清理。

/* eslint-disable @typescript-eslint/no-non-null-assertion */

import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from "vitest";
import { createSchedulingScheduler } from "./scheduler";

let promptMock: Mock;
let messages: Array<{ info: { role?: string } }>;
let scheduler: ReturnType<typeof createSchedulingScheduler>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 3, 12, 10, 0, 0));
  messages = [];
  promptMock = vi.fn(() => Promise.resolve(undefined));
  scheduler = createSchedulingScheduler({
    ctx: {
      client: {
        session: {
          messages: () => Promise.resolve(messages),
          prompt: promptMock,
        },
      },
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("fixed loop", () => {
  test("启动立即 fire 一次，之后每 interval 再 fire", async () => {
    scheduler.startLoop("s1", "poll", 300);
    await vi.advanceTimersByTimeAsync(0);
    expect(promptMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(300_000);
    expect(promptMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(300_000);
    expect(promptMock).toHaveBeenCalledTimes(3);
  });

  test("fire 的 prompt 带哨兵 marker", async () => {
    scheduler.startLoop("s1", "poll", 300);
    await vi.advanceTimersByTimeAsync(0);
    const body = promptMock.mock.calls[0]![1] as { parts: Array<{ text: string }> };
    const text = body.parts[0]!.text;
    expect(text).toContain("poll");
    expect(text).toContain("<!-- LOOP_AUTONOMOUS -->");
  });
});

describe("dynamic loop", () => {
  test("立即 fire，20min 无 ScheduleWakeup → fallback fire 后结束", async () => {
    scheduler.startLoop("s1", "watch ci");
    await vi.advanceTimersByTimeAsync(0);
    expect(promptMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    expect(promptMock).toHaveBeenCalledTimes(2);
    expect(scheduler.listLoops("s1")).toHaveLength(0);
  });

  test("ScheduleWakeup 匹配 dynamic loop：到分钟边界 fire，loop 保留", async () => {
    scheduler.startLoop("s1", "watch ci");
    await vi.advanceTimersByTimeAsync(0);

    const r = scheduler.scheduleWakeup("s1", "watch ci", 270, "watching CI run");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fireAt % 60000).toBe(0); // 分钟边界

    // now=10:00，+270s=10:04:30 → ceil 10:05:00 → 5min 后 fire。
    await vi.advanceTimersByTimeAsync(300_000);
    expect(promptMock).toHaveBeenCalledTimes(2);
    expect(scheduler.listLoops("s1")).toHaveLength(1);
  });

  test("ScheduleWakeup 不匹配 prompt / 无 loop 时拒绝", () => {
    const noLoop = scheduler.scheduleWakeup("s1", "nope", 270, "x");
    expect(noLoop.ok).toBe(false);

    scheduler.startLoop("s1", "watch ci");
    const mismatch = scheduler.scheduleWakeup("s1", "other prompt", 270, "x");
    expect(mismatch.ok).toBe(false);
  });

  test("ScheduleWakeup delay 钳制到 [60, 3600]", async () => {
    scheduler.startLoop("s1", "watch ci");
    await vi.advanceTimersByTimeAsync(0);

    const low = scheduler.scheduleWakeup("s1", "watch ci", 10, "x");
    const loop = scheduler.listLoops("s1")[0]!;
    expect(low.ok).toBe(true);
    expect(loop.pendingWakeup!.delaySeconds).toBe(60);

    const high = scheduler.scheduleWakeup("s1", "watch ci", 7200, "x");
    expect(high.ok).toBe(true);
    expect(loop.pendingWakeup!.delaySeconds).toBe(3600);
  });
});

describe("优先级：goal active 时 loop 让路", () => {
  test("shouldDeferFire=true 时不注入，恢复后下一轮注入", async () => {
    let defer = true;
    scheduler = createSchedulingScheduler({
      ctx: {
        client: {
          session: {
            messages: () => Promise.resolve(messages),
            prompt: promptMock,
          },
        },
      },
      shouldDeferFire: () => Promise.resolve(defer),
    });

    scheduler.startLoop("s1", "poll", 300); // 立即 fire 但被 defer
    await vi.advanceTimersByTimeAsync(0);
    expect(promptMock).not.toHaveBeenCalled();

    defer = false;
    await vi.advanceTimersByTimeAsync(300_000); // 下一轮 fire 恢复注入
    expect(promptMock).toHaveBeenCalledTimes(1);
  });
});

describe("fire 期间 schedule_wakeup 不被覆盖", () => {
  test("注入挂起（同步 prompt）时模型新唤醒保留，不被 fallback/stop 覆盖", async () => {
    let resolvePrompt: (v: unknown) => void = () => undefined;
    const pending = new Promise<unknown>((resolve) => {
      resolvePrompt = resolve;
    });
    const promptMock = vi.fn(() => pending);
    scheduler = createSchedulingScheduler({
      ctx: {
        client: {
          session: {
            messages: () => Promise.resolve(messages),
            prompt: promptMock,
          },
        },
      },
    });

    scheduler.startLoop("s1", "watch"); // dynamic：立即 fire，inject 挂起
    await vi.advanceTimersByTimeAsync(0); // 推进到注入开始

    const r = scheduler.scheduleWakeup("s1", "watch", 60, "resume"); // fire 挂起期间新唤醒
    expect(r.ok).toBe(true);

    resolvePrompt(undefined);
    await vi.advanceTimersByTimeAsync(0); // fire 恢复 → handleFire

    const loop = scheduler.listLoops("s1")[0];
    expect(loop).toBeDefined(); // 未被 stopLoop 误删
    expect(loop!.pendingWakeup).toBeDefined(); // 新唤醒保留
    expect(loop!.nextFireAt).toBe(loop!.pendingWakeup!.fireAt); // 未被 fallback 覆盖成 20min
  });
});

describe("loop 生命周期", () => {
  test("同 prompt 重发取消旧 loop（一个 prompt 一个 live loop）", () => {
    scheduler.startLoop("s1", "poll");
    scheduler.startLoop("s1", "poll");
    expect(scheduler.listLoops("s1")).toHaveLength(1);
  });

  test("stopLoop 停止指定 loop", () => {
    const loop = scheduler.startLoop("s1", "poll");
    expect(scheduler.stopLoop("s1", loop.id)).toBe(true);
    expect(scheduler.listLoops("s1")).toHaveLength(0);
  });

  test("session.deleted 清理该会话全部 loop", async () => {
    scheduler.startLoop("s1", "a");
    scheduler.startLoop("s1", "b");
    await scheduler.handleEvent({ event: { type: "session.deleted", properties: { sessionID: "s1" } } });
    expect(scheduler.listLoops("s1")).toHaveLength(0);
  });
});

describe("防叠加与 inFlight 兜底", () => {
  test("lastMessageIsUser 时跳过 fire", async () => {
    messages.push({ info: { role: "user" } });
    scheduler.startLoop("s1", "poll");
    await vi.advanceTimersByTimeAsync(0);
    expect(promptMock).not.toHaveBeenCalled();
  });

  test("同步 prompt 挂起时活动事件释放，timer 可再 fire", async () => {
    let resolvePrompt: (v: unknown) => void = () => undefined;
    const pending = new Promise<unknown>((resolve) => {
      resolvePrompt = resolve;
    });
    promptMock.mockImplementation(() => pending);

    scheduler.startLoop("s1", "poll", 300);
    await vi.advanceTimersByTimeAsync(0); // fire #1（pending）→ inFlight 占用
    expect(promptMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(300_000); // timer → inject inFlight has → skip
    expect(promptMock).toHaveBeenCalledTimes(1);

    await scheduler.handleEvent({ event: { type: "message.updated", properties: { sessionID: "s1" } } });
    resolvePrompt(undefined);
    await vi.advanceTimersByTimeAsync(300_000); // 再 fire
    expect(promptMock).toHaveBeenCalledTimes(2);
  });
});
