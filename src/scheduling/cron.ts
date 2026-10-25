/** 展开后的 5 个 cron 字段。 */
export type CronFields = {
  minute: number[]
  hour: number[]
  dayOfMonth: number[]
  month: number[]
  dayOfWeek: number[]
}

type FieldRange = { min: number; max: number }

const FIELD_RANGES: readonly FieldRange[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // dayOfMonth
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // dayOfWeek（7 也接受为周日）
]

/**
 * 输入：单个 cron 字段 + 取值范围。
 * 输出：升序匹配值数组，非法返回 `null`。
 * 预期：支持通配、步进（`*` 后跟斜杠与数字）、单值、范围、范围步进、逗号列表；dayOfWeek 的 7 归一成 0。
 */
function expandField(field: string, range: FieldRange): number[] | null {
  const { min, max } = range
  const out = new Set<number>()

  for (const part of field.split(",")) {
    const stepMatch = /^\*(?:\/(\d+))?$/.exec(part)
    if (stepMatch !== null) {
      const step = stepMatch[1] === undefined ? 1 : Number.parseInt(stepMatch[1], 10)
      if (step < 1) return null
      for (let i = min; i <= max; i += step) out.add(i)
      continue
    }

    const rangeMatch = /^(\d+)-(\d+)(?:\/(\d+))?$/.exec(part)
    if (rangeMatch !== null) {
      const lo = Number.parseInt(rangeMatch[1] ?? "", 10)
      const hi = Number.parseInt(rangeMatch[2] ?? "", 10)
      const step = rangeMatch[3] === undefined ? 1 : Number.parseInt(rangeMatch[3], 10)
      // dayOfWeek: 范围里 7 作为周日别名（5-7 → [5,6,0]）
      const isDow = min === 0 && max === 6
      const effMax = isDow ? 7 : max
      if (lo > hi || step < 1 || lo < min || hi > effMax) return null
      for (let i = lo; i <= hi; i += step) out.add(isDow && i === 7 ? 0 : i)
      continue
    }

    if (/^\d+$/.test(part)) {
      let n = Number.parseInt(part, 10)
      if (min === 0 && max === 6 && n === 7) n = 0
      if (n < min || n > max) return null
      out.add(n)
      continue
    }

    return null
  }

  if (out.size === 0) return null
  return Array.from(out).sort((a, b) => a - b)
}

/**
 * 输入：5 字段 cron（本地时区，`minute hour dayOfMonth month dayOfWeek`）。
 * 输出：展开后的字段，非法返回 `null`。
 */
export function parseCronExpression(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null

  const expanded: number[][] = []
  for (const [index, part] of parts.entries()) {
    const range = FIELD_RANGES[index]
    if (range === undefined) return null
    const result = expandField(part, range)
    if (result === null) return null
    expanded.push(result)
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = expanded
  if (
    minute === undefined ||
    hour === undefined ||
    dayOfMonth === undefined ||
    month === undefined ||
    dayOfWeek === undefined
  ) {
    return null
  }
  return { minute, hour, dayOfMonth, month, dayOfWeek }
}

/**
 * 输入：展开后的字段 + 起点时间。
 * 输出：严格晚于起点、第一个匹配的本地时刻，四年内无匹配返回 `null`。
 * 预期：dayOfMonth 与 dayOfWeek 都受限时任一匹配即可（OR 语义）。
 *       窗口取四年而不是一年，保证 `0 0 29 2 *`（闰日）能算出下一次。
 */
export function computeNextCronRun(fields: CronFields, from: Date): Date | null {
  const minuteSet = new Set(fields.minute)
  const hourSet = new Set(fields.hour)
  const domSet = new Set(fields.dayOfMonth)
  const monthSet = new Set(fields.month)
  const dowSet = new Set(fields.dayOfWeek)

  const domWild = fields.dayOfMonth.length === 31
  const dowWild = fields.dayOfWeek.length === 7

  const t = new Date(from.getTime())
  t.setSeconds(0, 0)
  t.setMinutes(t.getMinutes() + 1)

  // 四年覆盖一个完整闰年周期；月份/日期跳过让稀疏表达式远达不到这个上限。
  const maxIter = 4 * 366 * 24 * 60
  for (let i = 0; i < maxIter; i += 1) {
    if (!monthSet.has(t.getMonth() + 1)) {
      t.setMonth(t.getMonth() + 1, 1)
      t.setHours(0, 0, 0, 0)
      continue
    }

    const dayMatches =
      domWild && dowWild
        ? true
        : domWild
          ? dowSet.has(t.getDay())
          : dowWild
            ? domSet.has(t.getDate())
            : domSet.has(t.getDate()) || dowSet.has(t.getDay())

    if (!dayMatches) {
      t.setDate(t.getDate() + 1)
      t.setHours(0, 0, 0, 0)
      continue
    }

    if (!hourSet.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0)
      continue
    }

    if (!minuteSet.has(t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1)
      continue
    }

    return t
  }

  return null
}

/**
 * 输入：cron 字符串 + 起点毫秒。
 * 输出：下一次触发毫秒，非法或无匹配返回 `null`。
 */
export function nextCronRunMs(cron: string, fromMs: number): number | null {
  const fields = parseCronExpression(cron)
  if (fields === null) return null
  return computeNextCronRun(fields, new Date(fromMs))?.getTime() ?? null
}

/** cron 的人类可读描述（英文）。 */
export type CronHuman =
  | { kind: "every_minute"; n: number }
  | { kind: "every_hour"; minute: number }
  | { kind: "every_n_hours"; n: number; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; day: number; hour: number; minute: number }
  | { kind: "weekdays"; hour: number; minute: number }
  | { kind: "raw"; text: string }

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

/**
 * 输入：cron 字符串。
 * 输出：常见模式的结构化描述，无法识别时回退 `raw`。
 */
function parseCronHuman(cron: string): CronHuman {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return { kind: "raw", text: cron }
  const [minute = "", hour = "", dayOfMonth = "", month = "", dayOfWeek = ""] = parts

  const everyMin = /^\*\/(\d+)$/.exec(minute)
  if (everyMin !== null && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return { kind: "every_minute", n: Number.parseInt(everyMin[1] ?? "1", 10) }
  }

  if (/^\d+$/.test(minute) && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return { kind: "every_hour", minute: Number.parseInt(minute, 10) }
  }

  const everyHour = /^\*\/(\d+)$/.exec(hour)
  if (/^\d+$/.test(minute) && everyHour !== null && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return {
      kind: "every_n_hours",
      n: Number.parseInt(everyHour[1] ?? "1", 10),
      minute: Number.parseInt(minute, 10),
    }
  }

  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return { kind: "raw", text: cron }
  const m = Number.parseInt(minute, 10)
  const h = Number.parseInt(hour, 10)

  if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*") return { kind: "daily", hour: h, minute: m }
  if (dayOfMonth === "*" && month === "*" && /^\d$/.test(dayOfWeek)) {
    return { kind: "weekly", day: Number.parseInt(dayOfWeek, 10) % 7, hour: h, minute: m }
  }
  if (dayOfMonth === "*" && month === "*" && dayOfWeek === "1-5") return { kind: "weekdays", hour: h, minute: m }

  return { kind: "raw", text: cron }
}

/** 输入：小时 + 分钟；输出：`HH:MM`。预期：固定两位，便于工具输出。 */
function formatTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
}

/**
 * 输入：cron 字符串。
 * 输出：英文人类可读描述（给模型看的工具输出）。
 */
export function cronToHuman(cron: string): string {
  const human = parseCronHuman(cron)
  switch (human.kind) {
    case "every_minute":
      return human.n === 1 ? "every minute" : `every ${String(human.n)} minutes`
    case "every_hour":
      return human.minute === 0 ? "every hour" : `every hour at :${String(human.minute).padStart(2, "0")}`
    case "every_n_hours":
      return `every ${String(human.n)} hours at :${String(human.minute).padStart(2, "0")}`
    case "daily":
      return `daily at ${formatTime(human.hour, human.minute)}`
    case "weekly":
      return `weekly on ${DAY_NAMES[human.day] ?? String(human.day)} at ${formatTime(human.hour, human.minute)}`
    case "weekdays":
      return `weekdays at ${formatTime(human.hour, human.minute)}`
    case "raw":
      return human.text
  }
}

/** jitter 参数。 */
export type CronJitterConfig = {
  readonly recurringFrac: number
  readonly recurringCapMs: number
  readonly oneShotMaxMs: number
  readonly oneShotFloorMs: number
  readonly oneShotMinuteMod: number
  readonly recurringMaxAgeMs: number
}

export const DEFAULT_CRON_JITTER_CONFIG: CronJitterConfig = {
  recurringFrac: 0.1,
  recurringCapMs: 15 * 60 * 1000,
  oneShotMaxMs: 90 * 1000,
  oneShotFloorMs: 0,
  oneShotMinuteMod: 30,
  recurringMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
}

/**
 * 输入：任务 id。
 * 输出：`[0,1)` 的稳定分数。
 * 预期：非 hex id 回退 0（无抖动）。
 */
function jitterFrac(taskId: string): number {
  const frac = Number.parseInt(taskId.slice(0, 8), 16) / 0x1_0000_0000
  return Number.isFinite(frac) ? frac : 0
}

/**
 * 输入：cron + 起点 + 任务 id。
 * 输出：带确定性正向延迟的下一次触发时刻（recurring 用）。
 * 预期：延迟不超过间隔的 10%，且不超过 15 分钟；没有第二跳时不抖。
 */
export function jitteredNextCronRunMs(
  cron: string,
  fromMs: number,
  taskId: string,
  cfg: CronJitterConfig = DEFAULT_CRON_JITTER_CONFIG,
): number | null {
  const first = nextCronRunMs(cron, fromMs)
  if (first === null) return null
  const second = nextCronRunMs(cron, first)
  if (second === null) return first
  const jitter = Math.min(jitterFrac(taskId) * cfg.recurringFrac * (second - first), cfg.recurringCapMs)
  return first + jitter
}

/**
 * 输入：cron + 起点 + 任务 id。
 * 输出：带确定性提前量的下一次触发时刻（one-shot 用）。
 * 预期：只在分钟命中 `oneShotMinuteMod` 时提前，且不早于起点。
 */
export function oneShotJitteredNextCronRunMs(
  cron: string,
  fromMs: number,
  taskId: string,
  cfg: CronJitterConfig = DEFAULT_CRON_JITTER_CONFIG,
): number | null {
  const first = nextCronRunMs(cron, fromMs)
  if (first === null) return null
  if (new Date(first).getMinutes() % cfg.oneShotMinuteMod !== 0) return first
  const lead = cfg.oneShotFloorMs + jitterFrac(taskId) * (cfg.oneShotMaxMs - cfg.oneShotFloorMs)
  const jittered = first - lead
  // 剩余时间不够时宁可准点触发：把触发时刻压到「现在」会让任务一创建就该触发，
  // 重启载入时还会被当成已过期直接丢掉。
  return jittered > fromMs ? jittered : first
}
