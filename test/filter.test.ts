import { describe, expect, it } from "vitest"

import { hideGoalTools } from "../src/goal/filter.ts"
import { hideSchedulingTools } from "../src/scheduling/filter.ts"

const GOAL_NAMES = ["create_goal", "get_goal", "update_goal"]
const SCHEDULING_NAMES = ["cron_create", "cron_list", "cron_delete", "schedule_wakeup"]

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

    expect(removed.sort()).toEqual([...GOAL_NAMES].sort())
    expect(Object.keys(tools).sort()).toEqual(["read", "toolkit_ping"])
  })

  it("工具表里没有 goal 工具时不报错", () => {
    const tools: Record<string, unknown> = { read: {} }
    expect(hideGoalTools(tools)).toEqual([])
    expect(Object.keys(tools)).toEqual(["read"])
  })
})

describe("hideSchedulingTools", () => {
  it("只删 scheduling 工具，保留其他工具", () => {
    const tools: Record<string, unknown> = {
      read: {},
      create_goal: {},
      cron_create: {},
      cron_list: {},
      cron_delete: {},
      schedule_wakeup: {},
    }

    const removed = hideSchedulingTools(tools)

    expect(removed.sort()).toEqual([...SCHEDULING_NAMES].sort())
    expect(Object.keys(tools).sort()).toEqual(["create_goal", "read"])
  })

  it("工具表里没有 scheduling 工具时不报错", () => {
    const tools: Record<string, unknown> = { read: {} }
    expect(hideSchedulingTools(tools)).toEqual([])
  })
})
