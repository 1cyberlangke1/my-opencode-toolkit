# 任务计划

OpenCode V2 插件重写。功能保留：通知、Goal、cron/loop、TUI 侧栏。
删除：todo 自动续作、yolo。

## 约束

- 不写 `any`、不加 `@ts-ignore`、不放宽 tsconfig；`pnpm check` 必须全绿。
- 测试必须与日常使用的 OpenCode 隔离：独立 HOME、内存/临时 DB、内联配置。
- 命令：`/my-opencode-toolkit`（TUI 菜单）、`/goal`、`/loop`、`/cron`。
- 设置存 `ctx.storage`，TUI 菜单可热改；`ctx.options` 只作首次默认值。
- 侧栏数据走 RPC，不轮询文件。
- 定时任务注入走 `ctx.session.prompt`，真实进入对话流。

## 阶段

### P0 骨架

- [x] 工具链：package.json / tsconfig / eslint / vitest / .gitignore
- [x] 旧代码移到 `legacy/`（P5 删除），不参与类型检查
- [x] `src/shared/keys.ts` storage key 常量
- [x] `src/shared/settings.ts` 设置类型、默认值、解析（纯函数）
- [x] `src/shared/rpc.ts` RPC 定义
- [x] `src/i18n/{types,en,zh,index}.ts`
- [x] `src/index.ts` 服务端插件：注册设置 RPC、`toolkit_ping` 工具
- [x] `src/tui/index.tsx` 侧栏占位 + `/my-opencode-toolkit` 菜单
- [x] 单测：设置解析、i18n、key 生成
- [x] `scripts/e2e-load.mjs` 隔离环境加载验证

### P1 Goal

- [x] goal 状态存储（`goal:<sessionID>`）
- [x] 工具 `create_goal` / `get_goal` / `update_goal`
- [x] `/goal` 命令：设置 / 暂停 / 恢复 / 清除 / 查看
- [x] 会话空闲续作（`ctx.session.prompt`）
- [x] token 与时间记账
- [x] 用户打断自动暂停

### P2 cron / loop

- [x] cron 表达式解析与校验
- [x] 任务存储与上限、过期
- [x] 定时器调度与重启恢复
- [x] `/cron`、`/loop` 命令
- [x] `schedule_wakeup` 工具

### P3 通知

- [x] 跨平台发送（PowerShell toast / osascript / notify-send）
- [x] 完成 / 提问 / 权限事件
- [x] 截断与多语言

### P4 TUI

- [ ] Goal 面板
- [ ] Scheduled 面板
- [ ] 会话统计（缓存命中、工具、子代理）
- [ ] `/my-opencode-toolkit` 完整菜单

### P5 收尾

- [ ] 删除 `legacy/`
- [ ] README / LICENSE
- [ ] 全量测试与 e2e
- [ ] 发版
