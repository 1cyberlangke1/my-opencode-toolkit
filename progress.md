# 进度

## 当前阶段

P2 cron / loop 完成，`pnpm check` 与隔离 e2e 全绿。

## 已完成

### P0

- 工具链：TypeScript 6.0.3 + ESLint 10 flat config + vitest 5 + pnpm。
- 旧 V1 源码移到 `legacy/`（gitignored，P5 删除），并从 git 移除。
- 共享层：`src/shared/{json,keys,settings,settings-store,rpc,scan}.ts`。
- i18n：`src/i18n/{types,en,zh,index}.ts`，结构化 `Messages` + `resolveMessages`。
- 服务端：`src/index.ts` 注册设置 RPC、`toolkit_ping`、统一 context 钩子。
- TUI：`src/tui/index.tsx` 侧栏状态块 + `/my-opencode-toolkit` 设置菜单。
- 根入口：`index.ts` / `tui.ts` 转发到 `src/`。
- e2e：隔离环境启动真实 opencode，假 provider 驱动工具调用。

### P1

- `src/goal/`：types / store / controller / prompts / error / parse-command / continuation / tools / command / session-role / filter / index。
- 状态存 `goal:<sessionID>`；阻塞需同一原因连续 3 次。
- 三个工具 + `/goal` 命令 + 空闲续作 + 事件记账。
- 子代理：context 钩子删工具，续作直接跳过。

### P2

- `src/scheduling/`：types / cron / store / loops / continuation / tools / command / filter / index。
- 5 字段 cron 解析、next-run、确定性 jitter、人类可读描述。
- durable 任务存 `schedule:<sessionID>`，重启恢复并重新武装 timer；上限 50，recurring 7 天过期。
- 工具：`cron_create` / `cron_list` / `cron_delete` / `schedule_wakeup`。
- 命令：`/loop [interval] [prompt]`、`/loop stop`、`/cron <expr> <prompt>`、`/cron once ...`、`/cron list`、`/cron delete <id>`。
- 注入规则：子代理跳过、goal active 让路、上一条未完成跳过；timer + idle 双通道。

### P3

- `src/notification/`：format / send / index。
- OS 级通知：Windows toast、macOS osascript、Linux notify-send，命令探测缓存、长度截断。
- 事件：`session.idle` 完成、`permission.asked` 权限、`question` 工具提问。
- 多语言文案跟随设置语言；`onlyMainSession` 跳过子代理；idle 1 秒去重。

### P4

- `src/stats.ts`：内存统计（step token、工具计数、子代理数、命中率）。
- RPC 新增 `panelGet`，返回 goal / loops / jobs / stats。
- TUI 侧栏：目标、缓存命中、工具 Top3、子代理、循环与任务数量；按会话事件节流刷新。
- `/my-opencode-toolkit` 菜单新增侧栏子菜单（启用/缓存/工具/子代理/折叠）。
- `tui-test/`：2 个渲染测试，`pnpm check` 已包含 `test:tui`。

### P5

- 删除 `legacy/` 与无用的 `.prettierrc`。
- 重写 README：功能、安装、命令、工具、设置、优先级、开发命令。
- `files` 补上根入口 `index.ts` / `tui.ts`，保证 npm 安装能用。
- 全量验证：143 单测 + 2 TUI 渲染测试 + e2e 全绿。

### 加固（0.2.1）

- 事件订阅合并成一个 dispatcher，单 handler 抛错不影响其他 handler 与后续事件。
- 完成信号补 `session.execution.succeeded`，与 `session.idle` 1 秒去重。
- 通知带最后一条用户/助手文本预览。
- 续作/定时/循环注入带 metadata 标记，注入前检查末条是否真实用户输入。
- `MAX_JOBS` 改为按会话计数。
- 统计改为按需从 OpenCode 消息重建，不落盘。
- 删除死代码：`GoalUpdate`、`GOAL_TOOL_NAMES`、`SCHEDULING_TOOL_NAMES`、`menu.back`、`patchSettings`；`parseCronHuman` 取消导出。
- 新增 `shared/events.ts`（事件读取 + dispatcher）、`shared/messages.ts`（末条用户输入判断）、`shared/types.ts`（Disposable）。

## 进行中

无。

## 待办

- 发版（版本号待定；npm 包名 `my-opencode-toolkit`）。
- 可选：统计持久化（当前进程重启归零）。
