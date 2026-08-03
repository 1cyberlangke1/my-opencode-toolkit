# my-opencode-toolkit

一个开源项目（OpenCode 插件）——在 OpenCode 中提供系统通知、待办自动续作、持久化会话目标（Goal）、定时任务与循环（cron/loop）等功能。

## 功能

### 系统通知（Windows toast / macOS 通知 / Linux notify-send）

- **任务完成通知**：会话变为空闲（`session.idle`）时通知
- **提问通知**：智能体向你提问时通知
- **权限通知**：智能体需要权限时通知
- 通知内容自动截断（避免 Windows toast「内容过大」），多语言（中/英），可单独开关

### 待办自动续作（todo auto-continue）

- 会话空闲但还有未完成的待办时，倒计时 toast 后自动注入一条续作消息，要求智能体继续干活并塞入当前待办列表
- 倒计时秒数可配置（`todoReminder.countdownSeconds`，默认 5），toast 动态递减
- 注入消息带 `<!-- TODO_CONTINUATION -->` 标记，可识别自己的注入
- `maxInjections` 硬上限（待办有进展时重置），防止无限循环
- **Plan 模式（agent=plan）不注入续作**
- 用户打断后活动事件会重置 `wasCancelled`，恢复提醒
- 多语言 toast，剩余待办数正确显示

### 持久化会话目标（Goal）

- **工具**：`create_goal` / `get_goal` / `update_goal`（goal 工具对子代理不可用）
- **命令**：`/goal <objective>` 设置目标、`/goal pause|resume|clear|edit` 控制、裸 `/goal` 显示当前目标（对齐 codex，直接改状态不经 LLM）
- **续作**：goal active 时会话空闲自动注入续作消息（每次注入一条，末条是 user 时防重复）；Plan 模式不注入
- **记账**：自动累计 token 消耗与工作时间（暂停期间不记录；token 按速率实时外推显示）
- **打断自动暂停**：用户打断 AI 时 goal 自动变 paused（弹 toast 提示）
- 目标文件持久化在 `{projectDir}/.opencode-toolkit/goal/`

### 定时任务与循环（Scheduled Tasks & Loop）

- **定时任务（cron）**：`cron_create` / `cron_list` / `cron_delete` 工具，5 字段 cron 表达式（如 `*/5 * * * *` = 每 5 分钟、`0 9 * * 1-5` = 工作日 9 点）定时注入提示
  - durable 可持久化（重启恢复）、每会话 50 上限、7 天自动过期
  - 到点用 timer 主动触发（不依赖 idle 事件，静止会话也会 fire）；到点先无条件重排 nextRunAt（倒计时不卡 0）
  - 注入带 `<!-- CRON_AUTONOMOUS -->` 哨兵 + 多语言 toast（消息发送即弹）
- **循环（loop）**：`/loop <prompt>` 命令，两种模式
  - **固定间隔**：`/loop 5m <prompt>` 每 5 分钟注入一次
  - **动态/自定速**：`/loop <prompt>`（省略间隔），模型每轮用 `schedule_wakeup` 决定下次唤醒（60~3600s 钳制，到分钟边界）
  - `/loop-stop` 停止；模型也可 `schedule_wakeup(stop: true)` 自停
  - 注入带 `<!-- LOOP_AUTONOMOUS -->` 哨兵 + 多语言 toast
- **协调优先级**：goal active > loop > todo，一个触发只注入一条；**Plan 模式（agent=plan）不注入**（cron/loop 让路但到点仍重排）
- **侧边栏 Scheduled 面板**：实时显示定时任务/循环 + 触发倒计时递减（无任务时隐藏）
- **重启清理**：重启后内存态任务（loop/session 任务）自动丢失并清空镜像，不残留幽灵任务

### 侧边栏统计面板

- **Goal 面板**（独立，与会话统计同级别）：显示目标、状态（active 绿色呼吸）、token 消耗（紧凑 K/M 格式）、实时时间（秒级）；无目标时不显示
- **Scheduled 面板**：显示定时任务（⏰ [cron]）与循环（🔁 [loop]），标注类型 + 触发倒计时实时递减；无任务时不显示
- **会话统计面板**：缓存命中率、工具使用统计、子代理追踪，可折叠、可配置显示项

## 安装

### 构建与部署

```bash
npm install
npm run typecheck   # 类型检查
npm run lint        # 代码规范
npm run deploy      # 打包并复制到全局插件目录
```

部署目标（Windows）：

- Server 插件：`%USERPROFILE%\.config\opencode\plugins\my-opencode-toolkit.js`
- TUI 插件：`%USERPROFILE%\.config\opencode\toolkit\tui.js`

**部署后需要重启 opencode 才会加载新插件。**

### 启用插件

在 opencode 配置（`~/.config/opencode/opencode.json`）的 `plugin` 数组中加入：

```jsonc
{
  "plugin": [".config/opencode/plugins/my-opencode-toolkit.js"]
}
```

## 配置

全局配置文件：`%USERPROFILE%\.config\opencode\my-opencode-toolkit.json`

```jsonc
{
  "lang": "auto",            // auto / zh / en
  "enabled": true,           // 插件总开关
  "notification": {
    "enabled": true,
    "onComplete": true,      // 任务完成通知
    "onQuestion": true,      // 提问通知
    "onPermission": true,    // 权限通知
    "skipIfIncompleteTodos": true,   // 有待办未完成时跳过完成通知
    "onlyMainSession": true  // 只通知主会话
  },
  "todoReminder": {
    "enabled": true,
    "onlyMainSession": true, // 只对主会话注入续作
    "maxInjections": 3,      // 每会话最大注入次数（待办有进展时重置）
    "countdownSeconds": 5,   // 注入前倒计时秒数（toast 动态递减）
    "message": "> **[SYSTEM] Todo continuation**\n>\n> Incomplete tasks remain in your todo list. Continue working on the next pending task.\n>\n> Remaining tasks:\n> {todos}"
  },
  "goal": {
    "enabled": true          // goal 功能总开关（关闭后 goal 工具不注册）
  },
  "scheduling": {
    "enabled": true          // 定时任务/循环总开关（关闭后 cron/loop 工具与命令不可用）
  },
  "sidebar": {
    "enabled": true,
    "showCache": true,
    "showTools": false,
    "showSubagents": false,
    "collapsed": false
  }
}
```

配置支持**实时更新**——修改后无需重启，下次事件即生效。

### TUI 菜单

在 opencode TUI 中输入 `/mot` 可打开配置菜单（定时任务、goal、待办续作、通知、会话统计等），`/mot-status` 查看当前状态。

## 架构

```
src/
├── index.ts                     # server 插件入口：event hook + config/command hook（/goal /loop）+ 工具注册
├── tui.tsx                      # TUI 插件：侧边栏 + /mot 菜单
├── config/
│   ├── types.ts                 # 配置类型与默认值
│   ├── load.ts                  # 读取/解析全局配置 JSON
│   └── store.ts                 # TUI 端配置读写（原子写 + subscribe）
├── i18n/
│   ├── en.ts / zh.ts            # 翻译表
│   └── index.ts                 # createTranslator / resolveLang
├── notification/
│   ├── event.ts                 # 事件分发：session.status idle → session.idle 归一化；goal > cron/loop > todo 协调
│   ├── session-notification.ts  # 完成/提问/权限通知
│   ├── todo-reminder.ts         # 待办自动续作：门控链 + 倒计时 + 注入 + plan 特判
│   ├── todo-reminder-state.ts   # 会话状态存储
│   └── ...                      # sender / send / content / event-properties 等
├── goal/                        # 持久化会话目标
│   ├── accounting.ts            # token/时间记账
│   ├── continuation.ts          # idle 续作注入 + 防重复 + 打断/没钱自动暂停
│   ├── controller.ts            # CRUD + TUI mirror
│   ├── tools.ts                 # create_goal / get_goal / update_goal（子代理禁用）
│   ├── parse-command.ts         # /goal 命令参数解析（对齐 codex）
│   ├── prompts.ts               # 续作提示词（对齐 omo）
│   └── ...                      # store / types / error 等
├── scheduling/                  # 定时任务与循环（cron/loop）
│   ├── cron.ts                  # 5 字段 cron 解析 + next-run + jitter + i18n 描述
│   ├── store.ts                 # 定时任务存储（durable 写盘/恢复/7 天过期/50 上限）
│   ├── continuation.ts          # cron 到点 timer 触发 + 注入（toast/plan 特判/防叠加）
│   ├── scheduler.ts             # loop 运行时（fixed/dynamic + schedule_wakeup + fallback）
│   ├── tools.ts                 # cron_create / cron_list / cron_delete / schedule_wakeup
│   ├── command.ts               # /loop 命令解析
│   ├── mirror.ts                # TUI 镜像（侧边栏 Scheduled 面板）
│   └── types.ts                 # ScheduledJob / Loop / Wakeup
└── sidebar/                     # TUI 侧边栏（Goal 面板 + Scheduled 面板 + 会话统计面板）
```

## 参考项目

本项目的设计参考了以下优秀的开源项目，特此致谢：

- [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) —— 待办续作与 Goal 续作的参考（防重复注入、pending 检查、记账思路）
- [codex](https://github.com/anomalyco/opencode) —— Goal 功能设计来源（`/goal` 命令、完成审计、续作提示词）
- [opencode-subagent-magazine](https://github.com/Hotakus/opencode-subagent-magazine) —— TUI 侧边栏可视化（子代理监控）、自适应主题色与低饱和设计语言、中英双语、数据持久化的参考

## License

MIT License，Copyright (c) 2026 1cyberlangke1

See [LICENSE](LICENSE) for details.
