/** 全局设置的存储 key。 */
export const SETTINGS_KEY = "settings"

/** Goal 状态的 key 前缀，后面拼会话 ID。 */
export const GOAL_PREFIX = "goal:"

/** 定时任务的 key 前缀，后面拼会话 ID。 */
export const SCHEDULE_PREFIX = "schedule:"

/**
 * 输入：会话 ID。
 * 输出：该会话的 goal 存储 key。
 * 预期：不同会话互不覆盖。
 */
export function goalKey(sessionID: string): string {
  return `${GOAL_PREFIX}${sessionID}`
}

/**
 * 输入：会话 ID。
 * 输出：该会话的定时任务存储 key。
 * 预期：不同会话互不覆盖。
 */
export function scheduleKey(sessionID: string): string {
  return `${SCHEDULE_PREFIX}${sessionID}`
}
