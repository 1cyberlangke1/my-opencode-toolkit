/**
 * 输入：token 数。
 * 输出：紧凑文本（`999` / `12.3K` / `1.2M` / `1.5B`）。
 * 预期：单位单字母大写；保留一位小数，末尾 `.0` 去掉；超过 E 仍用 E。
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
