# my-opencode-toolkit

一个开源项目（OpenCode 插件）——在 OpenCode 中提供系统通知与待办自动续作等功能。

## 功能

### 系统通知（Windows toast / macOS 通知 / Linux notify-send）

- **任务完成通知**：会话变为空闲（`session.idle`）时通知
- **提问通知**：智能体向你提问时通知
- **权限通知**：智能体需要权限时通知
- 多语言（中/英），可单独开关

### 待办自动续作（todo auto-continue）

- 会话空闲但还有未完成的待办时，自动注入一条英文续作消息，要求智能体继续干活并塞入当前待办列表
- **防循环机制**（忠实复刻 omo 的 `todo-continuation-enforcer`）：
  - 2 秒倒计时 toast 后注入
  - 注入消息带 `<!-- TODO_CONTINUATION -->` 标记，可识别自己的注入
  - turn-boundary pause：用户消息 → 永久停；assistant 活动 → 取消倒计时
  - 停滞检测：待办无进展 → 停止续作
  - 冷却 / 指数退避 / maxInjections 硬上限
- 注入前解析当前会话 agent
- 多语言 toast，剩余待办数正确显示

### 侧边栏统计面板

- 缓存命中率、工具使用统计、子代理追踪
- 可折叠、可配置显示项

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
    "message": "> **[SYSTEM] Todo continuation**\n>\n> Incomplete tasks remain in your todo list. Continue working on the next pending task.\n>\n> Remaining tasks:\n> {todos}"
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

在 opencode TUI 中输入 `/mot` 可打开配置菜单（待办自动续作、通知、侧边栏等），`/mot-status` 查看当前状态。

## 架构

```
src/
├── index.ts                     # server 插件入口：接入 opencode event hook
├── tui.tsx                      # TUI 插件：侧边栏 + /mot 菜单
├── config/
│   ├── types.ts                 # 配置类型与默认值
│   ├── load.ts                  # 读取/解析全局配置 JSON
│   └── store.ts                 # TUI 端配置读写（原子写 + subscribe）
├── i18n/
│   ├── en.ts / zh.ts            # 翻译表
│   └── index.ts                 # createTranslator / resolveLang
├── notification/
│   ├── event.ts                 # 事件分发：session.status idle → session.idle 归一化
│   ├── session-notification.ts  # 完成/提问/权限通知
│   ├── todo-reminder.ts         # 待办自动续作：门控链 + 倒计时 + 注入 + turn-boundary pause
│   ├── todo-reminder-state.ts   # 会话状态存储（停滞检测等）
│   └── ...                      # sender / send / content / event-properties 等
└── sidebar/                     # TUI 侧边栏统计面板
```

## 参考项目

本项目的设计参考了以下优秀的开源项目，特此致谢：

- [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) —— 待办续作机制（`todo-continuation-enforcer`）的 turn-boundary pause、停滞检测、冷却退避等防循环逻辑，以及通知模块的分层设计
- [opencode-subagent-magazine](https://github.com/Hotakus/opencode-subagent-magazine) —— TUI 侧边栏可视化（子代理监控）、自适应主题色与低饱和设计语言、中英双语、数据持久化的参考

## License

MIT License，Copyright (c) 2026 1cyberlangke1

See [LICENSE](LICENSE) for details.
