# my-opencode-toolkit

[![ci](https://github.com/1cyberlangke1/my-opencode-toolkit/actions/workflows/ci.yml/badge.svg)](https://github.com/1cyberlangke1/my-opencode-toolkit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/my-opencode-toolkit)](https://www.npmjs.com/package/my-opencode-toolkit)
[![license](https://img.shields.io/npm/l/my-opencode-toolkit)](LICENSE)

OpenCode v2 插件，提供系统桌面通知、持久目标追踪（Goal）、定时与循环任务（Cron / Loop）以及 TUI 状态面板。

## 环境要求

- OpenCode `2.x`
- Node `>= 20`
- Windows / macOS / Linux

## 安装

在全局或项目级 `opencode.json` 中将插件添加到 `plugins` 数组：

```json
{
  "plugins": ["my-opencode-toolkit"]
}
```

本地开发调试时，也可以直接指定本地目录路径：

```json
{
  "plugins": ["./path/to/my-opencode-toolkit"]
}
```

配置后重启 OpenCode 即可生效。

## 功能说明

### 系统桌面通知
- 当会话空闲（任务完成）、请求权限（`permission.asked`）或模型提问（`question`）时发送系统通知。
- 跨平台支持：Windows Toast（PowerShell）、macOS（osascript）、Linux（notify-send）。
- 当系统处于静音、专注助手拦截或缺少对应命令时静默跳过，不影响正常交互。

### 持久目标（Goal）
- 为会话设定高层目标后，会在每次空闲边界自动注入续作提示，直到任务标记完成或遇到明确阻塞。
- 自动累计每一步的 Token 输入、输出与缓存消耗；超出预设 Token 预算时自动暂停并等待确认。
- 用户手动打断时自动暂停；对子代理会话完全隔离，避免递归干扰。

### 定时任务与循环（Cron / Loop）
- 支持标准 5 字段 Cron 表达式（本地时区），支持创建重复或一次性任务。
- 支持循环任务（固定时间间隔或由模型动态决策下一次唤醒时机）。
- 仅在会话空闲时触发，会话繁忙或有待处理的用户输入时自动顺延，避免打断交互。

### TUI 状态面板
- 在侧栏展示当前持久目标、生效中的定时任务、工具调用频次与子代理运行状态。
- 在底部状态栏实时显示累计 Token 输入、输出、缓存及命中率。
- 提供图形化设置菜单（`/my-opencode-toolkit`），支持热切换所有开关与参数。
- 设置菜单最后一项可检查 npm 最新版；发现新版本后在 TUI 内执行固定更新命令，实时显示命令输出，完成后弹窗提示重启 OpenCode，不弹出独立 shell 窗口。

## 命令与工具

### 斜杠命令（用户交互）

| 命令 | 说明 |
|---|---|
| `/my-opencode-toolkit` | 打开插件图形化设置菜单 |
| `/goal <objective>` | 设置或覆盖当前会话的持久目标 |
| `/goal` | 查看当前目标状态与进度 |
| `/goal pause` / `resume` / `clear` / `edit` | 暂停 / 恢复 / 清除 / 编辑当前目标 |
| `/cron <expr> <prompt>` | 创建重复定时任务（5 字段 cron，本地时区） |
| `/cron once <expr> <prompt>` | 创建一次性定时任务 |
| `/cron list` | 查看当前会话的定时任务列表 |
| `/cron delete <id>` | 按 ID 删除指定的定时任务 |
| `/loop [interval] [prompt]` | 启动循环任务（不带间隔则为 dynamic 动态决策模式） |
| `/loop stop` | 停止当前会话的所有循环任务 |

### Agent 工具箱（模型调用）

| 工具 | 说明 |
|---|---|
| `create_goal` / `get_goal` / `update_goal` | 创建、查询当前目标以及更新目标状态（完成或阻塞） |
| `cron_create` / `cron_list` / `cron_delete` | 创建、查询与删除定时任务 |
| `schedule_wakeup` | 动态循环模式下设置下一次唤醒间隔时间 |

## 配置项

所有配置项均保存在 OpenCode 的插件存储中，推荐通过 `/my-opencode-toolkit` 设置菜单修改，也可在 `opencode.json` 的 `options` 字段作为初始默认值传入：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `lang` | `auto` | 界面语言（`auto` / `zh` / `en`） |
| `notification.enabled` | `true` | 通知总开关 |
| `notification.onComplete` | `true` | 会话空闲/任务完成时通知 |
| `notification.onQuestion` | `true` | 模型提问时通知 |
| `notification.onPermission` | `true` | 请求授权时通知 |
| `notification.onlyMainSession` | `true` | 仅通知主会话，忽略子代理事件 |
| `goal.enabled` | `true` | 是否启用持久目标功能 |
| `goal.showInSidebar` | `true` | 是否在侧栏展示目标进度 |
| `scheduling.enabled` | `true` | 是否启用定时任务与循环功能 |
| `scheduling.showInSidebar` | `true` | 是否在侧栏展示定时任务 |
| `sidebar.showTools` | `true` | 是否在侧栏展示工具调用计数 |
| `sidebar.showSubagents` | `true` | 是否在侧栏展示子代理详情 |
| `contextStats.enabled` | `true` | 是否在底部状态栏展示 Token 统计 |

## 数据与隐私

- 数据均存放在 OpenCode 插件专有存储中，不创建独立的本地数据库文件。
- 不采集遥测数据；仅在用户主动打开“检查更新”时查询 npm registry，系统通知命令也不会上传会话内容。
- 会话删除时会自动清理该会话关联的所有目标、定时任务、循环、统计与角色缓存。

## 常见排查

### 插件未加载
- 确认 `opencode.json` 中配置的是 `plugins` 数组，而不是单数 `plugin`。
- 运行 `opencode plugin list` 查看插件是否已正常识别。
- 重启 OpenCode（已打开的既有会话不会动态重建工具列表，请在新会话中验证）。

### TUI 未显示侧栏或设置菜单
- TUI 扩展仅在交互式 TUI 终端模式下加载，`opencode run` 等非交互模式不渲染侧栏。
- 若热重载后未生效，请完整重启 TUI 进程。

### 未收到桌面通知
- 检查操作系统通知设置是否允许通知，以及系统是否处于“专注助手 / 勿扰模式”。
- 确认系统中对应的通知执行环境正常（Windows 需 `powershell.exe`，macOS 需 `osascript`，Linux 需 `notify-send`）。

### 定时任务未按时触发
- 检查会话是否长期处于 active 目标进行中（定时任务会自动让路以避免打扰）。
- Plan 模式下会顺延跳过任务，切回 Build 模式后按计划恢复。
- 确认定时任务是否已超过 7 天最大有效期，可通过 `/cron list` 查看当前任务状态。

## 本地开发

```bash
pnpm install
pnpm check      # 类型检查、代码检查、单元测试与打包校验
pnpm test:e2e   # 端到端自动化集成测试
pnpm test:e2e:update  # 真实 TUI 更新入口（本地 registry + 假更新命令）
```

发版在 GitHub Actions 手动运行 `publish` workflow，并选择 `patch`、`minor` 或 `major`；workflow 会同步版本文件、跑完整检查、提交、更新 `master`、打 tag 并发布 npm。

## 许可证

[MIT](LICENSE)
