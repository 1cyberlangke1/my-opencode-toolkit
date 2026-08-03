import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** 项目级 YOLO 配置文件名（跟随项目，已 gitignore）。 */
const YOLO_FILE = "yolo.json";

export interface YoloConfig {
  enabled: boolean;
}

const DEFAULT_YOLO: YoloConfig = { enabled: false };

/** 项目级 YOLO 配置文件路径：`{projectDir}/.opencode-toolkit/yolo.json`。 */
export function yoloFilePath(projectDir: string): string {
  return join(projectDir, ".opencode-toolkit", YOLO_FILE);
}

function parseYolo(raw: unknown): YoloConfig {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_YOLO };
  const obj = raw as Record<string, unknown>;
  const result: YoloConfig = { ...DEFAULT_YOLO };
  if (typeof obj.enabled === "boolean") result.enabled = obj.enabled;
  return result;
}

/** 读取项目 YOLO 配置，坏文件/缺失回退默认（关闭）。 */
export function readYolo(projectDir: string): YoloConfig {
  try {
    const content = readFileSync(yoloFilePath(projectDir), "utf8");
    return parseYolo(JSON.parse(content) as unknown);
  } catch {
    return { ...DEFAULT_YOLO };
  }
}

/** 原子写入项目 YOLO 配置。 */
export function writeYolo(projectDir: string, enabled: boolean): YoloConfig {
  const config: YoloConfig = { enabled };
  const path = yoloFilePath(projectDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  renameSync(tmpPath, path);
  return config;
}

/**
 * YOLO 开启时在 config hook 里注入全局 permission：默认全放行，
 * 用户显式规则（spread 后置）仍优先覆盖——显式 deny 不会被放行。
 * 关闭时不改动 config。
 */
export function applyYoloPermission(cfg: Record<string, unknown>, enabled: boolean): void {
  if (!enabled) return;
  cfg.permission = { "*": "allow", ...((cfg.permission ?? {}) as Record<string, unknown>) };
}
