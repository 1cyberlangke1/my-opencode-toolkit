// cron.ts 单元测试：5 字段解析、next-run 计算、cronToHuman、jitter。
// 契约来源：tmp/claude-code/src/utils/cron.ts + cronTasks.ts（逆向源码逐字确认）。

/* eslint-disable @typescript-eslint/no-non-null-assertion */

import { describe, expect, test } from "vitest";
import {
  computeNextCronRun,
  cronToHuman,
  cronToHumanI18n,
  jitteredNextCronRunMs,
  nextCronRunMs,
  oneShotJitteredNextCronRunMs,
  parseCronExpression,
} from "./cron";

describe("parseCronExpression", () => {
  test("解析标准 5 字段表达式", () => {
    const fields = parseCronExpression("*/5 * * * *");
    expect(fields).not.toBeNull();
    expect(fields!.minute).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
    expect(fields!.hour).toHaveLength(24);
    expect(fields!.dayOfMonth).toHaveLength(31);
    expect(fields!.month).toHaveLength(12);
    expect(fields!.dayOfWeek).toHaveLength(7);
  });

  test("支持单值/范围/逗号列表/步进", () => {
    expect(parseCronExpression("30 14 15 3 *")).not.toBeNull();
    expect(parseCronExpression("0 9 * * 1-5")!.dayOfWeek).toEqual([1, 2, 3, 4, 5]);
    expect(parseCronExpression("1,15,30 * * * *")!.minute).toEqual([1, 15, 30]);
    expect(parseCronExpression("0 */6 * * *")!.hour).toEqual([0, 6, 12, 18]);
  });

  test("dayOfWeek 7 归一化为 0（周日）", () => {
    expect(parseCronExpression("0 0 * * 7")!.dayOfWeek).toEqual([0]);
    expect(parseCronExpression("0 0 * * 5-7")!.dayOfWeek).toEqual([0, 5, 6]);
  });

  test("非法表达式返回 null", () => {
    expect(parseCronExpression("60 * * * *")).toBeNull(); // 分钟越界
    expect(parseCronExpression("* * * *")).toBeNull(); // 只有 4 字段
    expect(parseCronExpression("")).toBeNull();
    expect(parseCronExpression(undefined as unknown as string)).toBeNull();
    expect(parseCronExpression("a b c d e")).toBeNull();
  });
});

describe("computeNextCronRun", () => {
  // 用本地时区构造，断言本地字段，避免 TZ 干扰。
  test("*/5 每分钟档位：下一跳是下一个 5 分钟边界", () => {
    const next = computeNextCronRun(
      parseCronExpression("*/5 * * * *")!,
      new Date(2026, 3, 12, 10, 10, 30),
    )!;
    expect(next.getHours()).toBe(10);
    expect(next.getMinutes()).toBe(15);
    expect(next.getSeconds()).toBe(0);
  });

  test("严格 after：恰好命中也跳到下一跳", () => {
    const next = computeNextCronRun(
      parseCronExpression("* * * * *")!,
      new Date(2026, 3, 12, 10, 10, 0),
    )!;
    expect(next.getHours()).toBe(10);
    expect(next.getMinutes()).toBe(11);
  });

  test("工作日 9 点：周末出发跳到下周一", () => {
    // 2026-04-11 是周六。
    const next = computeNextCronRun(
      parseCronExpression("0 9 * * 1-5")!,
      new Date(2026, 3, 11, 12, 0, 0),
    )!;
    expect(next.getDay()).toBe(1);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
  });

  test("固定日期：3 月 15 日 14:30", () => {
    const next = computeNextCronRun(
      parseCronExpression("30 14 15 3 *")!,
      new Date(2026, 2, 10, 0, 0, 0),
    )!;
    expect(next.getMonth()).toBe(2); // 3 月
    expect(next.getDate()).toBe(15);
    expect(next.getHours()).toBe(14);
    expect(next.getMinutes()).toBe(30);
  });

  test("dom/dow 双约束 OR 语义：0 0 13 * 5（13 号或周五）", () => {
    // 2026-04-12 是周日；4/13 是周一（13 号匹配 dom）→ 应先火 4/13。
    const next = computeNextCronRun(
      parseCronExpression("0 0 13 * 5")!,
      new Date(2026, 3, 12, 0, 0, 0),
    )!;
    expect(next.getMonth()).toBe(3);
    expect(next.getDate()).toBe(13);
    expect(next.getHours()).toBe(0);
  });

  test("dayOfWeek 7 别名周日生效", () => {
    const next = computeNextCronRun(
      parseCronExpression("0 0 * * 7")!,
      new Date(2026, 3, 13, 0, 0, 0), // 周一
    )!;
    expect(next.getDay()).toBe(0);
  });
});

describe("cronToHuman", () => {
  test("每分钟 / 每 N 分钟", () => {
    expect(cronToHuman("*/1 * * * *")).toBe("Every minute");
    expect(cronToHuman("*/5 * * * *")).toBe("Every 5 minutes");
  });
  test("每小时", () => {
    expect(cronToHuman("0 * * * *")).toBe("Every hour");
    expect(cronToHuman("7 * * * *")).toBe("Every hour at :07");
  });
  test("每 N 小时", () => {
    expect(cronToHuman("0 */6 * * *")).toBe("Every 6 hours");
  });
  test("每天 / 每周几 / 工作日", () => {
    expect(cronToHuman("0 9 * * *")).toBe("Every day at 9:00 AM");
    expect(cronToHuman("0 9 * * 1")).toBe("Every Monday at 9:00 AM");
    expect(cronToHuman("0 9 * * 1-5")).toBe("Weekdays at 9:00 AM");
  });
  test("无法识别的回退原始字符串", () => {
    expect(cronToHuman("30 14 15 3 *")).toBe("30 14 15 3 *");
    expect(cronToHuman("not cron")).toBe("not cron");
  });
});

describe("cronToHumanI18n", () => {
  test("英文渲染与 cronToHuman 一致", () => {
    expect(cronToHumanI18n("*/5 * * * *", "en")).toBe("Every 5 minutes");
    expect(cronToHumanI18n("0 9 * * *", "en")).toBe("Every day at 9:00 AM");
    expect(cronToHumanI18n("0 9 * * 1", "en")).toBe("Every Monday at 9:00 AM");
    expect(cronToHumanI18n("0 9 * * 1-5", "en")).toBe("Weekdays at 9:00 AM");
  });

  test("中文渲染本地化（时间/星期/短语）", () => {
    expect(cronToHumanI18n("*/5 * * * *", "zh")).toBe("每 5 分钟");
    expect(cronToHumanI18n("*/1 * * * *", "zh")).toBe("每分钟");
    expect(cronToHumanI18n("0 9 * * *", "zh")).toContain("每天");
    expect(cronToHumanI18n("0 9 * * *", "zh")).toContain("9:00");
    expect(cronToHumanI18n("0 9 * * 1", "zh")).toContain("每周一");
    expect(cronToHumanI18n("0 9 * * 1-5", "zh")).toContain("工作日");
  });

  test("无法识别的回退原始字符串", () => {
    expect(cronToHumanI18n("30 14 15 3 *", "zh")).toBe("30 14 15 3 *");
    expect(cronToHumanI18n("not cron", "en")).toBe("not cron");
  });
});

describe("nextCronRunMs", () => {
  test("非法 cron 返回 null", () => {
    expect(nextCronRunMs("invalid cron", Date.now())).toBeNull();
  });
  test("合法 cron 返回 epoch ms", () => {
    const from = new Date(2026, 3, 12, 10, 10, 0);
    const next = nextCronRunMs("*/5 * * * *", from.getTime());
    expect(next).not.toBeNull();
    expect(new Date(next!).getMinutes()).toBe(15);
  });
});

describe("jitter", () => {
  test("jitterFrac 稳定且落在 [0,1)", () => {
    // 通过 jitteredNextCronRunMs 的产物间接验证稳定性：同 id 同 from 结果一致。
    const from = new Date(2026, 3, 12, 10, 0, 0).getTime();
    const a = jitteredNextCronRunMs("*/5 * * * *", from, "12345678");
    const b = jitteredNextCronRunMs("*/5 * * * *", from, "12345678");
    expect(a).toBe(b);
  });

  test("recurring 抖动 ≤ 间隔的 10%，id=0 时无抖动", () => {
    const from = new Date(2026, 3, 12, 10, 0, 0).getTime();
    // id '00000000' → jitterFrac = 0 → 无抖动，等于精确 next。
    const exact = nextCronRunMs("*/5 * * * *", from)!;
    const zero = jitteredNextCronRunMs("*/5 * * * *", from, "00000000")!;
    expect(zero).toBe(exact);
    // 半值 id → 抖动 = 0.5 * 10% * 间隔，落在 [exact, exact + 10%*间隔]。
    const half = jitteredNextCronRunMs("*/5 * * * *", from, "80000000")!;
    const intervalMs = 5 * 60 * 1000;
    expect(half).toBeGreaterThanOrEqual(exact);
    expect(half).toBeLessThan(exact + 0.1 * intervalMs);
  });

  test("recurring 抖动封顶 15 分钟", () => {
    // 每月 1 日 9 点：间隔 ~30 天，10% 远超 15 分钟 → 封顶。
    const from = new Date(2026, 0, 1, 0, 0, 0).getTime();
    const exact = nextCronRunMs("0 9 1 * *", from)!;
    const capped = jitteredNextCronRunMs("0 9 1 * *", from, "80000000")!;
    expect(capped).toBeGreaterThanOrEqual(exact);
    expect(capped).toBeLessThanOrEqual(exact + 15 * 60 * 1000);
  });

  test("one-shot 非 :00/:30 不抖动", () => {
    // 9:07 → 分钟 7 % 30 !== 0 → 精确火。
    const from = new Date(2026, 3, 12, 9, 0, 0).getTime();
    const next = oneShotJitteredNextCronRunMs("7 9 * * *", from, "80000000")!;
    const t = new Date(next);
    expect(t.getHours()).toBe(9);
    expect(t.getMinutes()).toBe(7);
  });

  test("one-shot :00/:30 可提前，且不早于 fromMs", () => {
    const from = new Date(2026, 3, 12, 10, 59, 50).getTime();
    const next = oneShotJitteredNextCronRunMs("0 11 * * *", from, "80000000")!;
    const t1 = new Date(2026, 3, 12, 11, 0, 0).getTime();
    expect(next).not.toBeNull();
    // lead = 0.5 * 90s = 45s；11:00 - 45s 早于 from → clamp 到 from。
    expect(next).toBeGreaterThanOrEqual(from);
    expect(next).toBeLessThanOrEqual(t1);
  });

  test("one-shot 闰日：命中 :00 门控则提前，不早于 fromMs", () => {
    // 2/29 0:00：分钟 0 命中 :00 门控 → 提前 ≤90s（one-shot 不做第二跳检查）。
    const from = new Date(2026, 3, 12, 10, 0, 0).getTime();
    const exact = nextCronRunMs("0 0 29 2 *", from)!;
    const jittered = oneShotJitteredNextCronRunMs("0 0 29 2 *", from, "89abcdef")!;
    expect(exact).not.toBeNull();
    expect(jittered).toBeGreaterThanOrEqual(from);
    expect(jittered).toBeLessThanOrEqual(exact);
  });
});
