/**
 * `setTimeout` 的安全上限。
 *
 * 预期：超过 24 小时的等待拆成多段，避免 Node/Bun 把大于 2^31-1 毫秒的延迟
 *       当成 1 毫秒立即触发（年抛、闰日等长周期 cron 会踩到）。
 */
export const MAX_TIMER_DELAY_MS = 24 * 60 * 60 * 1000

/**
 * 输入：期望延迟毫秒。
 * 输出：夹到 `[0, MAX_TIMER_DELAY_MS]` 的延迟；非有限值按上限处理，避免 0 延迟忙循环。
 */
export function capTimerDelay(delayMs: number): number {
  if (!Number.isFinite(delayMs)) return MAX_TIMER_DELAY_MS
  return Math.min(Math.max(0, delayMs), MAX_TIMER_DELAY_MS)
}
