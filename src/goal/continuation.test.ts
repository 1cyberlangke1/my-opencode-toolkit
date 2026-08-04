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

function setup() {
  const prompts: string[] = [];
  let messages: Array<{
    info?: Record<string, unknown>;
    parts?: Array<{ type?: string; text?: string }>;
  }> = [];

  const controller = {
    getGoal: vi.fn<() => typeof activeGoal | null>(() => activeGoal),
    pauseGoal: vi.fn(),
    accountUsage: vi.fn(),
  };

  const goalContinuation: GoalContinuation = createGoalContinuation({
    controller: controller as unknown as GoalController,
    ctx: {
      client: {
        session: {
          messages: vi.fn(() => Promise.resolve(messages)),
          prompt: vi.fn((_id: string, body: { parts: Array<{ text: string }> }) => {
            prompts.push(body.parts[0]!.text);
            return Promise.resolve();
          }),
        },
        tui: { showToast: vi.fn(() => Promise.resolve()) },
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

  return { goalContinuation, controller, prompts, fire, setLastMessage };
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
