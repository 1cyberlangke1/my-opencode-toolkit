# 进度

## 当前阶段

P0 骨架完成，`pnpm check` 与隔离 e2e 全绿。

## 已完成

### P0

- 工具链：TypeScript 6.0.3 + ESLint 10 flat config + vitest 5 + pnpm。
- 旧 V1 源码移到 `legacy/`（gitignored，P5 删除），并从 git 移除。
- 共享层：`src/shared/{json,keys,settings,settings-store,rpc}.ts`。
- i18n：`src/i18n/{types,en,zh,index}.ts`，结构化 `Messages` + `resolveMessages`。
- 服务端：`src/index.ts` 注册设置 RPC 与 `toolkit_ping` 工具。
- TUI：`src/tui/index.tsx` 侧栏状态块 + `/my-opencode-toolkit` 设置菜单。
- 根入口：`index.ts` / `tui.ts` 转发到 `src/`（OpenCode 本地插件解析只找这两个名字）。
- 测试：22 个单测（设置解析、存储、key、i18n）。
- e2e：`scripts/e2e-load.mjs`，隔离 HOME/USERPROFILE/DB/config，假 provider 驱动工具调用，断言工具表、工具返回与默认设置落盘。

## 进行中

无。

## 待办

P1 Goal。
