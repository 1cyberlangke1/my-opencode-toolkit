// stats.ts 测试：computeSessionStats 对异常 tokens 结构（null/缺 cache/非对象）与
// undefined 输入（messages/getParts）的防御——单条异常消息不抛错、不冻结统计。
// 回归：切换模型后「数字冻结」（refreshStats 遇 null tokens 抛 TypeError）。
// 对齐 tmp/opencode-subagent-magazine 的 `if (!t) continue` + try/catch 模式。

import { describe, expect, test } from "vitest";
import type { Message, Part } from "@opencode-ai/sdk/v2";

import { computeSessionStats } from "./stats";

function assistant(tokens: unknown): Message {
  return { id: "m1", role: "assistant", tokens } as Message;
}

function toolPart(id: string, name: string, state?: unknown): Part {
  return { id, type: "tool", tool: name, state: state ?? {} } as Part;
}

const noParts = (): readonly Part[] => [];

describe("computeSessionStats 防御", () => {
  test("带 cache 的 assistant 消息正常累计（回归）", () => {
    const stats = computeSessionStats(
      [assistant({ input: 100, output: 20, cache: { read: 300, write: 10 } })],
      noParts,
    );
    expect(stats.cache).toEqual({ input: 100, output: 20, cacheRead: 300, cacheWrite: 10 });
  });

  test("tokens 为 null 的消息不抛、跳过，其他消息照常统计", () => {
    const stats = computeSessionStats(
      [assistant(null), assistant({ input: 50, output: 5, cache: { read: 0, write: 0 } })],
      noParts,
    );
    expect(stats.cache.input).toBe(50);
    expect(stats.cache.output).toBe(5);
  });

  test("tokens 缺 cache 字段仍统计 input/output，cache 记 0", () => {
    const stats = computeSessionStats([assistant({ input: 70, output: 7 })], noParts);
    expect(stats.cache).toEqual({ input: 70, output: 7, cacheRead: 0, cacheWrite: 0 });
  });

  test("tokens 为非对象（字符串）不抛、跳过", () => {
    const stats = computeSessionStats([assistant("oops")], noParts);
    expect(stats.cache.input).toBe(0);
  });

  test("getParts 返回 undefined 不抛，其他消息照常统计", () => {
    const stats = computeSessionStats(
      [assistant({ input: 10, output: 1, cache: { read: 0, write: 0 } })],
      () => undefined,
    );
    expect(stats.cache.input).toBe(10);
  });

  test("messages 为 undefined 不抛，返回零值 stats", () => {
    const stats = computeSessionStats(undefined, noParts);
    expect(stats).toEqual({
      cache: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      tools: [],
      subagentCount: 0,
    });
  });

  test("tool part 计数与 subtask 计数", () => {
    const parts: readonly Part[] = [
      toolPart("p1", "read"),
      toolPart("p2", "read"),
      toolPart("p3", "bash"),
      { id: "p4", type: "subtask", agent: "explore", description: "", sessionID: "s" } as Part,
    ];
    const stats = computeSessionStats(
      [assistant({ input: 1, output: 1, cache: { read: 0, write: 0 } })],
      () => parts,
    );
    expect(stats.tools).toEqual([
      { name: "read", count: 2 },
      { name: "bash", count: 1 },
    ]);
    expect(stats.subagentCount).toBe(1);
  });
});
