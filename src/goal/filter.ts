/**
 * 输入：即将发给模型的工具表（会被原地修改）。
 * 输出：实际删掉的工具名。
 * 预期：只删 goal 工具，其余工具原样保留；不存在时跳过。
 */
export function hideGoalTools(tools: Record<string, unknown>): string[] {
  const removed: string[] = []
  if ("create_goal" in tools) {
    delete tools["create_goal"]
    removed.push("create_goal")
  }
  if ("get_goal" in tools) {
    delete tools["get_goal"]
    removed.push("get_goal")
  }
  if ("update_goal" in tools) {
    delete tools["update_goal"]
    removed.push("update_goal")
  }
  return removed
}
