import type { JsonStore } from "./json.ts"
import { SETTINGS_KEY } from "./keys.ts"
import { normalizeSettings, type Settings } from "./settings.ts"

/**
 * 输入：存储 + 插件 options（可缺省）。
 * 输出：当前设置。
 * 预期：首次运行时把 options 归一化成默认值写盘；之后以存储里的值为准，
 *       存储损坏或字段缺失时按默认值补齐。
 */
export async function loadSettings(store: JsonStore, options?: unknown): Promise<Settings> {
  const stored = await store.get(SETTINGS_KEY)
  if (stored === undefined) {
    const initial = normalizeSettings(options)
    await store.set(SETTINGS_KEY, initial)
    return initial
  }
  return normalizeSettings(stored)
}

/**
 * 输入：存储 + 完整设置。
 * 输出：无。
 * 预期：先归一化再写盘，保证存储里不会出现未知字段或错误类型。
 */
export async function saveSettings(store: JsonStore, settings: Settings): Promise<void> {
  await store.set(SETTINGS_KEY, normalizeSettings(settings))
}
