/**
 * TUI 文本宽度与时间格式化。
 *
 * 输入：任意文本 / 毫秒数。
 * 输出：终端列宽、截断文本、补空格文本、紧凑倒计时。
 * 预期：CJK 和 emoji 按 2 列计算，避免侧栏换行或错位。
 */

/** 输入：单个字符；输出：终端显示列数。 */
function charColumns(char: string): number {
  const code = char.codePointAt(0) ?? 0
  if (code < 0x20) return 0
  if (code < 0x7f) return 1
  if (code < 0xa0) return 0
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe6f) ||
    (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) {
    return 2
  }
  return 1
}

/** 输入：文本；输出：终端显示列数。 */
export function visualWidth(text: string): number {
  let width = 0
  for (const char of text) width += charColumns(char)
  return width
}

/** 输入：文本 + 最大列数；输出：截断后的文本，超出时带省略号。 */
export function truncate(text: string, maxColumns: number): string {
  if (visualWidth(text) <= maxColumns) return text
  let columns = 0
  let index = 0
  for (const char of text) {
    const width = charColumns(char)
    if (columns + width > Math.max(0, maxColumns - 1)) break
    columns += width
    index += char.length
  }
  return `${text.slice(0, index)}…`
}

/** 输入：文本 + 目标列数；输出：右侧补空格到目标列数。 */
export function padRight(text: string, width: number): string {
  return `${text}${" ".repeat(Math.max(0, width - visualWidth(text)))}`
}

/** 输入：未来剩余毫秒；输出：`37s` / `4m` / `1h2m`。 */
export function formatCountdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  if (seconds < 60) return `${seconds.toString()}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes.toString()}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours.toString()}h` : `${hours.toString()}h${rest.toString()}m`
}

/** 输入：过去的时间戳 + 当前时间；输出：`2m` / `3h` 这类相对时间。 */
export function formatAgo(timestamp: number, now: number): string {
  return formatCountdown(Math.max(0, now - timestamp))
}
