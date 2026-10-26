import type { Plugin } from "@opencode/plugin"
import { describe, expect, it } from "vitest"

import { MemoryStore, captureTimers } from "./helpers.ts"
import { createSchedulingContinuation } from "../src/scheduling/continuation.ts"
import { createSchedulingStore } from "../src/scheduling/store.ts"
import { claimCronMessage, releaseCronMessage } from "../src/scheduling/fire-lock.ts"

const SESSION = "ses_claim_lost"
const NOW = 1_800_000_000_000

const roles = {
  isSubagent: () => Promise.resolve(false),
  forget: () => undefined,
}

/** 输入：无；输出：记录注入文本的假上下文。预期：末条为空历史，允许 cron 注入。 */
function fakeCtx(log: string[]): Plugin.Context {
  return {
    location: { directory: "/work" },
    session: {
      get: () => Promise.resolve({ agent: "build" }),
      synthetic: (input: { text: string }) => {
        log.push(input.text)
        return Promise.resolve()
      },
      context: () => Promise.resolve([]),
    },
  } as unknown as Plugin.Context
}

describe("cron claim-lost", () => {
  it("不会 0ms 热循环，按明确退避重试", async () => {
    const captured = captureTimers()
    try {
      const base = createSchedulingStore(new MemoryStore())
      const added = await base.addJob({
        sessionID: SESSION,
        cron: "* * * * *",
        prompt: "ping",
        recurring: true,
      })
      expect(added.ok).toBe(true)
      if (!added.ok) return

      const job = base.getJob(added.job.id)
      if (job === undefined) return
      // 制造已到点：nextRunAt 停在过去时刻。
      const dueAt = NOW - 1000
      job.nextRunAt = dueAt

      // 预先让别的实例抢到同一次触发的声明，本实例必然走 claim-lost。
      const messageID = `msg_cron_${job.id}_${String(dueAt)}`
      expect(claimCronMessage(messageID, SESSION)).toBe(true)

      let attempts = 0
      let markSecondAttempt: (() => void) | undefined
      const secondAttempt = new Promise<void>((resolve) => {
        markSecondAttempt = resolve
      })
      const store = {
        ...base,
        markAttempted: (id: string, at: number) => {
          attempts += 1
          if (attempts === 2) markSecondAttempt?.()
          return base.markAttempted(id, at)
        },
      }

      const continuation = createSchedulingContinuation({
        ctx: fakeCtx([]),
        store,
        roles,
        shouldDefer: () => Promise.resolve(false),
        enabled: () => Promise.resolve(true),
        now: () => NOW,
      })

      try {
        await continuation.handle({ type: "session.idle", data: { sessionID: SESSION } })
        expect(attempts).toBe(1)
        // 只能有一个退避 timer，且不能是 0ms 立即重武装。
        expect(captured.timers).toHaveLength(1)
        expect(captured.timers[0]?.delay).toBe(60_000)

        // 手动走到退避时刻：允许再尝试一次，而不是在 0ms 里空转。
        captured.timers[0]?.run()
        await secondAttempt
        expect(attempts).toBe(2)
        expect(captured.timers).toHaveLength(1)
        expect(captured.timers[0]?.delay).toBe(60_000)
      } finally {
        continuation.dispose()
        releaseCronMessage(messageID)
      }
    } finally {
      captured.restore()
    }
  })
})
