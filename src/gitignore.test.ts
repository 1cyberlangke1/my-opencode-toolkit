// gitignore.ts 单元测试：仅当项目已有 .gitignore 时追加 .opencode-toolkit/（幂等）。
// 顺带覆盖 parseConfig 的 autoGitignore 字段解析。

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ensureToolkitGitignore } from "./gitignore";
import { parseConfig } from "./config/load";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gitignore-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ensureToolkitGitignore", () => {
  test("无 .gitignore 时不创建", () => {
    ensureToolkitGitignore(dir);
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
  });

  test("已含 .opencode-toolkit/ 时幂等不改", () => {
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n.opencode-toolkit/\n", "utf8");
    ensureToolkitGitignore(dir);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("node_modules/\n.opencode-toolkit/\n");
  });

  test("已含无斜杠变体时不重复加", () => {
    writeFileSync(join(dir, ".gitignore"), ".opencode-toolkit\n", "utf8");
    ensureToolkitGitignore(dir);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(".opencode-toolkit\n");
  });

  test("已有不含时末尾追加", () => {
    writeFileSync(join(dir, ".gitignore"), "node_modules/\ndist/\n", "utf8");
    ensureToolkitGitignore(dir);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("node_modules/\ndist/\n.opencode-toolkit/\n");
  });

  test("内容不以换行结尾时补换行再追加", () => {
    writeFileSync(join(dir, ".gitignore"), "node_modules/", "utf8");
    ensureToolkitGitignore(dir);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("node_modules/\n.opencode-toolkit/\n");
  });
});

describe("parseConfig autoGitignore", () => {
  test("默认 true", () => {
    expect(parseConfig(null).autoGitignore).toBe(true);
  });

  test("解析布尔值", () => {
    expect(parseConfig({ autoGitignore: false }).autoGitignore).toBe(false);
    expect(parseConfig({ autoGitignore: true }).autoGitignore).toBe(true);
  });

  test("非法值回退默认", () => {
    expect(parseConfig({ autoGitignore: "yes" }).autoGitignore).toBe(true);
  });
});
