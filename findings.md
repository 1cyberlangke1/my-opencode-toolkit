# 调查结论

## V2 插件 API（`@opencode/plugin` 2.1.2）

- 服务端入口：`Plugin.define({ id, setup(ctx) })`，`setup` 返回 cleanup。
- `ctx.storage`：`get / set / remove / scan`，值是 JSON；命名空间由插件 id 决定，全局一个库。
- `ctx.rpc.register(definition, handlers)` 返回 `{ dispose, events.emit }`。
- `ctx.tool.transform(editor => editor.add(tool))`，改完要 `ctx.tool.reload()`。
- `ctx.command.transform(editor => editor.add({ name, description, execute }))`。
- `ctx.event.subscribe(handler)` 返回退订函数。
- `ctx.options`：`Readonly<Record<string, any>>`，来自插件配置。
- `ctx.session.prompt(input)` 把消息真实放进对话流；`synthetic` 只显示 notice。

## TUI 插件（`@opencode/plugin/tui`）

- `Plugin.define({ id, setup(context) })`。
- `context.storage.store(key, { initial })`：TUI 自己的持久化状态，和 `ctx.storage` 不是同一份。
- `context.ui.slot({ append: "sidebar.content", render })` 返回注销函数。
- 侧栏槽位输入是 `{ sessionID }`。
- `context.keymap.layer(() => ({ commands: [{ id, slash: { name }, run }] }))` 注册 `/xxx` 命令。
- `context.client.rpc(definition)` 得到类型化 RPC 客户端。
- `context.ui.dialog.select / confirm / prompt / show` 弹窗。
- `context.theme` 提供颜色 token。

## 测试隔离

OpenCode 支持这些环境变量：

| 变量 | 作用 |
|---|---|
| `OPENCODE_DB=:memory:` | 内存数据库 |
| `OPENCODE_DB=<路径>` | 指定数据库文件 |
| `OPENCODE_TEST_HOME=<目录>` | 重定向 home、`.config/opencode`、`.local/share/opencode`、`os.tmpdir()` |
| `OPENCODE_CONFIG_CONTENT=<JSON>` | 内联配置，不读真实 `opencode.json` |
| `OPENCODE_CONFIG_DIR=<目录>` | 配置目录 |

结论：e2e 必须同时设置独立 HOME + 临时 DB + 内联配置，否则会连到日常使用的后台服务。

Windows 补充：只设 `HOME` 不够，`os.homedir()` 读 `USERPROFILE`，必须两个都指向临时目录，否则仍会读到 `C:\Users\<name>\.config\opencode\opencode.json`。

## 本地插件加载（实测）

- 本地插件目录解析走 `Host.resolve({ directory })`：依次找 `<dir>/server`、`<dir>/index`、`<dir>/tui`、`<dir>/rpc`，**不读 package.json 的 exports**。
  所以仓库根必须有 `index.ts` 与 `tui.ts` 两个转发入口，`exports` 只是给 npm 安装场景用的。
- `ctx.tool.transform` 注册工具后要 `ctx.tool.reload()`，否则当前会话的下一次请求看不到新工具。
- 工具没设 `options.codemode`（或设 true）时只进 Code Mode 目录，不在请求的 `tools` 数组里；
  `options: { codemode: false }` 才会作为顶层工具直接暴露。
- `GET /api/plugin` 对本地插件返回空数组，不能用它判断插件是否加载；看服务端日志 `msg="loading plugin"` 或工具表。
- 插件里的 `console.log` 不会进 `opencode serve --print-logs` 的日志；调试用文件标记。

## 旧仓库

- V1 依赖 `@opencode-ai/plugin`，导出 `./server` + `./tui`，用 tsc + esbuild 构建后复制到 `~/.config/opencode/plugins`。
- 通知已经是 OS 级（`execFile` 调 powershell / osascript / notify-send），不依赖 TUI，可移植。
- todo 续作与 yolo 不再需要。
