# my-opencode-toolkit

[![ci](https://github.com/1cyberlangke1/my-opencode-toolkit/actions/workflows/ci.yml/badge.svg)](https://github.com/1cyberlangke1/my-opencode-toolkit/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/my-opencode-toolkit)](https://www.npmjs.com/package/my-opencode-toolkit)

OpenCode v2 插件：系统通知、持久目标、定时任务与循环、TUI 状态面板。

## 要求

- OpenCode `2.x`
- Node `>= 20`（OpenCode 自带 Bun 运行时，插件本身也用 Node API）
- Windows / macOS / Linux

## 安装

在全局或项目级 `opencode.json` 里把包名加进 **`plugins`** 数组（注意是 `plugins`，不是 `plugin`）：

```json
{
  "plugins": ["my-opencode-toolkit"]
}
```

本地开发时可以直接指向目录：

```json
{
  "plugins": ["D:\\Git_Repository\\my-opencode-toolkit"]
}
```

重启 OpenCode 后生效。TUI 面板和 `/my-opencode-toolkit` 设置菜单由包内的 `tui` 入口提供，不需要额外配置。

## 功能

### 系统通知

- 会话空闲（任务完成）、权限请求（`permission.asked`）、代理提问（`question` 工具）三种通知
- 平台：Windows toast（PowerShell）、macOS（osascript）、Linux（notify-send）
- 标题带会话名；正文按设置语言本地化；完成通知附带最后一条用户/助手文本
- 通知是尽力而为：系统关闭通知、专注助手拦截或缺少对应命令时静默跳过，不影响会话

### 持久目标（Goal）

- 工具：`create_goal`、`get_goal`、`update_goal`
- 命令：`/goal <objective>`、`/goal pause|resume|clear|edit`、裸 `/goal` 查看
- 目标 active 时会话空闲自动注入续作提示；同一阻塞原因连续 3 次才标记 `blocked`
- 记账：每步的输入、输出、缓存读写都计入；达到 token 预算自动转 `budget_limited`
- 用户打断自动暂停；余额不足暂停并锁死，需显式 `/goal resume`
- 子代理会话看不到 goal 工具，也不会被注入续作

### 定时任务与循环

- 工具：`cron_create`、`cron_list`、`cron_delete`、`schedule_wakeup`
- 命令：
  - `/cron <expr> <prompt>` 创建重复任务
  - `/cron once <expr> <prompt>` 一次性任务
  - `/cron list`、`/cron delete <id>`
  - `/loop [interval] [prompt]` 启动循环，`/loop stop` 停止
- 5 字段 cron（本地时区）：`分 时 日 月 周`
  - 支持 `*`、步进 `*/n`、范围 `a-b`、范围步进 `a-b/n`、列表 `a,b`
  - 周字段 `0` 和 `7` 都表示周日
  - 下一次触发在四年窗口内搜索，支持 `2 月 29 日`；永远不存在的日期会被拒绝
- 每会话最多 50 个任务；重复任务 7 天后自动过期
- durable 任务存插件存储，重启恢复并重新武装 timer；非 durable 只留内存
- 循环只存在内存，重启后消失；需要跨重启请用 cron
- 循环：固定间隔或动态（模型用 `schedule_wakeup` 决定下次，60–3600 秒，20 分钟兜底）
- 固定间隔范围 60 秒 – 7 天；裸 `/loop` 使用内置维护提示词，项目根目录有非空 `loop.md` 时优先用它

#### 触发语义

- 任务只在会话空闲时注入；会话忙或末条是用户输入时**顺延重试**，不会静默丢失
- 功能关闭或目标进行中时任务让路，同样只顺延、不消费；重新开启后一分钟内恢复
- 重启后已过点的任务会补触发一次，不会把错过的每个时间点都补一遍
- 重复任务错过的时间点只补一次；一次性任务会一直重试到成功注入或会话被删除

### TUI 面板

- 侧栏显示目标、缓存命中率、工具使用 Top3、子代理数量、循环与定时任务数量
- 统计不单独存一份：每个会话第一次打开面板时，从 OpenCode 已存消息（`session.context`）重建
- 设置菜单：`/my-opencode-toolkit`，可热改语言、通知、Goal、定时任务与侧栏显示项
- 设置写入失败会回滚本地显示

## 命令与工具

| 命令 | 作用 |
|---|---|
| `/my-opencode-toolkit` | 打开设置菜单（TUI） |
| `/goal <objective>` | 设置/覆盖当前会话的持久目标 |
| `/goal` | 查看当前目标 |
| `/goal pause` / `resume` / `clear` / `edit` | 暂停 / 恢复 / 清除 / 编辑目标 |
| `/cron <expr> <prompt>` | 创建重复任务 |
| `/cron once <expr> <prompt>` | 创建一次性任务 |
| `/cron list` | 列出任务 |
| `/cron delete <id>` | 删除任务 |
| `/loop [interval] [prompt]` | 启动循环；不带间隔为 dynamic 模式 |
| `/loop stop` | 停止当前会话全部循环 |

| 工具 | 作用 |
|---|---|
| `toolkit_ping` | 返回插件是否启用与当前语言，用于验证加载 |
| `create_goal` / `get_goal` / `update_goal` | 目标读写与完成/阻塞标记 |
| `cron_create` / `cron_list` / `cron_delete` | 定时任务管理 |
| `schedule_wakeup` | dynamic 循环的下次唤醒时间 |

## 设置

设置存在 OpenCode 插件存储里，通过 TUI 菜单修改；插件 `options` 只在首次运行时作为初始值。

| 字段 | 默认 | 说明 |
|---|---|---|
| `lang` | `auto` | `auto` / `zh` / `en` |
| `enabled` | `true` | 插件总开关；关闭后隐藏工具、停止注入与通知 |
| `notification.enabled` | `true` | 通知总开关 |
| `notification.onComplete` | `true` | 会话完成通知 |
| `notification.onQuestion` | `true` | 代理提问通知 |
| `notification.onPermission` | `true` | 权限请求通知 |
| `notification.onlyMainSession` | `true` | 只通知主会话，忽略子代理 |
| `goal.enabled` | `true` | 持久目标功能 |
| `scheduling.enabled` | `true` | 定时任务与循环功能 |
| `sidebar.enabled` | `true` | 侧栏面板 |
| `sidebar.showCache` | `true` | 显示缓存命中率 |
| `sidebar.showTools` | `true` | 显示工具使用 Top3 |
| `sidebar.showSubagents` | `true` | 显示子代理数量 |
| `sidebar.collapsed` | `false` | 折叠侧栏内容 |

## 数据与隐私

- 目标、任务、设置都写在 OpenCode 的插件存储里，不额外建数据库
- 存储 key 不带插件名前缀；OpenCode 会自动放进 `plugin:<插件 ID>:` 命名空间
- 运行时不写任何自定义文件；唯一读取的项目文件是 `loop.md`（用户提供的循环提示词）
- 通知预览会读取当前会话最后一条用户/助手文本，只用于本地系统通知
- 不发送任何遥测；不访问网络（通知命令与 OpenCode 自身除外）
- 删除会话时会清掉该会话的 goal、定时任务、循环、统计与角色缓存

## 排障

**插件没加载**

1. 确认 `opencode.json` 用的是 `plugins` 数组，且包名拼写正确
2. 跑 `opencode plugin list` 看是否列出 `my-opencode-toolkit`
3. 重启 OpenCode；已存在的会话不会重建工具表，建议新开会话验证

**TUI 没有侧栏/设置菜单**

- TUI 插件只在交互式 TUI 里加载；`opencode run` 不渲染侧栏
- 确认包内 `tui.ts`（或 npm 包的 `./tui` 导出）存在
- 重启 TUI；插件热重载不会重放已注册的 slot

**没有系统通知**

- 检查系统通知权限与专注助手
- Windows 确认 `powershell.exe` 在 PATH；macOS 确认 `osascript`；Linux 确认 `notify-send`
- 用 `toolkit_ping` 确认插件本身已加载

**定时任务没触发**

- 检查会话是否长期处于目标 active 状态（会主动让路）
- Plan 模式下会直接跳过并弹 toast；切回 build 后按原计划继续（one-shot 会被消费）
- 检查任务是否已超过 7 天过期
- 检查时区：cron 按本地时区解析
- 用 `/cron list` 确认任务还在

## 开发

```bash
pnpm install
pnpm check        # typecheck + lint + 180 单测 + 8 bun 测试 + 发布包内容校验
pnpm test:e2e     # 需要本机 opencode 2.x 与 bun，使用隔离的 HOME/DB/config
pnpm test:e2e:tui # 真实 TUI：PTY 启动 opencode --standalone，打开设置菜单
```

e2e 用假 provider 驱动工具调用，不会请求真实模型；它会在临时目录里启动一个隔离的 OpenCode server，不读写日常数据。`test:e2e:tui` 通过 ConPTY（Windows）或 openpty（macOS/Linux）驱动真实 TUI，验证 TUI 插件加载、斜杠命令与设置菜单渲染。

## 许可证

MIT
