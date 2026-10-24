/**
 * 输入：工具表（会被原地修改）+ 要隐藏的工具名。
 * 输出：实际删掉的工具名。
 * 预期：按名单顺序删除；不存在的工具跳过，其余工具原样保留。
 */
export function hideTools(tools: Record<string, unknown>, names: readonly string[]): string[] {
  const removed: string[] = []
  for (const name of names) {
    if (!(name in tools)) continue
    Reflect.deleteProperty(tools, name)
    removed.push(name)
  }
  return removed
}
