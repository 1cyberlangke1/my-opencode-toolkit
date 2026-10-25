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

/** 输入：未来剩余毫秒；输出：`37s` / `4m32s` / `1h2m3s`。预期：显示到秒。 */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  if (hours > 0) return `${hours.toString()}h${minutes.toString()}m${seconds.toString()}s`
  if (minutes > 0) return `${minutes.toString()}m${seconds.toString()}s`
  return `${seconds.toString()}s`
}

/** 输入：毫秒；输出：粗粒度相对时间，避免历史时间每秒抖动。 */
function coarseDuration(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  if (seconds < 60) return `${seconds.toString()}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes.toString()}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours.toString()}h` : `${hours.toString()}h${rest.toString()}m`
}

/** 输入：毫秒时间戳；输出：`MM-DD HH:MM`（本地时区）。预期：一次性任务显示用。 */
export function formatDateTime(ms: number): string {
  const at = new Date(ms)
  const pad = (value: number): string => value.toString().padStart(2, "0")
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/** 输入：过去的时间戳 + 当前时间；输出：`2m` / `3h` 这类相对时间。 */
export function formatAgo(timestamp: number, now: number): string {
  return coarseDuration(Math.max(0, now - timestamp))
}

/**
 * 输入：token 数。
 * 输出：紧凑文本（`999` / `12.3K` / `1.2M` / `1.5B`）。
 * 预期：单位单字母大写；保留一位小数，末尾 `.0` 去掉；进位后不会出现 `1000K`。
 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return "0"
  const abs = Math.abs(value)
  if (abs < 1_000) return String(Math.trunc(value))

  const units = ["K", "M", "B", "T", "P", "E"] as const
  let unit = 0
  let divisor = 1_000
  while (unit < units.length - 1 && abs >= divisor * 1_000) {
    unit += 1
    divisor *= 1_000
  }

  let scaled = abs / divisor
  let text = scaled.toFixed(1)
  let label = units[unit] ?? "E"
  if (Number(text) >= 1_000 && unit < units.length - 1) {
    unit += 1
    divisor *= 1_000
    scaled = abs / divisor
    text = scaled.toFixed(1)
    label = units[unit] ?? "E"
  }
  const sign = value < 0 ? "-" : ""
  return `${sign}${trim(`${text}${label}`)}`
}

/** 输入：`12.0K`；输出：`12K`。预期：只去掉小数部分全零的尾巴。 */
function trim(text: string): string {
  return text.replace(/\.0([KMBTPE])$/, "$1")
}
