// /loop 运行时（fixed 定时 + dynamic 自定速 + ScheduleWakeup + fallback）。
// 语义对齐 Claude Code（PLAN.md §0）：
// - fixed：立即 fire 一次，之后每 interval 重武装再 fire（同 prompt 重发取消旧 loop = 一 prompt 一 live loop）。
// - dynamic：立即 fire，模型回合结束调 ScheduleWakeup 决定下次 delay；不调则 20min fallback fire 一次后结束。
// - ScheduleWakeup delay 钳制 [60,3600]，唤醒时间向上取整到分钟。
// - inject 复用 goal 经验：同步 prompt + inFlight + 活动事件清 inFlight + lastMessageIsUser 防叠加。

import { randomUUID } from "node:crypto";
import { getSessionID } from "../notification/event-properties";
import { loadConfig } from "../config/load";
import { createTranslator, resolveLang } from "../i18n";
import type { SchedulingContext } from "./continuation";
import { DEFAULT_MAX_AGE_DAYS, type Loop } from "./types";

const LOOP_MARKER = "<!-- LOOP_AUTONOMOUS -->";
/** dynamic 无 ScheduleWakeup 时的兜底唤醒（对齐 Claude ~20 分钟）。 */
const FALLBACK_WAKEUP_MS = 20 * 60 * 1000;
const WAKEUP_MIN_S = 60;
const WAKEUP_MAX_S = 3600;

export type ScheduleWakeupResult =
  | { ok: true; id: string; fireAt: number }
  | { ok: false; error: string };

export interface SchedulingScheduler {
  /** 结构变更回调（供 TUI mirror 写入）。可外部赋值。 */
  onChanged: ((sessionID: string) => void) | undefined;
  /** 启动 loop：intervalSeconds 有值 = fixed，无值 = dynamic。立即 fire 一次。 */
  startLoop(sessionID: string, prompt: string, intervalSeconds?: number): Loop;
  /** 停止 loop：按 id 或（无 id 时）该会话任一 loop。 */
  stopLoop(sessionID: string, id?: string): boolean;
  /** 按 prompt 精确停止（ScheduleWakeup stop / /loop-stop 用）。 */
  stopLoopByPrompt(sessionID: string, prompt: string): boolean;
  /** 停止该会话全部 loop，返回停止数量。 */
  stopAllLoops(sessionID: string): number;
  listLoops(sessionID: string): Loop[];
  /** ScheduleWakeup：仅 dynamic loop 且 prompt 完全匹配时可用。 */
  scheduleWakeup(sessionID: string, prompt: string, delaySeconds: number, reason: string): ScheduleWakeupResult;
  /** 事件入口：活动事件清 inFlight；session.deleted 清理 loop。 */
  handleEvent(input: { event: { type: string; properties?: unknown } }): Promise<void>;
  clearSession(sessionID: string): void;
}

export function createSchedulingScheduler(args: {
  ctx: SchedulingContext;
  /** 返回 true 时本轮 loop fire 让路（如 goal active 优先），loop 保留下轮再试。 */
  shouldDeferFire?: (sessionID: string) => boolean | Promise<boolean>;
}): SchedulingScheduler {
  const { ctx, shouldDeferFire } = args;
  const loops = new Map<string, Loop>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlight = new Set<string>();
  const loadConfigFn = ctx.loadConfigOverride ?? loadConfig;
  let onChanged: ((sessionID: string) => void) | undefined;

  const findLoop = (sessionID: string, prompt: string): Loop | undefined =>
    [...loops.values()].find((loop) => loop.sessionID === sessionID && loop.prompt === prompt);

  async function lastMessageIsUser(sessionID: string): Promise<boolean> {
    const messages = await ctx.client.session.messages(sessionID).catch(() => undefined);
    if (!messages || messages.length === 0) return false;
    const last = messages.at(-1);
    return last?.info?.role === "user";
  }

  const inject = async (sessionID: string, text: string): Promise<boolean> => {
    if (inFlight.has(sessionID)) return false;
    // 上次注入还没被 AI 回复 → 跳过本次，防叠加。
    if (await lastMessageIsUser(sessionID)) return false;
    inFlight.add(sessionID);
    try {
      await ctx.client.session.prompt(sessionID, {
        parts: [{ type: "text", text, metadata: { loopContinuation: true } }],
      });
      return true;
    } catch {
      return false;
    } finally {
      inFlight.delete(sessionID);
    }
  };

  /** loop 注入成功后的多语言 toast。 */
  const showLoopInjectedToast = (): void => {
    const cfg = loadConfigFn();
    if (!cfg.enabled || !cfg.scheduling.enabled) return;
    const lang = resolveLang(cfg.lang, process.env);
    const t = createTranslator(lang);
    void ctx.client.tui?.showToast({
      title: t("schedulingCommand.title"),
      message: t("schedulingCommand.loopInjected"),
      variant: "info",
    }).catch(() => undefined);
  };

  const fireLoop = async (loop: Loop): Promise<void> => {
    // 优先级：goal active 时 loop 让路（goal > loop > todo），loop 保留等下次。
    if (shouldDeferFire !== undefined && (await shouldDeferFire(loop.sessionID))) {
      return;
    }
    loop.fires += 1;
    onChanged?.(loop.sessionID);
    const ok = await inject(loop.sessionID, `${loop.prompt}\n\n${LOOP_MARKER}`);
    if (ok) showLoopInjectedToast();
  };

  const armLoop = (loop: Loop, delayMs: number): void => {
    const existing = timers.get(loop.id);
    if (existing !== undefined) clearTimeout(existing);
    loop.nextFireAt = Date.now() + delayMs;
    onChanged?.(loop.sessionID);
    const handle = setTimeout(() => {
      timers.delete(loop.id);
      handleFire(loop);
    }, delayMs);
    handle.unref();
    timers.set(loop.id, handle);
  };

  /** timer 到点：fire 后按模式决定 next。 */
  const handleFire = (loop: Loop): void => {
    void (async () => {
      await fireLoop(loop);
      if (loop.mode === "fixed" && loop.intervalSeconds !== undefined) {
        armLoop(loop, loop.intervalSeconds * 1000);
        return;
      }
      // dynamic：wakeup fire（模型可能再 ScheduleWakeup）→ 等 fallback；fallback fire → 结束。
      if (loop.pendingWakeup !== undefined) {
        delete loop.pendingWakeup;
        armLoop(loop, FALLBACK_WAKEUP_MS);
      } else {
        stopLoop(loop.sessionID, loop.id);
      }
    })();
  };

  const startLoop = (sessionID: string, prompt: string, intervalSeconds?: number): Loop => {
    // 同 prompt 一个 live loop：重发取消旧的。
    const existing = findLoop(sessionID, prompt);
    if (existing !== undefined) stopLoop(sessionID, existing.id);

    const now = Date.now();
    const loop: Loop = {
      id: randomUUID().slice(0, 8),
      sessionID,
      prompt,
      mode: intervalSeconds === undefined ? "dynamic" : "fixed",
      ...(intervalSeconds !== undefined ? { intervalSeconds } : {}),
      createdAt: now,
      expiresAt: now + DEFAULT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000,
      fires: 0,
    };
    loops.set(loop.id, loop);
    void fireLoop(loop);
    if (loop.mode === "fixed" && loop.intervalSeconds !== undefined) {
      armLoop(loop, loop.intervalSeconds * 1000);
    } else {
      armLoop(loop, FALLBACK_WAKEUP_MS);
    }
    onChanged?.(sessionID);
    return loop;
  };

  const stopLoop = (sessionID: string, id?: string): boolean => {
    const target = id !== undefined ? loops.get(id) : [...loops.values()].find((loop) => loop.sessionID === sessionID);
    if (target === undefined || target.sessionID !== sessionID) return false;
    const timer = timers.get(target.id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(target.id);
    }
    loops.delete(target.id);
    onChanged?.(sessionID);
    return true;
  };

  const stopLoopByPrompt = (sessionID: string, prompt: string): boolean => {
    const loop = findLoop(sessionID, prompt);
    if (loop === undefined) return false;
    return stopLoop(sessionID, loop.id);
  };

  const stopAllLoops = (sessionID: string): number => {
    let count = 0;
    for (const loop of listLoops(sessionID)) {
      if (stopLoop(sessionID, loop.id)) count += 1;
    }
    return count;
  };

  const listLoops = (sessionID: string): Loop[] =>
    [...loops.values()].filter((loop) => loop.sessionID === sessionID);

  const scheduleWakeup = (
    sessionID: string,
    prompt: string,
    delaySeconds: number,
    reason: string,
  ): ScheduleWakeupResult => {
    const loop = findLoop(sessionID, prompt);
    if (loop === undefined || loop.mode !== "dynamic") {
      return {
        ok: false,
        error: "ScheduleWakeup is only available inside an active dynamic /loop for this session and prompt.",
      };
    }
    const clamped = Math.min(Math.max(Math.round(delaySeconds), WAKEUP_MIN_S), WAKEUP_MAX_S);
    const now = Date.now();
    // 唤醒时间向上取整到下一个分钟边界。
    const fireAt = Math.ceil((now + clamped * 1000) / 60000) * 60000;
    loop.pendingWakeup = { fireAt, delaySeconds: clamped, prompt, reason };
    armLoop(loop, Math.max(0, fireAt - now));
    onChanged?.(sessionID);
    return { ok: true, id: loop.id, fireAt };
  };

  const clearSession = (sessionID: string): void => {
    for (const loop of listLoops(sessionID)) stopLoop(sessionID, loop.id);
    inFlight.delete(sessionID);
  };

  const handleEvent = (input: { event: { type: string; properties?: unknown } }): Promise<void> => {
    const { event } = input;
    const props = event.properties as Record<string, unknown> | undefined;
    const sessionID = getSessionID(props);
    if (sessionID === undefined) return Promise.resolve();
    if (event.type === "session.deleted") {
      clearSession(sessionID);
      return Promise.resolve();
    }
    if (
      event.type === "message.updated" ||
      event.type === "message.part.updated" ||
      event.type === "message.part.delta" ||
      event.type === "tool.execute.before" ||
      event.type === "tool.execute.after"
    ) {
      inFlight.delete(sessionID);
    }
    return Promise.resolve();
  };

  return {
    get onChanged() {
      return onChanged;
    },
    set onChanged(fn: ((sessionID: string) => void) | undefined) {
      onChanged = fn;
    },
    startLoop,
    stopLoop,
    stopLoopByPrompt,
    stopAllLoops,
    listLoops,
    scheduleWakeup,
    handleEvent,
    clearSession,
  };
}
