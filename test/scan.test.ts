import { describe, expect, it } from "vitest"

import { MemoryStore } from "./helpers.ts"
import { forEachScannedEntry } from "../src/shared/scan.ts"

describe("forEachScannedEntry", () => {
  it("按游标分页遍历全部匹配条目", async () => {
    const store = new MemoryStore()
    for (const key of ["a:1", "a:2", "a:3", "b:1"]) await store.set(key, key)

    const seen: string[] = []
    await forEachScannedEntry(store, "a:", (entry) => {
      seen.push(entry.key)
      return Promise.resolve()
    }, 2)

    expect(seen).toEqual(["a:1", "a:2", "a:3"])
  })

  it("游标 key 被删除后不会回退到最后一个 key", async () => {
    const store = new MemoryStore()
    for (const key of ["a:1", "a:2", "a:3"]) await store.set(key, key)
    await store.remove("a:3")

    const page = await store.scan({ prefix: "a:", limit: 2, after: "a:3" })
    expect(page.entries).toEqual([])
  })

  it("游标不前进时立即停止", async () => {
    let calls = 0
    const store = {
      get: () => Promise.resolve(undefined),
      set: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      scan: () => {
        calls += 1
        return Promise.resolve({ entries: [], next: "same" })
      },
    }

    await forEachScannedEntry(store, "x:", () => Promise.resolve(), 10)
    expect(calls).toBe(2)
  })
})
