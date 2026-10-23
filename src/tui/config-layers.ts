import type { Context } from "@opencode/plugin/tui/context"
import { basename, join } from "node:path"

import { CONFIG_FILE, fallbackConfigFiles, globalConfigDirectory } from "../shared/config-paths.ts"

/** 输入：TUI 上下文；输出：插件配置层路径（全局在前，项目远→近）。 */
export async function configFileLayers(context: Context): Promise<string[]> {
  const directory = context.location?.directory
  try {
    const entries = await context.client.config.get(
      directory === undefined ? undefined : { location: { directory } },
    )
    const project = entries
      .filter((entry) => entry.type === "directory")
      .map((entry) => entry.path)
      .filter((path) => basename(path) === ".opencode")
      .map((path) => join(path, CONFIG_FILE))
    return [join(globalConfigDirectory(), CONFIG_FILE), ...new Set(project)]
  } catch {
    return directory === undefined
      ? [join(globalConfigDirectory(), CONFIG_FILE)]
      : fallbackConfigFiles(directory)
  }
}
