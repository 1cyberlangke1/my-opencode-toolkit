/** 由本插件注册的 scheduling 工具名。 */
export const SCHEDULING_TOOL_NAMES = ["cron_create", "cron_list", "cron_delete", "schedule_wakeup"] as const

/**
 * 输入：即将发给模型的工具表（会被原地修改）。
 * 输出：实际删掉的工具名。
 * 预期：只删 scheduling 工具，其余工具原样保留；不存在时跳过。
 */
export function hideSchedulingTools(tools: Record<string, unknown>): string[] {
  const removed: string[] = []
  if ("cron_create" in tools) {
    delete tools["cron_create"]
    removed.push("cron_create")
  }
  if ("cron_list" in tools) {
    delete tools["cron_list"]
    removed.push("cron_list")
  }
  if ("cron_delete" in tools) {
    delete tools["cron_delete"]
    removed.push("cron_delete")
  }
  if ("schedule_wakeup" in tools) {
    delete tools["schedule_wakeup"]
    removed.push("schedule_wakeup")
  }
  return removed
}
