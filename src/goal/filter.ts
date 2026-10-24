import { hideTools } from "../shared/tool-filter.ts"

/** goal 注册的工具名；隐藏时按这份名单删。 */
const GOAL_TOOLS = ["create_goal", "get_goal", "update_goal"] as const

/**
 * 输入：即将发给模型的工具表（会被原地修改）。
 * 输出：实际删掉的工具名。
 * 预期：只删 goal 工具，其余工具原样保留；不存在时跳过。
 */
export function hideGoalTools(tools: Record<string, unknown>): string[] {
  return hideTools(tools, GOAL_TOOLS)
}
