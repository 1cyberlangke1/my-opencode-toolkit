/**
 * 侧栏颜色插值。
 *
 * 输入：0-100 的命中率 / 未来剩余毫秒。
 * 输出：十六进制颜色。
 * 预期：命中率 0% 纯红、50% 黄、100% 纯绿；倒计时越近越红。
 */

const RED = "#ef4444"
const YELLOW = "#eab308"
const GREEN = "#22c55e"

type Rgb = { readonly r: number; readonly g: number; readonly b: number }

/** 输入：`#rrggbb`；输出：RGB；非法输入回退黑色。 */
function parseHex(value: string): Rgb {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value)
  if (match === null) return { r: 0, g: 0, b: 0 }
  return {
    r: Number.parseInt(match[1] ?? "00", 16),
    g: Number.parseInt(match[2] ?? "00", 16),
    b: Number.parseInt(match[3] ?? "00", 16),
  }
}

/** 输入：RGB；输出：`#rrggbb`。 */
function toHex(value: Rgb): string {
  return `#${[value.r, value.g, value.b]
    .map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, "0"))
    .join("")}`
}

/** 输入：两个颜色 + 0-1 比例；输出：线性插值颜色。 */
function mix(left: string, right: string, ratio: number): string {
  const from = parseHex(left)
  const to = parseHex(right)
  const t = Math.max(0, Math.min(1, ratio))
  return toHex({
    r: from.r + (to.r - from.r) * t,
    g: from.g + (to.g - from.g) * t,
    b: from.b + (to.b - from.b) * t,
  })
}

/** 输入：0-100 命中率；输出：红→黄→绿插值颜色。 */
export function hitRateColor(percent: number): string {
  const value = Math.max(0, Math.min(100, percent))
  if (value <= 50) return mix(RED, YELLOW, value / 50)
  return mix(YELLOW, GREEN, (value - 50) / 50)
}

/**
 * 输入：未来剩余毫秒。
 * 输出：<=0 纯红；0-10m 红→黄；10m-1h 黄→绿；>=1h 纯绿。
 */
export function countdownColor(ms: number): string {
  if (ms <= 0) return RED
  if (ms <= 10 * 60_000) return mix(RED, YELLOW, ms / (10 * 60_000))
  if (ms <= 60 * 60_000) return mix(YELLOW, GREEN, (ms - 10 * 60_000) / (50 * 60_000))
  return GREEN
}
