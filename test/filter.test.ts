import { describe, expect, it } from "vitest"

import { GOAL_TOOL_NAMES, hideGoalTools } from "../src/goal/filter.ts"

describe("hideGoalTools", () => {
  it("只删 goal 工具，保留其他工具", () => {
    const tools: Record<string, unknown> = {
      read: { description: "read" },
      create_goal: { description: "create" },
      get_goal: { description: "get" },
      update_goal: { description: "update" },
      toolkit_ping: { description: "ping" },
    }

    const removed = hideGoalTools(tools)

    expect(removed.sort()).toEqual([...GOAL_TOOL_NAMES].sort())
    expect(Object.keys(tools).sort()).toEqual(["read", "toolkit_ping"])
  })

  it("工具表里没有 goal 工具时不报错", () => {
    const tools: Record<string, unknown> = { read: {} }
    expect(hideGoalTools(tools)).toEqual([])
    expect(Object.keys(tools)).toEqual(["read"])
  })
})
