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

## V2 会话事件（goal 用到的）

| 事件 | 载荷 | 用途 |
|---|---|---|
| `session.step.ended` | `sessionID`、`tokens{input,output,reasoning,cache{read,write}}` | 记账 |
| `session.idle` | `sessionID` | 注入续作 |
| `session.execution.failed` | `sessionID`、`error{type,message,status?}` | 余额/超长分类 |
| `session.execution.interrupted` | `sessionID`、`reason`（`user`/`shutdown`/`superseded`/`inactivity`） | 用户打断暂停 |
| `session.deleted` | `sessionID` | 清运行期状态 |

- V2 没有 `session.error`；用 `session.execution.failed` 代替。
- `SessionDomain` 不暴露读取消息列表的方法，只能靠事件记账；不要再照搬 V1 的 `client.session.messages()`。
- `/goal` 这类命令要自己把反馈通过 `ctx.session.prompt` 发进对话流，`execute` 返回 `void` 不会自动发消息。
- `Session.Info.parentID` 可用来识别子代理会话。
- 子代理策略（goal 已实现，cron/loop 同样适用）：
  - 工具不进子代理：`context` 钩子里从 `event.tools` 删除，模型请求里根本看不到；
  - 续作/定时注入不进子代理：`session.idle` 时先查 `parentID`，是子代理就直接返回。

## 定时任务（P2 实测）

- 任务存 `schedule:<sessionID>`，一个 key 放该会话全部 durable 任务；非 durable 只留内存。
- 重启恢复：`setup` 里 `store.load()` 扫 `schedule:` 前缀，重建 `nextRunAt`，再 `armTimers()`。
- 定时器是 `setTimeout` + `unref()`；到点先无条件重排/删除，再尝试注入，注入失败不影响倒计时。
- 除 timer 外还有 `session.idle` 兜底：查该会话已到点任务，没有就补武装 timer。
- 注入规则与 goal 一致：子代理跳过、goal active 时让路、上一条注入未完成（没有 step）时跳过。
- `/loop` 是内存态（不持久化），fixed 按间隔重复，dynamic 等 `schedule_wakeup`，20 分钟没唤醒就结束。
- `/cron` 建的任务默认 durable；命令与工具都通过 `ctx.session.prompt` 把反馈发回会话。

## 通知（P3 实测）

- 权限请求事件是 `permission.asked`（载荷含 `sessionID`）；V2 没有 `permission.ask/updated`。
- 提问用 `ctx.tool.hook("execute.before")` 判断工具名 `question`。
- 消息可以读：`ctx.session.context({ sessionID })` 返回 `SessionMessageInfo[]`（user 有 `text`，assistant 有 `content[]` + `tokens`）。
  通知预览、续作的「末条是否真实用户输入」都靠它。
- 注入消息用 `session.prompt({ ..., metadata: { goalContinuation: true } })` 打标，读回时 `message.metadata` 可识别。
- 统计不落盘：首次打开面板用 `session.context` + `session.list` 重建，之后事件增量。
- 发送是 OS 级：Windows PowerShell toast、macOS osascript、Linux notify-send；命令存在性探测结果缓存。
- `onlyMainSession` 用 `parentID` 判断子代理，等价于旧版的主会话过滤。

## TUI（P4 实测）

- 面板数据走 RPC `panelGet`，服务端从 goal 存储、scheduling 存储与内存统计组装。
- TUI 用 `context.data.listen` 订阅 `session.idle` / `session.step.ended` / `session.usage.updated`，300ms 节流后重拉；
  没有 `session.updated` 与 `message.updated`（当前事件联合类型里没有）。
- 统计只在内存里，进程重启归零；`hitRate` 向下截断两位小数。
- TUI 测试：`tui-test/bunfig.toml` preload `@opentui/solid/preload`，`testRender` + `waitForFrame`；
  `test:tui` 必须在 `tui-test` 目录下跑，否则找不到 preload。

## 旧仓库

- V1 依赖 `@opencode-ai/plugin`，导出 `./server` + `./tui`，用 tsc + esbuild 构建后复制到 `~/.config/opencode/plugins`。
- 通知已经是 OS 级（`execFile` 调 powershell / osascript / notify-send），不依赖 TUI，可移植。
- todo 续作与 yolo 不再需要。
