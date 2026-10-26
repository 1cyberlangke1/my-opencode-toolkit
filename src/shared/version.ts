import { PLUGIN_ID } from "./identity.ts"

/**
 * npm 包名。
 *
 * 预期：与 package.json 的 `name` 一致；`test/update.test.ts` 会在
 *       `pnpm check` 里校验，避免改名后更新命令指向旧包。
 */
export const PLUGIN_PACKAGE = PLUGIN_ID

/**
 * 当前插件版本。
 *
 * 预期：与 package.json 的 `version` 一致；发版递增版本号时必须同步这里，
 *       否则单测会变红，避免 TUI 显示的版本落后于实际安装包。
 */
export const PLUGIN_VERSION = "0.2.30"
