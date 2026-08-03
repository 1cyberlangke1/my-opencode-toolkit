// /loop 命令解析（三形态对齐 Claude Code bundled loop skill）：
// - `/loop 5m check the deploy` → 固定间隔
// - `/loop check the deploy`（省略间隔）→ 动态/自定速（模型用 ScheduleWakeup 决定下次）
// - 裸 `/loop` / 只有间隔 → 内置 maintenance prompt（{projectDir}/loop.md 可覆盖）
// 秒向上取整到分钟；最小 1 分钟（对齐 cron 分钟粒度）。

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** 内置 maintenance prompt（无 loop.md 时的默认）。 */
export const DEFAULT_LOOP_MAINTENANCE_PROMPT =
  "Continue unfinished work in this session. Re-read AGENTS.md and progress files, pick the next concrete step, and keep going. Run cleanup passes when appropriate.";

export type LoopCommand =
  | { kind: "start"; prompt: string; intervalSeconds?: number }
  | { kind: "invalid"; reason: string };

/** 解析 `\d+[smhd]` 间隔为秒数；秒向上取整到分钟（最小 60s）。非法返回 undefined。 */
export function parseIntervalSeconds(value: string): number | undefined {
  const match = value.match(/^(\d+)([smhd])$/);
  if (match === null) return undefined;
  const nStr = match[1];
  const unit = match[2];
  if (nStr === undefined || unit === undefined) return undefined;
  const n = parseInt(nStr, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  switch (unit) {
    case "s":
      return Math.max(60, Math.ceil(n / 60) * 60);
    case "m":
      return n * 60;
    case "h":
      return n * 3600;
    case "d":
      return n * 86400;
    default:
      return undefined;
  }
}

/**
 * 解析 /loop 参数。返回 `kind: "start"`，`intervalSeconds` 有值 = 固定间隔，无值 = 动态。
 * 首个 token 是合法间隔则剥离，剩余为 prompt；否则整串为 prompt（动态）。
 */
export function parseLoopCommand(arguments_: string): LoopCommand {
  const trimmed = arguments_.trim();
  const parts = trimmed.split(/\s+/);
  const first = parts[0];
  if (first === undefined || first === "") {
    return { kind: "start", prompt: "" };
  }
  const intervalSeconds = parseIntervalSeconds(first);
  if (intervalSeconds !== undefined) {
    return { kind: "start", prompt: parts.slice(1).join(" ").trim(), intervalSeconds };
  }
  return { kind: "start", prompt: trimmed };
}

/** 读取 maintenance prompt：{projectDir}/loop.md 存在则用之，否则内置默认。 */
export function loadLoopMaintenancePrompt(projectDir?: string): string {
  if (projectDir !== undefined) {
    try {
      const raw = readFileSync(join(projectDir, "loop.md"), "utf8").trim();
      if (raw.length > 0) return raw;
    } catch {
      // 文件不存在/不可读 → 用默认
    }
  }
  return DEFAULT_LOOP_MAINTENANCE_PROMPT;
}
