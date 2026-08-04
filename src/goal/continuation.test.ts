// continuation.ts 测试：goal 续作锁死标志（wasCancelled/tokenLimitDetected/insufficientFundsDetected）
// 的触发与解除（活动事件重置 + resetRunState），以及 lastMessageIsUser 的 marker 判断。
// 回归：token_limit / abort 后 goal 显示 active 但永不续作。

/* eslint-disable @typescript-eslint/no-non-null-assertion */

import { describe, expect, test, vi } from "vitest";
import { DEFAULT_CONFIG } from "../config/types";
import { createGoalContinuation, type GoalContinuation } from "./continuation";
import type { GoalController } from "./controller";

const GOAL_MARKER = "<!-- GOAL_CONTINUATION -->";

const activeGoal = {
  goalId: "g1",
  sessionID: "s1",
  objective: "verify the override",
  status: "active" as const,
  tokensUsed: 0,
  timeUsedSeconds: 0,
  createdAt: 0,
  updatedAt: 0,
};

function setup(options?: { prompt?: () => Promise<unknown>; pauseGoalResult?: typeof activeGoal | null }) {
  const prompts: string[] = [];
  let messages: Array<{
    info?: Record<string, unknown>;
    parts?: Array<{ type?: string; text?: string }>;
  }> = [];

  const controller = {
    getGoal: vi.fn<() => typeof activeGoal | null>(() => activeGoal),
    // 模拟真实 controller.pauseGoal 的守卫：非 active 态（含 complete/无 goal）返回 null，
    // handleSessionError 据此不弹「目标已暂停」toast。
    pauseGoal: vi.fn(() => options?.pauseGoalResult ?? null),
    accountUsage: vi.fn(),
  };

  const showToast = vi.fn(() => Promise.resolve());

  const goalContinuation: GoalContinuation = createGoalContinuation({
    controller: controller as unknown as GoalController,
    ctx: {
      client: {
        session: {
          messages: vi.fn(() => Promise.resolve(messages)),
          prompt: vi.fn((_id: string, body: { parts: Array<{ text: string }> }) => {
            prompts.push(body.parts[0]!.text);
            return options?.prompt ? options.prompt() : Promise.resolve();
          }),
        },
        tui: { showToast },
      },
      loadConfigOverride: () => DEFAULT_CONFIG,
    },
  });

  const fire = (type: string, sessionID = "s1", error?: unknown) =>
    goalContinuation.handler({
      event: {
        type,
        properties: { sessionID, ...(error !== undefined ? { error } : {}) },
      },
    });

  const setLastMessage = (role: string | undefined, text?: string) => {
    const message: {
      info?: Record<string, unknown>;
      parts?: Array<{ type?: string; text?: string }>;
    } = { info: { role } };
    if (text !== undefined) {
      message.parts = [{ type: "text", text }];
    }
    messages = [message];
  };

  return { goalContinuation, controller, prompts, fire, setLastMessage, showToast };
}

describe("goal runState 锁死标志", () => {
  test("token_limit 后 idle 不续作，活动事件解除后可续作", async () => {
    const { prompts, fire, setLastMessage } = setup();
    setLastMessage("assistant");

    await fire("session.error", "s1", { name: "ContextLengthError" });
    // token_limit 只设标志不 pause（历史行为）：idle 被 tokenLimitDetected 挡死。
    await fire("session.idle");
    expect(prompts).toHaveLength(0);

    // AI 恢复活动 → 活动事件重置标志 → 下次 idle 续作。
    await fire("message.updated");
    await fire("session.idle");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(GOAL_MARKER);
  });

  test("abort 后 pauseGoal + idle 不续作，活动事件解除后可续作", async () => {
    const { goalContinuation, controller, prompts, fire, setLastMessage } = setup();
    setLastMessage("assistant");

    await fire("session.error", "s1", { name: "MessageAbortedError" });
    expect(controller.pauseGoal).toHaveBeenCalledWith("s1");
    await fire("session.idle");
    expect(prompts).toHaveLength(0);

    // resume 后活动事件重置 wasCancelled → 恢复续作。
    await fire("message.updated");
    await fire("session.idle");
    expect(prompts).toHaveLength(1);
    expect(goalContinuation).toBeDefined();
  });

  test("resetRunState 清除 token_limit 标志（/goal resume 路径）", async () => {
    const { goalContinuation, prompts, fire, setLastMessage } = setup();
    setLastMessage("assistant");

    await fire("session.error", "s1", { name: "ContextLengthError" });
    await fire("session.idle");
    expect(prompts).toHaveLength(0);

    // resume 清除标志，即使没有活动事件下次 idle 也续作。
    goalContinuation.resetRunState("s1");
    await fire("session.idle");
    expect(prompts).toHaveLength(1);
  });

  test("insufficient_funds 不被活动事件重置（真没钱需显式恢复）", async () => {
    const { controller, prompts, fire, setLastMessage } = setup();
    setLastMessage("assistant");

    await fire("session.error", "s1", { name: "InsufficientQuotaError" });
    expect(controller.pauseGoal).toHaveBeenCalledWith("s1");
    await fire("message.updated");
    await fire("session.idle");
    expect(prompts).toHaveLength(0);
  });
});

describe("goal 注入 toast", () => {
  test("注入时 toast 立即弹出（不等 prompt resolve）", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { showToast, fire, setLastMessage } = setup({ prompt: () => gate });
    setLastMessage("assistant");

    // prompt 挂起中（同步 prompt 要等 AI 回复完才 resolve）：fire 不返回，但 toast 应立即弹出。
    const idlePromise = fire("session.idle");
    // 放行微任务链（account → lastMessageIsUser → inject → toast），此时 prompt 仍挂起。
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(showToast).toHaveBeenCalledTimes(1);

    release();
    await idlePromise;
    expect(showToast).toHaveBeenCalledTimes(1);
  });
});

describe("goal lastMessageIsUser marker 判断", () => {
  test("真实 user 消息（无 marker）挡住续作", async () => {
    const { prompts, fire, setLastMessage } = setup();
    setLastMessage("user", "do the thing");

    await fire("session.idle");
    expect(prompts).toHaveLength(0);
  });

  test("注入的续作消息（user + GOAL_MARKER）不算用户输入，不挡续作", async () => {
    const { prompts, fire, setLastMessage } = setup();
    setLastMessage("user", `keep going\n${GOAL_MARKER}`);

    await fire("session.idle");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(GOAL_MARKER);
  });

  test("assistant 末条正常续作", async () => {
    const { prompts, fire, setLastMessage } = setup();
    setLastMessage("assistant");

    await fire("session.idle");
    expect(prompts).toHaveLength(1);
  });

  test("无历史消息时 goal active 也续作", async () => {
    const { prompts, fire } = setup();
    await fire("session.idle");
    expect(prompts).toHaveLength(1);
  });
});

describe("goal 打断/没钱暂停：非 active 态不覆写不弹 toast", () => {
  test("goal 已 complete（pauseGoal 返回 null）时 abort 不弹「目标已暂停」toast", async () => {
    const { controller, fire, setLastMessage, showToast } = setup({ pauseGoalResult: null });
    setLastMessage("assistant");

    await fire("session.error", "s1", { name: "MessageAbortedError" });
    expect(controller.pauseGoal).toHaveBeenCalledWith("s1");
    // 守卫：pauseGoal 返回 null（已 complete/无 goal）→ 不弹 toast。
    expect(showToast).not.toHaveBeenCalled();
  });

  test("goal 已 complete（pauseGoal 返回 null）时 insufficient_funds 不弹 toast", async () => {
    const { controller, fire, setLastMessage, showToast } = setup({ pauseGoalResult: null });
    setLastMessage("assistant");

    await fire("session.error", "s1", { name: "InsufficientQuotaError" });
    expect(controller.pauseGoal).toHaveBeenCalledWith("s1");
    expect(showToast).not.toHaveBeenCalled();
  });

  test("active goal 被打断时 pauseGoal 返回 goal → 弹「目标已暂停」toast", async () => {
    const { fire, setLastMessage, showToast } = setup({ pauseGoalResult: activeGoal });
    setLastMessage("assistant");

    await fire("session.error", "s1", { name: "MessageAbortedError" });
    expect(showToast).toHaveBeenCalledTimes(1);
  });
});
