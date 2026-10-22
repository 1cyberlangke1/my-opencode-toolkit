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

## 进行中

无。

## 待办

P3 通知。
