# Changelog

## 0.2.4

### 修复

- 注入后模型失败/被打断/直接 idle 时清理 `pending`，循环与定时任务不再永久卡死
- scheduling 关闭时循环暂停，重新开启后恢复
- scheduling 关闭时仍允许 `/loop stop`、`/cron list`、`/cron delete`
- goal 关闭时仍允许 `/goal clear`、`/goal show`
- 分页扫描在游标丢失或不前进时不再回退或死循环

### 测试与构建

- 通知发送改为可注入 runner，新增 Windows/macOS/Linux 参数与转义测试
- `pnpm check` 增加发布包内容校验（`npm pack` 清单）

## 0.2.3

### 修复

- 定时任务在功能关闭或目标进行中时不再被消费，改为顺延重试
- 一次性任务在会话忙或注入失败时保留并重试，不再静默丢失
- 已过点的任务在启动或空闲时补触发一次，而不是永远等待下一次空闲
- 重复任务算不出下一次触发时自动删除，避免过期的 `nextRunAt` 反复触发
- 长周期 cron（闰日、年抛）不再因 `setTimeout` 32 位溢出而立即误触发
- 循环间隔与唤醒延迟做上下限校验，避免 0/NaN 造成忙循环
- 完成通知预览跳过插件注入的续作消息，不再把系统提示当成用户原话
- goal 拒绝空目标与非法 token 预算；非有限增量不再污染记账
- cron 搜索窗口扩到四年，支持 `2 月 29 日`

### 文档

- README 重写：安装、命令、设置、触发语义、排障、开发
- 新增 CHANGELOG

## 0.2.2

- 通过 Trusted Publishing 发布，验证 OIDC 发布链
- 子代理统计改为按 `parentID` 分页
- 会话删除时清理 goal 与 scheduling 状态
- TUI keymap 移到 `setup` 作用域，新增 setup 测试

## 0.2.1

- 首次发布
- 系统通知、持久目标、cron/loop、TUI 侧栏与设置菜单
