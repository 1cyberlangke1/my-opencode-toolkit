/**
 * 输入：token 数。
 * 输出：紧凑文本（`999` / `12.3k` / `1.2m`）。
 * 预期：保留一位小数，末尾 `.0` 去掉。
 */
export function formatTokens(value: number): string {
  const abs = Math.abs(value)
  if (abs < 1000) return String(Math.trunc(value))
  if (abs < 1_000_000) return trim(`${(value / 1000).toFixed(1)}k`)
  return trim(`${(value / 1_000_000).toFixed(1)}m`)
}

/** 输入：`12.0k`；输出：`12k`。预期：只去掉小数部分全零的尾巴。 */
function trim(text: string): string {
  return text.replace(/\.0([km])$/, "$1")
}
