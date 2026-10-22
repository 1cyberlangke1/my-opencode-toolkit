/** `/goal` 参数解析结果。 */
export type ParsedGoalCommand =
  | { readonly kind: "set"; readonly objective: string }
  | { readonly kind: "pause" }
  | { readonly kind: "resume" }
  | { readonly kind: "clear" }
  | { readonly kind: "edit" }
  | { readonly kind: "show" }

/**
 * 输入：`/goal` 后面的原始参数。
 * 输出：解析结果。
 * 预期：空参数为 show；`pause/resume/clear/edit` 精确匹配（忽略大小写）；其余整段作为新目标。
 */
export function parseGoalCommand(rawArgs: string): ParsedGoalCommand {
  const trimmed = rawArgs.trim()
  if (trimmed === "") return { kind: "show" }

  switch (trimmed.toLowerCase()) {
    case "pause":
      return { kind: "pause" }
    case "resume":
      return { kind: "resume" }
    case "clear":
      return { kind: "clear" }
    case "edit":
      return { kind: "edit" }
    default:
      return { kind: "set", objective: trimmed }
  }
}
