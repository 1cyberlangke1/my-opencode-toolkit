import { resolveConfigFiles } from "./config-paths.ts"
import { diffConfig, nearestExistingConfig, readMergedConfig, writeConfigValues } from "./settings-file.ts"
import { normalizeSettings, type Settings } from "./settings.ts"

/** 读取/写入设置需要的上下文。 */
export type SettingsContext = {
  readonly location?: { readonly directory?: string }
}

/**
 * 输入：插件上下文 + 可选层路径。
 * 输出：JSONC 合并后的设置。
 * 预期：默认值 < 全局 < 远项目 < 近项目；坏层跳过；不读 storage。
 */
export async function loadSettings(ctx: SettingsContext, layers?: readonly string[]): Promise<Settings> {
  const paths = resolveConfigFiles(ctx.location?.directory ?? process.cwd(), layers)
  const merged = await readMergedConfig(paths)
  return normalizeSettings(merged.values)
}

/**
 * 输入：插件上下文 + 完整设置 + 可选层路径。
 * 输出：实际写入的目标文件路径（无变更返回 undefined）；失败抛错。
 * 预期：只写变化键；优先最近已存在的项目文件，否则全局。
 */
export async function saveSettings(
  ctx: SettingsContext,
  settings: Settings,
  layers?: readonly string[],
): Promise<string | undefined> {
  const paths = resolveConfigFiles(ctx.location?.directory ?? process.cwd(), layers)
  const target = await nearestExistingConfig(paths)
  if (target === undefined) throw new Error("no plugin config path")
  const merged = await readMergedConfig(paths)
  const normalized = normalizeSettings(settings)
  const patch = diffConfig(merged.values, { ...normalized })
  if (patch === undefined) return target
  const result = await writeConfigValues(target, patch)
  if (!result.ok) throw new Error(result.error)
  return target
}
