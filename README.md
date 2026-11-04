# my-opencode-toolkit

[![ci](https://github.com/1cyberlangke1/my-opencode-toolkit/actions/workflows/ci.yml/badge.svg)](https://github.com/1cyberlangke1/my-opencode-toolkit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/my-opencode-toolkit)](https://www.npmjs.com/package/my-opencode-toolkit)
[![license](https://img.shields.io/npm/l/my-opencode-toolkit)](LICENSE)

OpenCode v2 插件，提供系统桌面通知、定时与循环任务、时间感知、自定义提供商管理，以及侧栏与底栏的状态面板。

## 环境要求

- OpenCode `2.x`
- Node `>= 20`
- Windows / macOS / Linux

## 安装

在全局或项目级 `opencode.json` 的 `plugins` 数组里加入插件名：

```json
{
  "plugins": ["my-opencode-toolkit"]
}
```

调试本地源码时可以直接指向目录：

```json
{
  "plugins": ["./path/to/my-opencode-toolkit"]
}
```

配置后重启 OpenCode。

## 功能

### 系统桌面通知

- 会话完成、模型提问、请求授权时发送系统通知。
- Windows 走 Toast，macOS 走 `osascript`，Linux 走 `notify-send`。
- 系统静音、专注助手拦截或缺少对应命令时静默跳过，不影响正常交互。
- 默认只通知主会话，忽略子代理。

### 定时任务与循环

- 标准 5 字段 Cron 表达式，按本地时区计算，支持重复与一次性任务。
- 循环任务支持固定间隔，也支持由模型自行决定下次唤醒时机的动态模式。
- 仅在会话空闲时触发；会话繁忙、有用户输入待处理时自动顺延。
- Plan 模式或持久目标进行中时让路，不打断当前工作。
- 重复任务最长保留 7 天。

### 时间感知

- 默认每 5 分钟向会话注入一条当前时间，模型随时知道“现在几点”。
- 也可切换为按步数注入（`time.mode = "steps"`）。
- 注入文本是纯格式化时间串，格式模板与时区可自定义。
- 不在后台轮询：只在用户提问或工具执行完时检查一次，未到间隔静默放行；长时间无交互不会积压多条。

### 自定义提供商管理

为第三方中转站、私有聚合网关与本地自建模型（vLLM / Ollama / LM Studio）准备，官方提供商请直接用 `/connect`。

- 填 Base URL 与可选 API Key 后自动拉取 `/models`，与已知模型库模糊匹配，自动补全上下文窗口、最大输出与工具能力。
- 未匹配到的模型套用 128k / 4096 / 纯文本兜底，可手动修改。
- 能力用紧凑记号呈现：`🪟 128k`、`🛠️` 工具、`👁️` 视觉、`🎙️` 音频、`🎬` 视频、`💬` 文本。
- 选择 SDK 时右侧显示它实际请求的端点（`/chat/completions`、`/responses`、`/messages` 等），便于判断中转站用的是哪套协议。
- 写入基于 `jsonc-parser` 做 AST 局部修改，保留原有注释与缩进；写入前校验语法，落盘用临时文件原子替换。

### 状态面板

- 侧栏展示定时任务、工具调用计数与子代理运行状态，可分别开关。
- 底栏显示累计 Token 输入、输出、缓存与命中率，可逐项开关。
- `/my-opencode-toolkit` 打开图形化设置菜单，所有开关与参数即时生效。
- 菜单内可检查 npm 最新版本，确认后原地显示更新进度，完成后提示重启 OpenCode。

### 持久目标（已弃用）

默认关闭。OpenCode v2.2.1 起官方内置 `/goal`，建议使用官方实现；以下仅为该功能开启时的行为。

- 为会话设定高层目标后，在每次空闲边界自动注入续作提示，直到标记完成或阻塞。
- 累计每一步的 Token 消耗，超出预算时自动暂停并等待确认。
- 对子代理会话完全隔离。

## 命令与工具

### 斜杠命令

| 命令 | 说明 |
|---|---|
| `/my-opencode-toolkit` | 打开插件设置菜单 |
| `/provider` | 管理自定义提供商与模型 |
| `/goal <objective>` | 设置或覆盖当前会话的持久目标 |
| `/goal` | 查看当前目标状态与进度 |
| `/goal pause` / `resume` / `clear` / `edit` | 暂停 / 恢复 / 清除 / 编辑目标 |
| `/cron <expr> <prompt>` | 创建重复定时任务 |
| `/cron once <expr> <prompt>` | 创建一次性定时任务 |
| `/cron` / `/cron list` | 查看定时任务列表 |
| `/cron delete <id>` | 按 ID 删除定时任务 |
| `/loop [interval] [prompt]` | 启动循环任务；省略间隔则为动态模式 |
| `/loop stop` | 停止当前会话的全部循环任务 |

### Agent 工具

| 工具 | 说明 |
|---|---|
| `create_goal` / `get_goal` / `update_goal` | 创建、查询目标，更新状态：`complete` / `blocked` / `paused` / `active` / `cleared` |
| `cron_create` / `cron_list` / `cron_delete` | 创建、查询、删除定时任务 |
| `schedule_wakeup` | 动态循环模式下设置下一次唤醒时间 |

## 配置

配置保存在插件自己的 JSONC 文件 `my-opencode-toolkit.json` 中，支持 `//` 注释。推荐用 `/my-opencode-toolkit` 修改，也可以直接编辑文件。

| 层级 | 路径 |
|---|---|
| 全局 | `$OPENCODE_CONFIG_DIR`；未设置时用 `$XDG_CONFIG_HOME/opencode`；再退回 `~/.config/opencode` |
| 项目 | 从当前目录向上每一层的 `.opencode/my-opencode-toolkit.json` |

生效顺序为「内置默认 < 全局 < 外层项目 < 内层项目」；对象按键深合并，数组整体替换。保存时写入最近一个已存在的项目文件，没有则写全局文件。

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `lang` | `auto` | 界面语言：`auto` / `zh` / `en` |
| `enabled` | `true` | 插件总开关；关闭后不注册工具、不注入、不通知（仅能改文件） |
| `notification.enabled` | `true` | 通知总开关 |
| `notification.onComplete` | `true` | 会话完成时通知 |
| `notification.onQuestion` | `true` | 模型提问时通知 |
| `notification.onPermission` | `true` | 请求授权时通知 |
| `notification.onlyMainSession` | `true` | 忽略子代理事件 |
| `goal.enabled` | `false` | 是否启用持久目标（已弃用） |
| `goal.showInSidebar` | `true` | 侧栏是否显示目标分区 |
| `scheduling.enabled` | `true` | 是否启用定时与循环 |
| `scheduling.showInSidebar` | `true` | 侧栏是否显示定时分区 |
| `sidebar.showTools` | `false` | 侧栏是否显示工具调用计数 |
| `sidebar.showSubagents` | `false` | 侧栏是否显示子代理 |
| `contextStats.enabled` | `true` | 底栏是否显示 Token 统计 |
| `contextStats.showInput` / `showOutput` / `showCache` / `showHitRate` | `true` | 底栏各字段开关 |
| `time.enabled` | `true` | 是否启用时间感知 |
| `time.mode` | `interval` | 触发模式：`interval` 按时间 / `steps` 按步数 |
| `time.intervalSeconds` | `300` | 时间模式下的间隔（秒，最小 30） |
| `time.intervalSteps` | `3` | 步数模式下的间隔（最小 1） |
| `time.format` | `YYYY-MM-DD HH:mm:ss` | 时间格式模板（token：`YYYY MM DD HH mm ss`） |
| `time.timezone` | 空 | IANA 时区；空 = 跟随宿主，非法值回落宿主 |
| `editor.enabled` | Windows `true`，其它 `false` | 是否启用外部编辑器支持 |
| `editor.command` | Windows `notepad`，其它空 | 编辑器命令，如 `code --wait`、`nvim` |
| `editor.showHint` | `true` | 输入框底栏是否显示编辑器快捷键提示 |

## 数据与隐私

- 目标、定时任务、统计等运行数据存放在 OpenCode 插件专有存储中，不创建独立的本地数据库文件；配置本身保存在上文的 JSONC 文件里。
- 不采集遥测。仅在主动检查更新时查询 npm registry。
- 会话删除时自动清理该会话关联的目标、任务、循环、统计与角色缓存。

## 常见排查

### 插件未加载

- 确认配置的是 `plugins` 数组，不是单数 `plugin`。
- 用 `opencode plugin list` 查看是否已识别。
- 重启 OpenCode；已打开的旧会话不会重建工具列表，请在新会话验证。

### 侧栏或设置菜单没出现

- TUI 扩展只在交互式终端中加载，`opencode run` 等非交互模式不渲染。
- 热重载不一定生效，请完整重启 TUI 进程。

### 没收到桌面通知

- 检查系统通知权限，以及是否处于专注助手 / 勿扰模式。
- Windows 需要 `powershell.exe`，macOS 需要 `osascript`，Linux 需要 `notify-send`。

### 定时任务没按时触发

- 检查会话是否正被持久目标占用，或处于 Plan 模式。
- 重复任务超过 7 天会自动过期，用 `/cron list` 确认。

## 许可证

[MIT](LICENSE)
