# my-opencode-toolkit

OpenCode 插件：系统通知、持久目标、定时任务与循环、TUI 状态面板。

## 功能

### 系统通知

- 会话空闲（任务完成）、权限请求（`permission.asked`）、代理提问（`question` 工具）三种通知
- 平台：Windows toast（PowerShell）、macOS（osascript）、Linux（notify-send）
- 标题带会话名，正文按设置语言本地化，长度截断避免 toast 溢出

### 持久目标（Goal）

- 工具：`create_goal`、`get_goal`、`update_goal`
- 命令：`/goal <objective>`、`/goal pause|resume|clear|edit`、裸 `/goal` 查看
- 目标 active 时会话空闲自动注入续作提示；同一原因连续 3 次阻塞才标记 `blocked`
- 记账：每步的输入、输出、缓存读写都计入；达到 token 预算自动转 `budget_limited`
- 用户打断自动暂停；余额不足暂停并锁死，需显式 `/goal resume`

### 定时任务与循环

- 工具：`cron_create`、`cron_list`、`cron_delete`、`schedule_wakeup`
- 命令：
  - `/cron <expr> <prompt>` 创建重复任务
  - `/cron once <expr> <prompt>` 一次性任务
  - `/cron list`、`/cron delete <id>`
  - `/loop [interval] [prompt]` 启动循环，`/loop stop` 停止
- 5 字段 cron（本地时区），支持 `*`、步进、范围、列表；每会话上限 50；重复任务 7 天过期
- durable 任务存插件存储，重启恢复并重新武装 timer；非 durable 只留内存
- 循环：固定间隔或动态（模型用 `schedule_wakeup` 决定下次，60–3600 秒，20 分钟兜底）
- 裸 `/loop` 使用内置维护提示词；项目根目录有非空 `loop.md` 时优先用它

### TUI 面板

- 侧栏显示目标、缓存命中率、工具使用 Top3、子代理数量、循环与定时任务数量
- 统计不单独存一份：每个会话第一次打开面板时，从 OpenCode 已存消息（`session.context`）重建一次，
  之后用事件增量维护；插件重载或进程重启后再重建
- 设置项可控制显示内容与折叠
- `/my-opencode-toolkit` 打开设置菜单：启用、语言、通知、Goal、定时任务、侧栏

### 子代理隔离

子代理会话里不会出现 goal / scheduling 工具，也不会收到任何续作或定时注入。
实现方式是在 `context` 钩子里从工具表删除，并在注入前检查 `session.parentID`。

## 安装

在 `~/.config/opencode/opencode.json` 的 `plugins` 数组里加包名：

```jsonc
{
  "plugins": ["my-opencode-toolkit"]
}
```

本地开发可以直接指向仓库目录：

```jsonc
{
  "plugins": ["D:\\Git_Repository\\my-opencode-toolkit"]
}
```

重启 OpenCode 后生效。

要求 Node 20+；Windows 通知走 PowerShell toast，macOS 走 `osascript`，Linux 走 `notify-send`。

## 设置

设置存在插件存储里，首次启动用默认值；通过 `/my-opencode-toolkit` 菜单修改，立即生效。

| 字段 | 默认 | 说明 |
|---|---|---|
| `lang` | `auto` | `auto` / `zh` / `en` |
| `enabled` | `true` | 插件总开关 |
| `notification.enabled` | `true` | 通知总开关 |
| `notification.onComplete` | `true` | 任务完成通知 |
| `notification.onQuestion` | `true` | 提问通知 |
| `notification.onPermission` | `true` | 权限通知 |
| `notification.onlyMainSession` | `true` | 跳过子代理会话 |
| `goal.enabled` | `true` | Goal 功能 |
| `scheduling.enabled` | `true` | 定时任务与循环 |
| `sidebar.enabled` | `true` | 侧栏面板 |
| `sidebar.showCache` | `true` | 显示缓存命中 |
| `sidebar.showTools` | `true` | 显示工具统计 |
| `sidebar.showSubagents` | `true` | 显示子代理数量 |
| `sidebar.collapsed` | `false` | 折叠侧栏 |

## 优先级

会话空闲时：Goal active > 定时任务 / 循环。Goal 进行中，定时任务到点只重排不注入。

## 已知限制

- 侧栏统计是进程内数据：插件重载或 OpenCode 重启后，第一次打开面板会从已存消息重建；重建之前的事件不会补算。
- 通知是尽力而为：系统关闭通知、专注助手拦截或缺少对应命令时静默跳过，不影响会话。
- 续作与定时注入只在主会话生效；子代理会话既看不到相关工具，也不会被注入。
- 定时任务按本地时区解析 5 字段 cron，不支持秒级字段。

## 开发

```bash
pnpm install
pnpm check        # typecheck + lint + 单测 + TUI 渲染测试
pnpm test:e2e     # 隔离环境启动真实 opencode，假 provider 驱动工具调用
```

要求 Node 20+（OpenCode v2 要求），测试用 vitest + bun。

## License

MIT，见 [LICENSE](LICENSE)。
