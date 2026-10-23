import { describe, expect, it } from "vitest"

import type { Plugin } from "@opencode/plugin"

import type { JsonStore } from "../src/shared/json.ts"
import { statsKey } from "../src/shared/keys.ts"
import type { SessionStats } from "../src/stats.ts"
import { readStepTokens } from "../src/index.ts"
import { loadStats, removeStats, saveStats } from "../src/stats-store.ts"
import { buildStats, buildSubagentDetail, hitRatePercent, listSubagents } from "../src/stats.ts"

const SESSION = "ses_test"

describe("readStepTokens", () => {
  it("提取本步 token：input 含读写，output 含 reasoning，cached 只算读", () => {
    const step = readStepTokens({ input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 2 } })
    expect(step).toEqual({ input: 132, output: 25, cached: 30 })
  })

  it("忽略非法 token 值", () => {
    const step = readStepTokens({ input: -5, output: "x", cache: { read: Number.NaN } })
    expect(step).toEqual({ input: 0, output: 0, cached: 0 })
  })

  it("形状不对时全为 0", () => {
    expect(readStepTokens(null)).toEqual({ input: 0, output: 0, cached: 0 })
    expect(readStepTokens("x")).toEqual({ input: 0, output: 0, cached: 0 })
  })
})

describe("hitRatePercent", () => {
  it("向下截断两位小数", () => {
    expect(hitRatePercent(132, 30)).toBe(22.72)
    expect(hitRatePercent(3, 1)).toBe(33.33)
  })

  it("全命中才是 100", () => {
    expect(hitRatePercent(100, 100)).toBe(100)
    expect(hitRatePercent(100, 99)).toBe(99)
  })

  it("没有输入时为 0，命中数超过输入时夹到 100", () => {
    expect(hitRatePercent(0, 0)).toBe(0)
    expect(hitRatePercent(0, 100)).toBe(0)
    expect(hitRatePercent(100, 200)).toBe(100)
  })
})

describe("buildStats", () => {
  /** 输入：无；输出：带消息与会话列表的假上下文（按 parentID 过滤，模拟服务端行为）。 */
  function fakeCtx(): Plugin.Context {
    return {
      session: {
        context: () =>
          Promise.resolve([
            { type: "user", text: "hi" },
            {
              type: "assistant",
              tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 2 } },
              content: [
                { type: "tool", name: "read" },
                { type: "text", text: "done" },
              ],
            },
          ]),
        list: (input?: { readonly parentID?: string }) =>
          Promise.resolve({
            data: [{ id: SESSION }, { id: "ses_child", parentID: SESSION }].filter(
              (session) => input?.parentID === undefined || session.parentID === input.parentID,
            ),
            cursor: {},
          }),
      },
    } as unknown as Plugin.Context
  }

  it("从消息重建 token 与工具", async () => {
    const stats = await buildStats(fakeCtx(), SESSION)
    expect(stats).toEqual({
      steps: 1,
      input: 132,
      output: 25,
      cached: 30,
      tools: { read: 1 },
    })
  })

  it("读取失败按空统计处理", async () => {
    const ctx = {
      session: {
        context: () => Promise.reject(new Error("boom")),
        list: () => Promise.reject(new Error("boom")),
      },
    } as unknown as Plugin.Context
    const stats = await buildStats(ctx, SESSION)
    expect(stats).toEqual({ steps: 0, input: 0, output: 0, cached: 0, tools: {} })
  })
})

describe("子代理摘要", () => {
  it("按更新时间倒序并累计输入/缓存", async () => {
    const ctx = {
      session: {
        list: () =>
          Promise.resolve({
            data: [
              {
                id: "child-old",
                title: "old",
                parentID: SESSION,
                time: { updated: 1 },
                tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 1 } },
              },
              {
                id: "child-new",
                title: "new",
                parentID: SESSION,
                time: { updated: 2 },
                tokens: { input: 20, output: 4, reasoning: 2, cache: { read: 5, write: 2 } },
              },
            ],
            cursor: {},
          }),
      },
    } as unknown as Plugin.Context

    const list = await listSubagents(ctx, SESSION)
    expect(list.map((item) => item.id)).toEqual(["child-new", "child-old"])
    expect(list[0]).toMatchObject({ input: 27, output: 4, cached: 5 })
  })

  it("详情复用 buildStats 的工具与命中率", async () => {
    const ctx = {
      session: {
        context: () =>
          Promise.resolve([
            {
              type: "assistant",
              tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 5, write: 0 } },
              content: [{ type: "tool", name: "read" }],
            },
          ]),
        list: () => Promise.resolve({ data: [], cursor: {} }),
      },
    } as unknown as Plugin.Context

    const detail = await buildSubagentDetail(ctx, "ses_child")
    expect(detail).toEqual({
      steps: 1,
      input: 15,
      output: 3,
      cached: 5,
      hitRate: 33.33,
      tools: [{ name: "read", count: 1 }],
    })
  })
})

describe("stats store", () => {
  /** 输入：无；输出：内存实现的 JsonStore。 */
  function memoryStore(): JsonStore & { dump(): Map<string, unknown> } {
    const map = new Map<string, unknown>()
    return {
      get: (key) => Promise.resolve(map.get(key)),
      set: (key, value) => {
        map.set(key, value)
        return Promise.resolve()
      },
      remove: (key) => {
        map.delete(key)
        return Promise.resolve()
      },
      dump: () => map,
    }
  }

  it("saveStats / loadStats 往返保留字段", async () => {
    const store = memoryStore()
    const stats: SessionStats = { steps: 3, input: 120, output: 40, cached: 90, tools: { read: 2, shell: 1 } }
    await saveStats(store, SESSION, stats)
    expect(await loadStats(store, SESSION)).toEqual(stats)
  })

  it("损坏数据返回 null，回退到重建", async () => {
    const store = memoryStore()
    await store.set(statsKey(SESSION), "garbage")
    expect(await loadStats(store, SESSION)).toBeNull()
    await store.set(statsKey(SESSION), { steps: "x" })
    expect(await loadStats(store, SESSION)).toBeNull()
  })

  it("removeStats 幂等", async () => {
    const store = memoryStore()
    await saveStats(store, SESSION, { steps: 1, input: 1, output: 0, cached: 0, tools: {} })
    await removeStats(store, SESSION)
    expect(await loadStats(store, SESSION)).toBeNull()
    await expect(removeStats(store, SESSION)).resolves.toBeUndefined()
  })

  it("连续累加：每次覆盖写，读到最新总和", async () => {
    const store = memoryStore()
    // 第 1 步：加 10
    await saveStats(store, SESSION, { steps: 1, input: 10, output: 2, cached: 8, tools: {} })
    // 第 2 步：再加 10（模拟读出后 += 再写回）
    const afterFirst = await loadStats(store, SESSION)
    await saveStats(store, SESSION, {
      steps: (afterFirst?.steps ?? 0) + 1,
      input: (afterFirst?.input ?? 0) + 10,
      output: (afterFirst?.output ?? 0) + 2,
      cached: (afterFirst?.cached ?? 0) + 8,
      tools: {},
    })
    const loaded = await loadStats(store, SESSION)
    // 总和是 10+10=20，绝不会被平方级放大
    expect(loaded).toEqual({ steps: 2, input: 20, output: 4, cached: 16, tools: {} })
  })

  it("不同会话的存档互不干扰", async () => {
    const store = memoryStore()
    await saveStats(store, "ses_a", { steps: 1, input: 10, output: 1, cached: 5, tools: {} })
    await saveStats(store, "ses_b", { steps: 2, input: 20, output: 2, cached: 6, tools: {} })
    expect((await loadStats(store, "ses_a"))?.input).toBe(10)
    expect((await loadStats(store, "ses_b"))?.input).toBe(20)
    await removeStats(store, "ses_a")
    expect(await loadStats(store, "ses_a")).toBeNull()
    expect((await loadStats(store, "ses_b"))?.input).toBe(20)
  })
})
