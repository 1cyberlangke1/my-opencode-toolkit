import type { Plugin } from "@opencode/plugin"

/**
 * 会话位置查询结果。
 *
 * 输入：会话 ID。
 * 输出三种状态：找到（带目录）、结构化确认不存在、查询失败。
 * 预期：调用方必须区分「不存在」和「查不到」——前者可以清理数据，后者只能稍后重试。
 */
export type SessionLocation =
  | {
      readonly kind: "found"
      readonly directory: string
      readonly workspaceID?: string | undefined
    }
  | { readonly kind: "missing" }
  | { readonly kind: "unknown" }

/** 一个 location 的身份：目录 + 可选工作区。 */
export type SessionIdentity = {
  readonly directory: string
  readonly workspaceID?: string | undefined
}

/**
 * 输入：两个 location。
 * 输出：是否严格同一 location。
 * 预期：目录和 workspaceID 都要一致；两者都缺省 workspaceID 才算相同。
 */
export function sameLocation(a: SessionIdentity, b: SessionIdentity): boolean {
  return a.directory === b.directory && a.workspaceID === b.workspaceID
}

/** 输入：任意异常；输出：是否是结构化的会话不存在。预期：不靠错误文案匹配。 */
export function isSessionMissingError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const record = error as Record<string, unknown>
  if (record["_tag"] === "Session.NotFoundError") return true
  const status = record["status"] ?? record["statusCode"] ?? record["code"]
  return status === 404 || status === "404" || status === "not_found"
}

/**
 * 输入：插件上下文 + 会话 ID。
 * 输出：该会话的位置状态。
 * 预期：查询失败不当作不存在，避免误删别的实例的任务或状态。
 */
export async function locateSession(
  ctx: Plugin.Context,
  sessionID: string,
): Promise<SessionLocation> {
  try {
    const session = await ctx.session.get({ sessionID })
    // 公开类型只声明 directory；运行时 Session 位置可能带 workspaceID，按结构读取。
    const location: SessionIdentity = session.location
    return { kind: "found", directory: location.directory, workspaceID: location.workspaceID }
  } catch (error) {
    return isSessionMissingError(error) ? { kind: "missing" } : { kind: "unknown" }
  }
}

/**
 * 输入：插件上下文 + 会话 ID。
 * 输出：会话是否属于本实例 location。
 * 预期：不存在或查询失败一律 false——宁可少记一次，也不能跨 location 重复记账。
 */
export async function ownsSession(ctx: Plugin.Context, sessionID: string): Promise<boolean> {
  const located = await locateSession(ctx, sessionID)
  return located.kind === "found" && sameLocation(located, ctx.location)
}
