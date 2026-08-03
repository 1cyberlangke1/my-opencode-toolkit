// command.ts 测试：/loop 三形态解析、间隔解析、maintenance prompt 读取。

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  DEFAULT_LOOP_MAINTENANCE_PROMPT,
  loadLoopMaintenancePrompt,
  parseIntervalSeconds,
  parseLoopCommand,
} from "./command";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sched-cmd-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parseIntervalSeconds", () => {
  test("分钟/小时/天", () => {
    expect(parseIntervalSeconds("5m")).toBe(300);
    expect(parseIntervalSeconds("1h")).toBe(3600);
    expect(parseIntervalSeconds("2d")).toBe(172800);
  });
  test("秒向上取整到分钟，最小 60s", () => {
    expect(parseIntervalSeconds("30s")).toBe(60);
    expect(parseIntervalSeconds("90s")).toBe(120);
    expect(parseIntervalSeconds("60s")).toBe(60);
  });
  test("非法返回 undefined", () => {
    expect(parseIntervalSeconds("5x")).toBeUndefined();
    expect(parseIntervalSeconds("abc")).toBeUndefined();
    expect(parseIntervalSeconds("0m")).toBeUndefined();
    expect(parseIntervalSeconds("")).toBeUndefined();
  });
});

describe("parseLoopCommand", () => {
  test("固定间隔 + prompt", () => {
    const cmd = parseLoopCommand("5m check the deploy");
    expect(cmd).toEqual({ kind: "start", prompt: "check the deploy", intervalSeconds: 300 });
  });
  test("仅 prompt（动态）", () => {
    const cmd = parseLoopCommand("check the deploy");
    expect(cmd).toEqual({ kind: "start", prompt: "check the deploy" });
  });
  test("仅间隔（maintenance）", () => {
    const cmd = parseLoopCommand("5m");
    expect(cmd).toEqual({ kind: "start", prompt: "", intervalSeconds: 300 });
  });
  test("裸 /loop（动态 maintenance）", () => {
    expect(parseLoopCommand("")).toEqual({ kind: "start", prompt: "" });
    expect(parseLoopCommand("   ")).toEqual({ kind: "start", prompt: "" });
  });
  test("非法间隔 token 视为 prompt（动态）", () => {
    const cmd = parseLoopCommand("5x build feature");
    expect(cmd).toEqual({ kind: "start", prompt: "5x build feature" });
  });
});

describe("loadLoopMaintenancePrompt", () => {
  test("无 loop.md 返回默认", () => {
    expect(loadLoopMaintenancePrompt(dir)).toBe(DEFAULT_LOOP_MAINTENANCE_PROMPT);
  });
  test("有 loop.md 用之", () => {
    writeFileSync(join(dir, "loop.md"), "  我的自定义维护提示\n  ", "utf8");
    expect(loadLoopMaintenancePrompt(dir)).toBe("我的自定义维护提示");
  });
  test("无 projectDir 返回默认", () => {
    expect(loadLoopMaintenancePrompt()).toBe(DEFAULT_LOOP_MAINTENANCE_PROMPT);
  });
});
