import { describe, expect, it } from "vitest"

import { globalSerialRegistry, runSerial } from "../src/shared/serial.ts"

/** 输入：毫秒；输出：等待 Promise。预期：只用于制造执行顺序。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("runSerial", () => {
  it("同一个键的任务按调用顺序执行", async () => {
    const registry = new Map<string, Promise<unknown>>()
    const order: number[] = []

    await Promise.all([
      runSerial(registry, "ses_a", async () => {
        await delay(10)
        order.push(1)
      }),
      runSerial(registry, "ses_a", () => {
        order.push(2)
        return Promise.resolve()
      }),
    ])

    expect(order).toEqual([1, 2])
  })

  it("任务失败不会卡住后续任务", async () => {
    const registry = new Map<string, Promise<unknown>>()

    await expect(
      runSerial(registry, "ses_a", () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom")
    await expect(runSerial(registry, "ses_a", () => Promise.resolve(7))).resolves.toBe(7)
  })

  it("不同键互不阻塞", async () => {
    const registry = new Map<string, Promise<unknown>>()
    const order: string[] = []

    await Promise.all([
      runSerial(registry, "slow", async () => {
        await delay(10)
        order.push("slow")
      }),
      runSerial(registry, "fast", () => {
        order.push("fast")
        return Promise.resolve()
      }),
    ])

    expect(order).toEqual(["fast", "slow"])
  })

  it("globalSerialRegistry 对同一符号返回同一个 Map", () => {
    const key = Symbol.for("my-opencode-toolkit.test-serial")
    const first = globalSerialRegistry(key)
    const second = globalSerialRegistry(key)
    expect(first).toBe(second)
  })
})
