import { readFileSync } from "node:fs"
import { PassThrough } from "node:stream"

import { describe, expect, it } from "vitest"

import { PLUGIN_PACKAGE, PLUGIN_VERSION } from "../src/shared/version.ts"
import {
  checkLatestVersion,
  startUpdate,
  updateCommandLine,
  type SpawnLike,
  type SpawnedProcess,
} from "../src/shared/update.ts"

/** 输入：无；输出：本仓库 package.json 的 name / version。
 * 预期：相对测试文件定位，不依赖 process.cwd；版本常量必须与发布包一致，发版漏改会在这里变红。 */
function packageMeta(): { readonly name: string; readonly version: string } {
  return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    readonly name: string
    readonly version: string
  }
}

/** 输入：要返回的响应；输出：一份记录调用参数的假 fetch。 */
function fakeFetch(response: (url: string) => Promise<Response>): {
  readonly fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  readonly urls: string[]
} {
  const urls: string[] = []
  return {
    urls,
    fetcher: (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      urls.push(url)
      return response(url)
    },
  }
}

/** 输入：JSON 响应体；输出：200 响应。 */
function json(body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
  )
}

/** 输入：spawn 事件类型；输出：记录命令并触发该事件的假 spawn。
 * 预期：`spawn` 事件异步触发，模拟真实 child_process 的启动回调。 */
/** 一次 spawn 调用；options 必须原样记录，确保生产参数不会被悄悄改掉。 */
type SpawnCall = {
  readonly command: string
  readonly args: readonly string[]
  readonly options: {
    readonly stdio: readonly ["ignore", "pipe", "pipe"]
    readonly detached: boolean
    readonly shell: boolean
    readonly windowsHide: boolean
  }
}

/** 输入：无；输出：带 stdout/stderr 与完成事件的假子进程。 */
class FakeProcess implements SpawnedProcess {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  private readonly errorListeners: ((error: Error) => void)[] = []
  private readonly closeListeners: ((code: number | null) => void)[] = []

  onError(listener: (error: Error) => void): void {
    this.errorListeners.push(listener)
  }

  onClose(listener: (code: number | null) => void): void {
    this.closeListeners.push(listener)
  }

  finish(code: number | null): void {
    this.stdout.end()
    this.stderr.end()
    for (const listener of this.closeListeners) listener(code)
  }

  fail(error: Error): void {
    for (const listener of this.errorListeners) listener(error)
  }
}

/** 输入：无；输出：记录命令并返回假子进程的 spawn。 */
function fakeSpawn(): {
  readonly spawnFn: SpawnLike
  readonly calls: SpawnCall[]
  readonly process: FakeProcess
} {
  const calls: SpawnCall[] = []
  const process = new FakeProcess()
  const spawnFn = ((command: string, args: readonly string[], options: SpawnCall["options"]) => {
    calls.push({ command, args: [...args], options })
    return process
  }) as SpawnLike
  return { spawnFn, calls, process }
}

describe("包元数据与常量", () => {
  it("包名与版本和 package.json 同步", () => {
    const meta = packageMeta()
    expect(PLUGIN_PACKAGE).toBe(meta.name)
    expect(PLUGIN_VERSION).toBe(meta.version)
  })
})

describe("checkLatestVersion", () => {
  it("registry 返回更高版本时标记为可更新", async () => {
    const { fetcher, urls } = fakeFetch(() => json({ version: "9.9.9" }))

    const result = await checkLatestVersion({
      currentVersion: "0.2.28",
      packageName: "my-opencode-toolkit",
      fetcher,
    })

    expect(result).toEqual({ kind: "update-available", currentVersion: "0.2.28", latestVersion: "9.9.9" })
    expect(urls).toEqual(["https://registry.npmjs.org/my-opencode-toolkit/latest"])
  })

  it("registry 版本与当前一致时标记为已是最新", async () => {
    const { fetcher } = fakeFetch(() => json({ version: "0.2.28" }))

    const result = await checkLatestVersion({ currentVersion: "0.2.28", fetcher })

    expect(result).toEqual({ kind: "up-to-date", currentVersion: "0.2.28", latestVersion: "0.2.28" })
  })

  it("本地版本领先 registry 时也算已是最新", async () => {
    const { fetcher } = fakeFetch(() => json({ version: "0.2.1" }))

    const result = await checkLatestVersion({ currentVersion: "0.2.28", fetcher })

    expect(result.kind).toBe("up-to-date")
  })

  it("请求超时返回失败，不抛出异常", async () => {
    const fetcher = (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"))
        })
      })

    const result = await checkLatestVersion({ currentVersion: "0.2.28", fetcher, timeoutMs: 5 })

    expect(result).toEqual({ kind: "failed", reason: "network" })
  })

  it("fetcher 无视 abort signal 时也会在超时后返回失败", async () => {
    let called = false
    const fetcher = (): Promise<Response> => {
      called = true
      return new Promise(() => undefined)
    }

    const result = await checkLatestVersion({ currentVersion: "0.2.28", fetcher, timeoutMs: 5 })

    expect(called).toBe(true)
    expect(result).toEqual({ kind: "failed", reason: "network" })
  })

  it("网络错误返回失败", async () => {
    const { fetcher } = fakeFetch(() => Promise.reject(new Error("offline")))

    const result = await checkLatestVersion({ currentVersion: "0.2.28", fetcher })

    expect(result.kind).toBe("failed")
  })

  it("非 2xx 响应返回失败", async () => {
    const { fetcher } = fakeFetch(() => Promise.resolve(new Response("nope", { status: 503 })))

    const result = await checkLatestVersion({ currentVersion: "0.2.28", fetcher })

    expect(result).toEqual({ kind: "failed", reason: "response" })
  })

  it("JSON 解析失败返回失败", async () => {
    const { fetcher } = fakeFetch(() =>
      Promise.resolve(new Response("{", { status: 200, headers: { "content-type": "application/json" } })),
    )

    const result = await checkLatestVersion({ currentVersion: "0.2.28", fetcher })

    expect(result).toEqual({ kind: "failed", reason: "json" })
  })

  it("版本字段缺失或非法返回失败", async () => {
    for (const body of [{}, { version: 1 }, { version: "not-a-version" }]) {
      const { fetcher } = fakeFetch(() => json(body))
      const result = await checkLatestVersion({ currentVersion: "0.2.28", fetcher })
      expect(result).toEqual({ kind: "failed", reason: "version" })
    }
  })
})

describe("startUpdate", () => {
  it("等待完成并逐行报告 stdout/stderr", async () => {
    const fake = fakeSpawn()
    const lines: string[] = []

    const running = startUpdate({ spawn: fake.spawnFn, onProgress: (line) => lines.push(line) })
    fake.process.stdout.write("\u001b[32mDownloading\u001b[0m\nsecond")
    fake.process.stderr.write("\r\nDone package")
    fake.process.finish(0)
    const result = await running

    expect(result).toEqual({ ok: true, command: `opencode plugin update ${PLUGIN_PACKAGE}` })
    expect(lines).toEqual(["Downloading", "second", "Done package"])
    expect(fake.calls).toEqual([
      {
        command: "opencode",
        args: ["plugin", "update", PLUGIN_PACKAGE],
        options: {
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
          shell: process.platform === "win32",
          windowsHide: true,
        },
      },
    ])
    expect(updateCommandLine()).toBe(`opencode plugin update ${PLUGIN_PACKAGE}`)
  })

  it("Windows 使用隐藏后台进程，不创建独立控制台", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")
    if (descriptor === undefined) throw new Error("process.platform descriptor missing")
    Object.defineProperty(process, "platform", { ...descriptor, value: "win32" })
    try {
      const fake = fakeSpawn()

      const running = startUpdate({ spawn: fake.spawnFn })
      fake.process.finish(0)
      const result = await running

      expect(result.ok).toBe(true)
      expect(fake.calls[0]?.options).toEqual({
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
        shell: true,
        windowsHide: true,
      })
    } finally {
      Object.defineProperty(process, "platform", descriptor)
    }
  })

  it("spawn error 事件返回失败与可执行命令", async () => {
    const fake = fakeSpawn()

    const running = startUpdate({ spawn: fake.spawnFn })
    fake.process.fail(new Error("spawn failed"))
    const result = await running

    expect(result.ok).toBe(false)
    expect(result.command).toBe(`opencode plugin update ${PLUGIN_PACKAGE}`)
  })

  it("同步抛错也返回失败而非崩溃", async () => {
    const spawnFn = (() => {
      throw new Error("spawn failed")
    }) as SpawnLike

    const result = await startUpdate({ spawn: spawnFn })

    expect(result).toEqual({ ok: false, command: `opencode plugin update ${PLUGIN_PACKAGE}` })
  })

  it("非零退出码返回失败", async () => {
    const fake = fakeSpawn()

    const running = startUpdate({ spawn: fake.spawnFn })
    fake.process.finish(1)

    await expect(running).resolves.toEqual({
      ok: false,
      command: `opencode plugin update ${PLUGIN_PACKAGE}`,
    })
  })
})
