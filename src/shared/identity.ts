/**
 * 插件身份常量。
 *
 * 预期：OpenCode 用 `PLUGIN_ID` 派生插件存储命名空间（`plugin:<id>:`）。
 *       改这个值会让已有的 settings / goal / schedule 全部读不到，必须配迁移；
 *       所以运行时代码统一从这里取，不要在别处再写字面量。
 */
export const PLUGIN_ID = "my-opencode-toolkit"

/** TUI 插件独立注册，避免和服务端插件 id 冲突。 */
export const TUI_PLUGIN_ID = `${PLUGIN_ID}.tui`

/** 服务端与 TUI 共用的 RPC 定义 id。 */
export const RPC_ID = PLUGIN_ID

/** TUI keymap 命令 id。 */
export const SETTINGS_COMMAND_ID = `${PLUGIN_ID}.settings`

/** 斜杠命令名（用户输入 `/my-opencode-toolkit`）。 */
export const SETTINGS_SLASH_NAME = PLUGIN_ID
