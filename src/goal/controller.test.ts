// controller.ts 测试：pauseGoal 守卫——只有 active 才允许转 paused，
// 无 goal 或已 complete 等非 active 态返回 null（不覆写状态、调用方据此不弹 toast）。
// 回归：goal 已完成时用户打断，目标被强制覆写成「已暂停」并误弹 toast。

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createGoalController, type GoalController } from "./controller";

let dir = "";
let controller: GoalController;
const SID = "s1";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "goal-controller-"));
  controller = createGoalController({ projectDir: dir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readStatus(): string | null {
  try {
    const raw = readFileSync(
      join(dir, ".opencode-toolkit", "goal", `${encodeURIComponent(SID)}.json`),
      "utf8",
    );
    return (JSON.parse(raw) as { goal: { status: string } | null }).goal?.status ?? null;
  } catch {
    return null;
  }
}

describe("pauseGoal 守卫", () => {
  test("无 goal 时返回 null 且不弹 toast（调用方判 null）", () => {
    expect(controller.pauseGoal(SID)).toBeNull();
    expect(readStatus()).toBeNull();
  });

  test("active goal 可以暂停", () => {
    controller.setGoal(SID, "do the thing");
    const paused = controller.pauseGoal(SID);
    expect(paused).not.toBeNull();
    expect(paused?.status).toBe("paused");
    expect(readStatus()).toBe("paused");
  });

  test("已 complete 的 goal 打断时不被覆写成 paused（返回 null）", () => {
    controller.setGoal(SID, "do the thing");
    controller.markComplete(SID);
    expect(readStatus()).toBe("complete");

    expect(controller.pauseGoal(SID)).toBeNull();
    expect(readStatus()).toBe("complete");
  });

  test("已 paused 的 goal 再 pause 返回 null（不重复触发 toast）", () => {
    controller.setGoal(SID, "do the thing");
    controller.pauseGoal(SID);
    expect(controller.pauseGoal(SID)).toBeNull();
    expect(readStatus()).toBe("paused");
  });

  test("已 budget_limited / blocked 的 goal 不被覆写成 paused", () => {
    controller.setGoal(SID, "do the thing");
    controller.markBudgetLimited(SID);
    expect(controller.pauseGoal(SID)).toBeNull();
    expect(readStatus()).toBe("budget_limited");

    controller.resumeGoal(SID);
    controller.markBlocked(SID, "blocked reason");
    controller.markBlocked(SID, "blocked reason");
    controller.markBlocked(SID, "blocked reason");
    expect(readStatus()).toBe("blocked");
    expect(controller.pauseGoal(SID)).toBeNull();
    expect(readStatus()).toBe("blocked");
  });
});
