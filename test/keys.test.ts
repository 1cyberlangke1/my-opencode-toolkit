import { describe, expect, it } from "vitest"

import { GOAL_PREFIX, SCHEDULE_PREFIX, goalKey, scheduleKey } from "../src/shared/keys.ts"

describe("存储 key", () => {
  it("goal 与 schedule 前缀不同", () => {
    expect(GOAL_PREFIX).not.toBe(SCHEDULE_PREFIX)
  })

  it("按会话隔离", () => {
    expect(goalKey("ses_a")).toBe("goal:ses_a")
    expect(goalKey("ses_b")).not.toBe(goalKey("ses_a"))
    expect(scheduleKey("ses_a")).toBe("schedule:ses_a")
    expect(scheduleKey("ses_a")).not.toBe(goalKey("ses_a"))
  })
})
