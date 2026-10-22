# 进度

## 当前阶段

P1 Goal 完成，`pnpm check` 与隔离 e2e 全绿。

## 已完成

### P0

- 工具链：TypeScript 6.0.3 + ESLint 10 flat config + vitest 5 + pnpm。
- 旧 V1 源码移到 `legacy/`（gitignored，P5 删除），并从 git 移除。
- 共享层：`src/shared/{json,keys,settings,settings-store,rpc}.ts`。
- i18n：`src/i18n/{types,en,zh,index}.ts`，结构化 `Messages` + `resolveMessages`。
- 服务端：`src/index.ts` 注册设置 RPC 与 `toolkit_ping` 工具。
- TUI：`src/tui/index.tsx` 侧栏状态块 + `/my-opencode-toolkit` 设置菜单。
- 根入口：`index.ts` / `tui.ts` 转发到 `src/`。
- 测试：设置解析、存储、key、i18n。
- e2e：隔离环境启动真实 opencode，假 provider 驱动工具调用。

### P1

- `src/goal/`：types / store / controller / prompts / error / parse-command / continuation / tools / command / index。
- 状态存 `goal:<sessionID>`，所有转换异步落盘；阻塞需同一原因连续 3 次才 blocked。
- 三个工具：`create_goal`、`get_goal`、`update_goal`，对子代理与关闭状态返回错误文本。
- `/goal [objective|clear|edit|pause|resume]`：命令自身不发消息，反馈由 `ctx.session.prompt` 发出。
- 续作：`session.idle` 且目标 active 时注入；打断/超长/余额锁死；一次注入无 step 时跳过一轮。
- 记账：`session.step.ended` 的 input+output+缓存读写计入目标，达到预算转 `budget_limited`。
- 测试：55 个单测（goal 21 个 + continuation 9 个）。
- e2e 扩展到 create_goal → get_goal → 收尾，断言工具表、工具返回与 goal 落盘。

## 进行中

无。

## 待办

P2 cron / loop。
