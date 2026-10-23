# 维护手册

OpenCode v2 插件，server + TUI 双入口。目标是本地可用、可验证、可发布。

## 入口

| 端 | 入口 | 实际实现 |
|---|---|---|
| server | `index.ts` | `src/index.ts` |
| TUI | `tui.ts` | `src/tui/main.tsx` |

`package.json` 的 `exports` 必须指向这两个入口；`files` 包含 `index.ts`、`tui.ts`、`src`。

## 架构

### Server

`src/index.ts` 的 `setup(ctx)`：

1. `loadSettings` 把 `ctx.options` 归一并写入 `ctx.storage`
2. 注册 `toolkit_ping`
3. 注册 Goal：工具、`/goal` 命令、控制器
4. 注册 cron/loop：工具、命令、timer
5. 注册 RPC：`settingsGet`、`settingsSet`、`panelGet`、`subagentGet`
6. 订阅事件，分发到通知、Goal、调度、统计

统计不落盘：每个 session 第一次 `panelGet` 时从消息重建，之后靠事件增量。

### TUI

`src/tui/main.tsx` 注册：

- `sidebar.content` 四个独立 slot：Goal、Scheduled、Tools、Subagents
- `prompt.footer`：上下文统计
- `app`：`/my-opencode-toolkit` 设置菜单

侧栏分区必须独立注册；宿主 `sidebar.content` 的 `gap={1}` 才会在分区之间产生空行。
不要把多个分区塞进同一个 slot，也不要用空文本行伪造间距。

### Goal

- 工具：`create_goal`、`get_goal`、`update_goal`
- 命令：`/goal ...`
- active 时在空闲边界注入续作
- 用户打断自动暂停；余额不足暂停并锁死
- 子代理不可见、不注入
- 记账：每步 token + wall-clock；`output` 含 reasoning

### cron / loop

- 5 字段 cron，本地时区；支持 `*`、步进、范围、列表、`0/7` 周日
- 四年窗口搜索，支持闰日；不存在的日期拒绝
- 每会话最多 50 个任务；重复任务 7 天过期
- durable 任务存 storage，重启恢复；loop 只在内存
- 触发语义：忙或末条是用户输入时顺延；Plan 模式跳过；功能关闭或 goal active 时让路
- 注入用 `ctx.session.synthetic({ delivery: "steer", resume: true, metadata })`

### 通知

- 会话完成、权限请求、代理提问
- Windows toast / macOS osascript / Linux notify-send
- 探测失败、系统静音、缺少命令都静默跳过
- 正文截断，Windows 侧做 XML 转义

## 数据

- 设置、goal、schedule、统计全部用 `ctx.storage`
- storage key 不带插件名前缀；OpenCode 自动加 `plugin:<id>:`
- 删除会话时清理 goal、schedule、loop、统计、角色缓存
- 唯一读取的项目文件是 `loop.md`
- 不写自定义数据库，不发遥测

## 侧栏显示约定

- 标题：`▶/▼` + 加粗标题 + muted 计数
- 工具：`[name](count)`，`flexWrap="wrap"`，计数为 0 隐藏
- 子代理默认折叠；展开显示 input/output/cached/hit rate/tools
- 没有目标、没有定时任务、没有子代理时整个分区隐藏
- 底部统计：`↑ 输入 ↓ 输出 ♻ 缓存 🎯 命中率`；只给命中率染色

## 验证

```powershell
pnpm check          # typecheck + lint + vitest + TUI + package
pnpm test:e2e       # load / tool visibility / synthetic / compact
pnpm test:e2e:tui   # 真实 TUI 设置菜单
```

e2e 必须隔离：

```text
HOME
USERPROFILE
OPENCODE_DB
OPENCODE_CONFIG_CONTENT
OPENCODE_CONFIG_DIR
XDG_CACHE_HOME
XDG_CONFIG_HOME
XDG_DATA_HOME
XDG_STATE_HOME
```

真实 TUI 用 `opencode --standalone` + PTY（`Bun.Terminal`）。
提交前确认 `opencode.log` 没有 `plugin operation failed`；只通过 `testRender` 不算真实验证。

## 发布

1. `pnpm check`
2. `npm version patch|minor`
3. 提交版本
4. `git tag v<version>`
5. `git push` 后显式 `git push origin v<version>`
6. `gh run watch` 确认 publish workflow 和 provenance

npm 包 `my-opencode-toolkit`；发版走 GitHub Actions + OIDC。
Trusted Publisher 必须勾 **Allow npm publish**，否则 `npm publish` 会 403。
手动发布需要真实终端 OTP；CI 不需要。

## 故障排查

| 现象 | 先查 |
|---|---|
| 插件没加载 | `plugins` 数组拼写、`opencode plugin list`、`opencode.log` |
| TUI 没侧栏 | 是否交互式 TUI；`tui.ts` / `./tui` 入口；模块加载失败 |
| 改了 TUI 没变化 | 热重载缓存旧导出；换新模块路径或完整重启 |
| 工具列表为空 | `panelGet` 是否返回 stats；是否首次重建；工具调用是否已发生 |
| Goal/cron 不注入 | 最后一条是否 user；会话是否忙；Plan 模式；goal 是否 active |
| 通知不出 | 平台命令是否存在；通知总开关；子代理过滤 |
| 设置写回失败 | RPC 是否注册；TUI 是否回滚；storage 是否可写 |

## 关键文件

```text
src/index.ts                  server setup / RPC / 事件分发
src/stats.ts                  统计重建、增量、子代理
src/goal/                     Goal 状态机、工具、命令、续作
src/scheduling/               cron/loop、timer、续作、Plan 跳过
src/notification/             通知格式化与平台发送
src/shared/                   设置、RPC、事件、身份、存储 key
src/tui/main.tsx              TUI 入口、slot、设置菜单、侧栏
tui-test/                     testRender / TUI 单元测试
scripts/e2e-*.mjs             真实 OpenCode e2e
```
