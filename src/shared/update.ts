import { spawn } from "node:child_process"

import { PLUGIN_PACKAGE, PLUGIN_VERSION } from "./version.ts"

/** registry 查询超时；超时后按“无法检查更新”处理。 */
export const UPDATE_CHECK_TIMEOUT_MS = 8_000

/** registry 默认地址；e2e 可用 MY_OPENCODE_TOOLKIT_REGISTRY_URL 指向本地假 registry。 */
const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org"
const REGISTRY_URL_ENV = "MY_OPENCODE_TOOLKIT_REGISTRY_URL"
const OPENCODE_COMMAND = "opencode"
// 固定参数里只有一个包名常量，不拼接任何用户输入。
const UPDATE_ARGS = ["plugin", "update", PLUGIN_PACKAGE] as const

/** 输入：URL 与请求参数；输出：registry 响应。测试可注入避免真实网络。 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** 检查结果。`failed` 的 reason 只用于测试与排查，不直接展示给用户。 */
export type UpdateCheckResult =
  | { readonly kind: "up-to-date"; readonly currentVersion: string; readonly latestVersion: string }
  | { readonly kind: "update-available"; readonly currentVersion: string; readonly latestVersion: string }
  | { readonly kind: "failed"; readonly reason: "network" | "response" | "json" | "version" }

/** 启动结果；失败时也带上可直接执行的命令。 */
export type UpdateStartResult =
  | { readonly ok: true; readonly command: string }
  | { readonly ok: false; readonly command: string }

/** 最小 spawn 形状；测试可用它注入假子进程。 */
export type SpawnedProcess = {
  once(event: "spawn" | "error", listener: () => void): unknown
  unref?(): void
}

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: {
    readonly stdio: "ignore"
    readonly detached: boolean
    readonly shell: boolean
    readonly windowsHide: boolean
  },
) => SpawnedProcess

/**
 * 输入：可选显式地址与环境来源。
 * 输出：可用的 registry 根地址。
 * 预期：显式值优先，其次环境覆盖；只接受 http/https，异常值回退官方地址。
 */
export function registryBaseUrl(
  explicit?: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const explicitValue = explicit?.trim()
  const envValue = env[REGISTRY_URL_ENV]?.trim()
  const candidate =
    explicitValue !== undefined && explicitValue.length > 0
      ? explicitValue
      : envValue !== undefined && envValue.length > 0
        ? envValue
        : DEFAULT_REGISTRY_URL
  try {
    const url = new URL(candidate)
    return url.protocol === "http:" || url.protocol === "https:"
      ? candidate.replace(/\/+$/, "")
      : DEFAULT_REGISTRY_URL
  } catch {
    return DEFAULT_REGISTRY_URL
  }
}

/**
 * 输入：可选的当前版本、包名、fetch 实现与超时。
 * 输出：已是最新 / 发现新版本 / 失败。
 * 预期：网络、HTTP、JSON、版本字段异常一律收敛成 `failed`，不抛异常、不泄露原始错误；
 *       版本按数字段比较，本地领先 registry 也算已是最新。
 */
export async function checkLatestVersion(
  options: {
    readonly currentVersion?: string
    readonly packageName?: string
    readonly fetcher?: FetchLike
    readonly timeoutMs?: number
    readonly registryUrl?: string
  } = {},
): Promise<UpdateCheckResult> {
  const currentVersion = options.currentVersion ?? PLUGIN_VERSION
  const current = parseVersion(currentVersion)
  if (current === undefined) return { kind: "failed", reason: "version" }

  const packageName = options.packageName ?? PLUGIN_PACKAGE
  const url = `${registryBaseUrl(options.registryUrl)}/${encodeURIComponent(packageName)}/latest`
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error("update check timed out"))
    }, options.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS)
  })

  try {
    const fetcher: FetchLike = options.fetcher ?? fetch
    let response: Response
    try {
      response = await Promise.race([
        fetcher(url, {
          signal: controller.signal,
          headers: { accept: "application/json" },
        }),
        timeout,
      ])
    } catch {
      return { kind: "failed", reason: "network" }
    }
    if (!response.ok) return { kind: "failed", reason: "response" }

    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      return { kind: "failed", reason: "json" }
    }

    const latestVersion = readVersion(payload)
    const latest = latestVersion === undefined ? undefined : parseVersion(latestVersion)
    if (latestVersion === undefined || latest === undefined) {
      return { kind: "failed", reason: "version" }
    }

    return compareVersions(latest, current) > 0
      ? { kind: "update-available", currentVersion, latestVersion }
      : { kind: "up-to-date", currentVersion, latestVersion }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 输入：任意 JSON。
 * 输出：非空的 version 字符串，否则 undefined。
 * 预期：不看其它字段，也不信任数字/对象形态的版本。
 */
function readVersion(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined
  const value = (payload as Record<string, unknown>)["version"]
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

/**
 * 输入：版本字符串。
 * 输出：数字段数组；不是 `x.y.z` 形态时返回 undefined。
 * 预期：忽略 `v` 前缀与 `-pre`/`+build` 后缀；只做数字比较，不引入 semver 依赖。
 */
function parseVersion(value: string): readonly number[] | undefined {
  const core = value.trim().replace(/^v/i, "").split(/[-+]/, 1)[0] ?? ""
  const parts = core.split(".")
  if (parts.length !== 3 || !parts.every((part) => /^\d+$/.test(part))) return undefined
  const numbers = parts.map((part) => Number.parseInt(part, 10))
  return numbers.every(Number.isSafeInteger) ? numbers : undefined
}

/** 输入：两个数字段版本；输出：正数表示 a 更新。预期：缺段按 0 补齐。 */
function compareVersions(a: readonly number[], b: readonly number[]): number {
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** 输入：无；输出：失败提示里展示的固定命令。 */
export function updateCommandLine(): string {
  return `${OPENCODE_COMMAND} ${UPDATE_ARGS.join(" ")}`
}

/**
 * 输入：可选的假 spawn。
 * 输出：是否成功启动（不等待更新完成）。
 * 预期：只运行 `opencode plugin update <固定包名>`；启动后立刻 unref，
 *       同步抛错或异步 error 事件都返回失败与可执行命令。
 */
export function startUpdate(options: { readonly spawn?: SpawnLike } = {}): Promise<UpdateStartResult> {
  const command = updateCommandLine()
  const spawnProcess: SpawnLike = options.spawn ?? spawn

  return new Promise((resolve) => {
    let settled = false
    const finish = (result: UpdateStartResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    try {
      const child = spawnProcess(OPENCODE_COMMAND, UPDATE_ARGS, {
        stdio: "ignore",
        detached: true,
        // Windows 上 opencode 通常是 .cmd，必须交给 shell 才能解析。
        shell: process.platform === "win32",
        windowsHide: true,
      })
      child.once("error", () => {
        finish({ ok: false, command })
      })
      child.once("spawn", () => {
        finish({ ok: true, command })
        try {
          child.unref?.()
        } catch {
          // 进程已经启动；unref 失败只影响句柄回收，不影响更新结果。
        }
      })
    } catch {
      finish({ ok: false, command })
    }
  })
}
