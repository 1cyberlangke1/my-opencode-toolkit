function trim(str: string): string {
  return str.replace(/\.0([KMBTPE])$/, "$1")
}

/**
 * 紧凑 Token 格式化。
 *
 * 输入：任意数字。
 * 输出：紧凑文本（`999` / `12.3K` / `1.2M` / `1M` / `1.5B`）。
 * 预期：单位单字母大写；保留一位小数，末尾 `.0` 去掉；1000K 自动进位为 1M。
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
