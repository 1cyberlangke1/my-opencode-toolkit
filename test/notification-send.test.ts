import { describe, expect, it, vi } from "vitest"

import { createSender, type CommandRunner } from "../src/notification/send.ts"

type Call = {
  readonly command: string
  readonly args: readonly string[]
  readonly timeoutMs: number
}

/** 输入：命令是否可用；输出：记录调用与可注入的 runner。 */
function recorder(available = true): { calls: Call[]; runner: CommandRunner } {
  const calls: Call[] = []
  const runner: CommandRunner = (command, args, timeoutMs) => {
    calls.push({ command, args, timeoutMs })
    return available ? Promise.resolve() : Promise.reject(new Error("command missing"))
  }
  return { calls, runner }
}

describe("createSender", () => {
  it("Windows 用 PowerShell toast 并做 XML 与单引号转义", async () => {
    const { calls, runner } = recorder()
    const send = createSender("win32", runner)

    await send("A & B", "it's <ok>")

    expect(calls).toHaveLength(2)
    expect(calls[0]?.command).toBe("powershell.exe")
    expect(calls[0]?.args).toEqual(["-NoProfile", "-Command", "exit 0"])

    const script = calls[1]?.args.at(-1) ?? ""
    expect(script).toContain("A & B")
    expect(script).toContain("it''s <ok>")
  })

  it("macOS 用 osascript 并转义反斜杠与双引号", async () => {
    const { calls, runner } = recorder()
    const send = createSender("darwin", runner)

    await send('He said "hi"', "back\\slash")

    expect(calls).toHaveLength(2)
    expect(calls[0]?.command).toBe("osascript")
    expect(calls[0]?.args).toEqual(["-e", "return"])

    expect(calls[1]?.command).toBe("osascript")
    expect(calls[1]?.args[0]).toBe("-e")
    const script = calls[1]?.args[1] ?? ""
    expect(script).toContain('\\"hi\\"')
    expect(script).toContain("back\\\\slash")
  })

  it("Linux 直接把标题与正文作为参数传给 notify-send", async () => {
    const { calls, runner } = recorder()
    const send = createSender("linux", runner)

    await send("Title", "Body")

    expect(calls).toHaveLength(2)
    expect(calls[0]?.command).toBe("notify-send")
    expect(calls[0]?.args).toEqual(["--help"])
    expect(calls[1]?.args).toEqual(["Title", "Body"])
  })

  it("命令探测失败时静默跳过", async () => {
    const { calls, runner } = recorder(false)
    const send = createSender("linux", runner)

    await expect(send("t", "m")).resolves.toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  it("探测失败不是永久缓存，过一分钟后重试", async () => {
    vi.useFakeTimers()
    try {
      let probeAttempts = 0
      const runner: CommandRunner = (command, args) => {
        if (command === "notify-send" && args[0] === "--help") {
          probeAttempts += 1
          // 第一次探测失败，模拟命令还没装好；之后成功。
          return probeAttempts === 1 ? Promise.reject(new Error("command missing")) : Promise.resolve()
        }
        return Promise.resolve()
      }
      const send = createSender("linux", runner)

      await send("t", "m")
      // 没到重试窗口：仍然用缓存的失败结果。
      await send("t", "m")
      expect(probeAttempts).toBe(1)

      vi.setSystemTime(Date.now() + 61_000)
      await send("t", "m")
      expect(probeAttempts).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("不支持的平台是空实现", async () => {
    const { calls, runner } = recorder()
    const send = createSender("freebsd", runner)

    await send("t", "m")
    expect(calls).toHaveLength(0)
  })

  it("探测结果缓存，连续发送不重复探测", async () => {
    const { calls, runner } = recorder()
    const send = createSender("linux", runner)

    await send("a", "b")
    await send("c", "d")

    expect(calls).toHaveLength(3)
  })

  it("标题与正文按平台上限截断", async () => {
    const { calls, runner } = recorder()
    const send = createSender("linux", runner)

    await send("t".repeat(150), "m".repeat(1000))

    expect((calls[1]?.args[0] ?? "").length).toBe(103)
    expect((calls[1]?.args[1] ?? "").length).toBe(803)
  })
})
