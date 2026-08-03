import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 项目已有 `.gitignore` 时，确保其中包含 `.opencode-toolkit/`（插件的本地状态目录）。
 * 项目没有 `.gitignore` 则跳过（不创建新文件）。幂等：已含则不重复追加。
 */
export function ensureToolkitGitignore(projectDir: string): void {
  const path = join(projectDir, ".gitignore");
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return;
  }
  if (content.includes(".opencode-toolkit")) return;
  const next = content.endsWith("\n") ? `${content}.opencode-toolkit/\n` : `${content}\n.opencode-toolkit/\n`;
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, next, "utf8");
  renameSync(tmpPath, path);
}
