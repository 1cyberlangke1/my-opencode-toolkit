/**
 * 服务端与 TUI 共用的文本工具。
 *
 * 输入：文本、上限、省略号预留长度。
 * 输出：超长时截断并补 `...`。
 * 预期：`reserve` 表示省略号是否占用上限——0 表示实际输出可到 `max + 3`，
 *       3 表示总长度不超过 `max`。默认 0，保持通知预览的既有输出。
 */
export function truncate(text: string, max: number, reserve = 0): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - reserve))}...`
}
