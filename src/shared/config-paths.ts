import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

/** 插件配置文件：内容是 JSONC，后缀是 .json。 */
export const CONFIG_FILE = "my-opencode-toolkit.json"

/** 输入：无；输出：OpenCode 全局配置目录。 */
export function globalConfigDirectory(): string {
  const explicit = process.env["OPENCODE_CONFIG_DIR"]
  if (explicit !== undefined && explicit.length > 0) return resolve(explicit)
  const home = process.env["OPENCODE_TEST_HOME"] ?? homedir()
  const xdg = process.env["XDG_CONFIG_HOME"]
  return xdg !== undefined && xdg.length > 0 ? join(xdg, "opencode") : join(home, ".config", "opencode")
}

/** 输入：配置目录；输出：插件配置文件路径。 */
export function configFile(directory: string): string {
  return join(directory, CONFIG_FILE)
}

/** 输入：起始目录；输出：从根到起始目录的 `.opencode` 配置路径（远→近）。 */
export function projectConfigFiles(directory: string): string[] {
  const files: string[] = []
  let current = resolve(directory)
  for (;;) {
    files.push(configFile(join(current, ".opencode")))
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return files.toReversed()
}

/** 输入：项目目录；输出：全局 + 项目层路径（低→高）。 */
export function fallbackConfigFiles(directory: string): string[] {
  return [configFile(globalConfigDirectory()), ...projectConfigFiles(directory)]
}

/** 输入：项目目录 + TUI 传来的层；输出：实际读取/写入顺序。 */
export function resolveConfigFiles(directory: string, layers: readonly string[] | undefined): string[] {
  if (layers !== undefined && layers.length > 0) return [...layers]
  return fallbackConfigFiles(directory)
}
