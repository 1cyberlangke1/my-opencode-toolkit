/**
 * cron 触发的进程级声明表。
 *
 * 同一插件会按 location 各加载一份，durable 任务在每个实例里都有 timer。
 * synthetic ID 只能让 OpenCode 对重复消息幂等，挡不住每份实例各调用一次。
 * 这里按 `jobId + nextRunAt` 声明一次触发，只让一个实例真正投递；投递失败时释放，
 * 让其他实例或下一次 idle 可以重试。
 */
const CLAIM_TTL_MS = 10 * 60_000
const REGISTRY_KEY = Symbol.for("my-opencode-toolkit.cron.fire")

type Claim = {
  readonly at: number
  readonly sessionID: string
}

/** 输入：无；输出：进程级触发表。预期：同一个进程只创建一次。 */
function claims(): Map<string, Claim> {
  const holder = globalThis as unknown as Record<symbol, Map<string, Claim> | undefined>
  const existing = holder[REGISTRY_KEY]
  if (existing !== undefined) return existing
  const created = new Map<string, Claim>()
  holder[REGISTRY_KEY] = created
  return created
}

/** 输入：消息 ID；输出：是否抢到本次投递权。预期：过期的声明会被清理后重新可抢。 */
export function claimCronMessage(id: string, sessionID: string): boolean {
  const at = Date.now()
  const table = claims()
  for (const [key, claim] of table) {
    if (at - claim.at > CLAIM_TTL_MS) table.delete(key)
  }
  if (table.has(id)) return false
  table.set(id, { at, sessionID })
  return true
}

/** 输入：消息 ID；输出：无。预期：投递失败时释放声明，允许重试。 */
export function releaseCronMessage(id: string): void {
  claims().delete(id)
}

/** 输入：会话 ID；输出：无。预期：执行失败/打断后释放该会话的声明，允许同一次任务重试。 */
export function releaseSessionClaims(sessionID: string): void {
  const table = claims()
  for (const [key, claim] of table) {
    if (claim.sessionID === sessionID) table.delete(key)
  }
}
