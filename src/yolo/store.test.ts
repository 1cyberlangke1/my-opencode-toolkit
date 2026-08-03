// store.ts 单元测试：项目级 YOLO 配置读写、坏文件兜底、config hook 注入逻辑。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { applyYoloPermission, readYolo, writeYolo, yoloFilePath } from "./store";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yolo-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readYolo", () => {
  test("缺失文件回退默认（关闭）", () => {
    expect(readYolo(dir)).toEqual({ enabled: false });
  });

  test("坏 JSON 回退默认（关闭）", () => {
    mkdirSync(join(dir, ".opencode-toolkit"), { recursive: true });
    writeFileSync(yoloFilePath(dir), "{ not json", "utf8");
    expect(readYolo(dir)).toEqual({ enabled: false });
  });

  test("非法结构回退默认（关闭）", () => {
    mkdirSync(join(dir, ".opencode-toolkit"), { recursive: true });
    writeFileSync(yoloFilePath(dir), JSON.stringify({ enabled: "yes" }), "utf8");
    expect(readYolo(dir)).toEqual({ enabled: false });
  });

  test("读到合法 enabled 状态", () => {
    mkdirSync(join(dir, ".opencode-toolkit"), { recursive: true });
    writeFileSync(yoloFilePath(dir), JSON.stringify({ enabled: true }), "utf8");
    expect(readYolo(dir)).toEqual({ enabled: true });
  });
});

describe("writeYolo", () => {
  test("写入后读取一致，文件落在项目目录", () => {
    writeYolo(dir, true);
    expect(existsSync(yoloFilePath(dir))).toBe(true);
    expect(readYolo(dir)).toEqual({ enabled: true });
    const raw = readFileSync(yoloFilePath(dir), "utf8");
    expect(JSON.parse(raw)).toEqual({ enabled: true });
  });

  test("覆盖已有配置", () => {
    writeYolo(dir, true);
    writeYolo(dir, false);
    expect(readYolo(dir)).toEqual({ enabled: false });
  });
});

describe("applyYoloPermission", () => {
  test("开启时注入全局通配 allow，保留已有规则", () => {
    const cfg: Record<string, unknown> = { permission: { bash: "deny" } };
    applyYoloPermission(cfg, true);
    expect(cfg.permission).toEqual({ "*": "allow", bash: "deny" });
  });

  test("开启时已有 permission 为 undefined 也能注入", () => {
    const cfg: Record<string, unknown> = {};
    applyYoloPermission(cfg, true);
    expect(cfg.permission).toEqual({ "*": "allow" });
  });

  test("关闭时完全不动 config", () => {
    const cfg: Record<string, unknown> = { permission: { bash: "ask" } };
    applyYoloPermission(cfg, false);
    expect(cfg.permission).toEqual({ bash: "ask" });
  });
});
