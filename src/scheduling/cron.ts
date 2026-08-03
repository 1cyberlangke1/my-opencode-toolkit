// 5 字段 cron 解析与 next-run 计算 + jitter（从 Claude Code 逆向源码移植）。
// 契约见 PLAN.md §0；算法与 tmp/claude-code/src/utils/cron.ts + cronTasks.ts 逐字对齐。

export type CronFields = {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
};

type FieldRange = { min: number; max: number };

const FIELD_RANGES: FieldRange[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // dayOfMonth
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // dayOfWeek (0=Sunday; 7 接受为 Sunday 别名)
];

/** 展开单个 cron 字段为升序匹配值数组。支持通配、步进、范围、范围步进、单值、逗号列表。非法返回 null。 */
function expandField(field: string, range: FieldRange): number[] | null {
  const { min, max } = range;
  const out = new Set<number>();

  for (const part of field.split(",")) {
    // wildcard 或 star-slash-N
    const stepMatch = part.match(/^\*(?:\/(\d+))?$/);
    if (stepMatch) {
      const step = stepMatch[1] ? parseInt(stepMatch[1], 10) : 1;
      if (step < 1) return null;
      for (let i = min; i <= max; i += step) out.add(i);
      continue;
    }

    // N-M 或 N-M/S
    const rangeMatch = part.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
    if (rangeMatch) {
    if (rangeMatch[1] === undefined || rangeMatch[2] === undefined) return null;
    const lo = parseInt(rangeMatch[1], 10);
    const hi = parseInt(rangeMatch[2], 10);
      const step = rangeMatch[3] ? parseInt(rangeMatch[3], 10) : 1;
      // dayOfWeek: 范围里 7 作为 Sunday 别名（5-7 = 周五、六、日 → [5,6,0]）
      const isDow = min === 0 && max === 6;
      const effMax = isDow ? 7 : max;
      if (lo > hi || step < 1 || lo < min || hi > effMax) return null;
      for (let i = lo; i <= hi; i += step) {
        out.add(isDow && i === 7 ? 0 : i);
      }
      continue;
    }

    // 单值 N
    const singleMatch = part.match(/^\d+$/);
    if (singleMatch) {
      let n = parseInt(part, 10);
      if (min === 0 && max === 6 && n === 7) n = 0;
      if (n < min || n > max) return null;
      out.add(n);
      continue;
    }

    return null;
  }

  if (out.size === 0) return null;
  return Array.from(out).sort((a, b) => a - b);
}

/**
 * 解析 5 字段 cron（本地时区）。字段顺序：minute hour dayOfMonth month dayOfWeek。
 * 非法/不支持语法返回 null。
 */
export function parseCronExpression(expr: string): CronFields | null {
  if (typeof expr !== "string") return null;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const expanded: number[][] = [];
  for (let i = 0; i < 5; i++) {
    const part = parts[i];
    const range = FIELD_RANGES[i];
    if (part === undefined || range === undefined) return null;
    const result = expandField(part, range);
    if (!result) return null;
    expanded.push(result);
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = expanded;
  if (
    minute === undefined ||
    hour === undefined ||
    dayOfMonth === undefined ||
    month === undefined ||
    dayOfWeek === undefined
  ) {
    return null;
  }
  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

/**
 * 计算 `from` 之后（严格 after）第一个匹配的本地时刻，逐分钟步进，上限 366 天。
 * dom/dow 双约束时任一匹配即算匹配（OR 语义）；DST 语义与 vixie-cron 对齐。
 */
export function computeNextCronRun(fields: CronFields, from: Date): Date | null {
  const minuteSet = new Set(fields.minute);
  const hourSet = new Set(fields.hour);
  const domSet = new Set(fields.dayOfMonth);
  const monthSet = new Set(fields.month);
  const dowSet = new Set(fields.dayOfWeek);

  // 字段是否通配（满范围）
  const domWild = fields.dayOfMonth.length === 31;
  const dowWild = fields.dayOfWeek.length === 7;

  // 向上取整到下一个整分钟（严格 after `from`）
  const t = new Date(from.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);

  const maxIter = 366 * 24 * 60;
  for (let i = 0; i < maxIter; i++) {
    const month = t.getMonth() + 1;
    if (!monthSet.has(month)) {
      t.setMonth(t.getMonth() + 1, 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }

    const dom = t.getDate();
    const dow = t.getDay();
    // dom 与 dow 都受约束时，任一匹配即可（OR 语义）
    const dayMatches = domWild && dowWild
      ? true
      : domWild
        ? dowSet.has(dow)
        : dowWild
          ? domSet.has(dom)
          : domSet.has(dom) || dowSet.has(dow);

    if (!dayMatches) {
      t.setDate(t.getDate() + 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }

    if (!hourSet.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0);
      continue;
    }

    if (!minuteSet.has(t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1);
      continue;
    }

    return t;
  }

  return null;
}

/** nextCronRunMs 的结果：无匹配/非法 → null。 */
export function nextCronRunMs(cron: string, fromMs: number): number | null {
  const fields = parseCronExpression(cron);
  if (!fields) return null;
  const next = computeNextCronRun(fields, new Date(fromMs));
  return next ? next.getTime() : null;
}

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** 本地时间格式化（固定 2000-01-01 规避 DST 跳变）。 */
function formatLocalTime(minute: number, hour: number): string {
  const d = new Date(2000, 0, 1, hour, minute);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/**
 * cron 转人类可读描述。只覆盖常见模式，无法识别的回退原始 cron 字符串。
 * 本地时区（无需 utc 分支——咱不跑 UTC 远程触发器）。
 */
export function cronToHuman(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];

  // Every N minutes: */N * * * *
  const everyMinMatch = minute.match(/^\*\/(\d+)$/);
  if (
    everyMinMatch &&
    hour === "*" &&
    dayOfMonth === "*" &&
    month === "*" &&
    dayOfWeek === "*"
  ) {
    const minGroup = everyMinMatch[1];
    if (minGroup === undefined) return cron;
    const n = parseInt(minGroup, 10);
    return n === 1 ? "Every minute" : `Every ${n} minutes`;
  }

  // Every hour: M * * * *
  if (
    minute.match(/^\d+$/) &&
    hour === "*" &&
    dayOfMonth === "*" &&
    month === "*" &&
    dayOfWeek === "*"
  ) {
    const m = parseInt(minute, 10);
    if (m === 0) return "Every hour";
    return `Every hour at :${m.toString().padStart(2, "0")}`;
  }

  // Every N hours: M */N * * *
  const everyHourMatch = hour.match(/^\*\/(\d+)$/);
  if (
    minute.match(/^\d+$/) &&
    everyHourMatch &&
    dayOfMonth === "*" &&
    month === "*" &&
    dayOfWeek === "*"
  ) {
    const hourGroup = everyHourMatch[1];
    if (hourGroup === undefined) return cron;
    const n = parseInt(hourGroup, 10);
    const m = parseInt(minute, 10);
    const suffix = m === 0 ? "" : ` at :${m.toString().padStart(2, "0")}`;
    return n === 1 ? `Every hour${suffix}` : `Every ${n} hours${suffix}`;
  }

  if (!minute.match(/^\d+$/) || !hour.match(/^\d+$/)) return cron;
  const m = parseInt(minute, 10);
  const h = parseInt(hour, 10);

  // Daily at time: M H * * *
  if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return `Every day at ${formatLocalTime(m, h)}`;
  }

  // Specific day of week: M H * * D
  if (dayOfMonth === "*" && month === "*" && dayOfWeek.match(/^\d$/)) {
    const dayIndex = parseInt(dayOfWeek, 10) % 7; // 归一化 7（Sunday 别名）→ 0
    const dayName = DAY_NAMES[dayIndex];
    if (dayName) return `Every ${dayName} at ${formatLocalTime(m, h)}`;
  }

  // Weekdays: M H * * 1-5
  if (dayOfMonth === "*" && month === "*" && dayOfWeek === "1-5") {
    return `Weekdays at ${formatLocalTime(m, h)}`;
  }

  return cron;
}

/** jitter 调优参数（默认值对齐 Claude Code `DEFAULT_CRON_JITTER_CONFIG`）。 */
export type CronJitterConfig = {
  /** recurring 正向延迟占间隔的比例。 */
  recurringFrac: number;
  /** recurring 正向延迟上限。 */
  recurringCapMs: number;
  /** one-shot 提前量上限。 */
  oneShotMaxMs: number;
  /** one-shot 提前量下限（防止落在整点边界上）。 */
  oneShotFloorMs: number;
  /** one-shot 抖动命中分钟门控：分钟 % N === 0 才抖（30 = :00/:30）。 */
  oneShotMinuteMod: number;
  /** recurring 自动过期时长（0 = 永不过期）。 */
  recurringMaxAgeMs: number;
};

export const DEFAULT_CRON_JITTER_CONFIG: CronJitterConfig = {
  recurringFrac: 0.1,
  recurringCapMs: 15 * 60 * 1000,
  oneShotMaxMs: 90 * 1000,
  oneShotFloorMs: 0,
  oneShotMinuteMod: 30,
  recurringMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
};

/**
 * taskId（8 hex）→ [0,1) 的稳定哈希分数。跨重启稳定、全 fleet 均匀分布。
 * 非 hex id 回退 0（无抖动）。
 */
function jitterFrac(taskId: string): number {
  const frac = parseInt(taskId.slice(0, 8), 16) / 0x1_0000_0000;
  return Number.isFinite(frac) ? frac : 0;
}

/**
 * nextCronRunMs + 确定性 per-task 延迟（recurring 专用），避免 thundering herd。
 * 延迟 = min(frac * recurringFrac * 间隔, recurringCapMs)。无第二跳（如固定日期）不抖。
 */
export function jitteredNextCronRunMs(
  cron: string,
  fromMs: number,
  taskId: string,
  cfg: CronJitterConfig = DEFAULT_CRON_JITTER_CONFIG,
): number | null {
  const t1 = nextCronRunMs(cron, fromMs);
  if (t1 === null) return null;
  const t2 = nextCronRunMs(cron, t1);
  if (t2 === null) return t1;
  const jitter = Math.min(
    jitterFrac(taskId) * cfg.recurringFrac * (t2 - t1),
    cfg.recurringCapMs,
  );
  return t1 + jitter;
}

/**
 * nextCronRunMs − 确定性提前量（one-shot 专用，仅命中分钟门控时）。
 * 命中 :00/:30 → 提前 floor + frac*(max-floor)，clamp 到 fromMs（不早于创建时）。
 */
export function oneShotJitteredNextCronRunMs(
  cron: string,
  fromMs: number,
  taskId: string,
  cfg: CronJitterConfig = DEFAULT_CRON_JITTER_CONFIG,
): number | null {
  const t1 = nextCronRunMs(cron, fromMs);
  if (t1 === null) return null;
  // cron 分钟粒度 → 计算出的时刻秒恒为 0，用本地分钟判断热点即可。
  if (new Date(t1).getMinutes() % cfg.oneShotMinuteMod !== 0) return t1;
  const lead =
    cfg.oneShotFloorMs +
    jitterFrac(taskId) * (cfg.oneShotMaxMs - cfg.oneShotFloorMs);
  return Math.max(t1 - lead, fromMs);
}
