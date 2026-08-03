import type { Plugin, PluginModule, ToolDefinition } from "@opencode-ai/plugin";

import { loadConfig } from "./config/load";
import { createTranslator, resolveLang } from "./i18n";
import { createGoalContinuation } from "./goal/continuation";
import { createGoalController } from "./goal/controller";
import { createGoalTools } from "./goal/tools";
import { parseGoalCommand } from "./goal/parse-command";
import { createEventHandler } from "./notification/event";
import { createSessionNotification } from "./notification/session-notification";
import { createTodoReminder } from "./notification/todo-reminder";
import { loadLoopMaintenancePrompt, parseLoopCommand } from "./scheduling/command";
import { createSchedulingContinuation, resolveSessionAgent } from "./scheduling/continuation";
import { clearSchedulingMirrors, createSchedulingMirror } from "./scheduling/mirror";
import { createSchedulingScheduler } from "./scheduling/scheduler";
import { createSchedulingStore } from "./scheduling/store";
import { createSchedulingTools } from "./scheduling/tools";

const server: Plugin = (input) => {
  void input.client.app.log({
    body: { service: "my-opencode-toolkit", level: "info", message: "Plugin initialized" },
  });

  const ctx = {
    client: {
      session: {
        get: (id: string) => input.client.session.get({ path: { id } }).then((r) => r.data),
        messages: (id: string) =>
          input.client.session
            .messages({ path: { id }, query: { directory: input.directory } })
            .then((r) => r.data),
        todo: (id: string) => input.client.session.todo({ path: { id } }).then((r) => r.data),
        prompt: (
          id: string,
          body: {
            agent?: string;
            parts: Array<{ type: "text"; text: string; metadata?: Record<string, unknown> }>;
          },
        ) => input.client.session.prompt({ path: { id }, body }).then((r) => r.data),
      },
      tui: {
        showToast: (body: {
          title?: string;
          message: string;
          variant: "info" | "success" | "warning" | "error";
          duration?: number;
        }) => input.client.tui.showToast({ body }).then((r) => r.data),
      },
    },
  };

  const sessionNotification = createSessionNotification(ctx);
  const todoReminder = createTodoReminder(ctx);

  const goalController = createGoalController({ projectDir: input.directory });
  const goalContinuation = createGoalContinuation({
    controller: goalController,
    ctx,
  });

  const schedulingStore = createSchedulingStore(input.directory);
  void schedulingStore.load();
  // cron/loop 注入让路：goal active 优先；plan 模式不触发（对齐 goal/todo 续作）。
  const shouldDeferFire = async (sessionID: string): Promise<boolean> => {
    const goal = goalController.getGoal(sessionID);
    if (goal !== null && goal.status === "active") return true;
    const agent = await resolveSessionAgent(ctx, sessionID);
    return agent === "plan";
  };
  const schedulingContinuation = createSchedulingContinuation({
    store: schedulingStore,
    ctx,
    shouldDeferFire,
  });
  const schedulingScheduler = createSchedulingScheduler({
    ctx,
    shouldDeferFire,
  });
  const schedulingMirror = createSchedulingMirror(input.directory, schedulingStore, schedulingScheduler);
  // 重启后内存态任务（loop/session job）丢失，清空残留快照避免侧边栏显示幽灵任务。
  clearSchedulingMirrors(input.directory);
  schedulingStore.onChanged = (sessionID) => {
    schedulingMirror.write(sessionID);
    schedulingContinuation.armTimers();
  };
  schedulingScheduler.onChanged = (sessionID) => {
    schedulingMirror.write(sessionID);
  };

  const isSubagent = async (sessionID: string): Promise<boolean> => {
    const session = await input.client.session
      .get({ path: { id: sessionID } })
      .then((r) => r.data)
      .catch(() => undefined);
    return typeof session?.parentID === "string" && session.parentID.length > 0;
  };

  const event = createEventHandler({
    ctx,
    sessionNotification,
    todoReminder,
    goal: goalContinuation,
    scheduling: schedulingContinuation,
    hasActiveGoal: (sessionID) => {
      const goal = goalController.getGoal(sessionID);
      return goal !== null && goal.status === "active";
    },
  });

  const config = loadConfig();

  /** Apply a parsed /goal command directly to the controller; returns a feedback message. */
  const applyGoalCommand = (sessionID: string, arguments_: string): string => {
    const lang = resolveLang(config.lang, process.env);
    const t = createTranslator(lang);
    const parsed = parseGoalCommand(arguments_);
    switch (parsed.kind) {
      case "set": {
        goalController.setGoal(sessionID, parsed.objective);
        return t("goalCommand.set").replace("{objective}", parsed.objective);
      }
      case "pause": {
        goalController.pauseGoal(sessionID);
        return t("goalCommand.paused");
      }
      case "resume": {
        goalController.resumeGoal(sessionID);
        return t("goalCommand.resumed");
      }
      case "clear": {
        goalController.clearGoal(sessionID);
        return t("goalCommand.cleared");
      }
      case "edit": {
        const goal = goalController.getGoal(sessionID);
        if (goal === null) {
          return `${t("goalCommand.usage")}\n${t("goalCommand.example")}`;
        }
        return `${t("goalCommand.editPrompt").replace("{objective}", goal.objective)}\n${t("goalCommand.usage")}`;
      }
      case "show": {
        const goal = goalController.getGoal(sessionID);
        if (goal === null) return t("goalCommand.showNone");
        return t("goalCommand.show")
          .replace("{status}", goal.status)
          .replace("{objective}", goal.objective);
      }
    }
  };

  const hooks: Record<string, unknown> = {
    event,
    config: (cfg: { command?: Record<string, unknown> }) => {
      const lang = resolveLang(config.lang, process.env);
      const t = createTranslator(lang);
      if (config.goal.enabled) {
        cfg.command = {
          ...cfg.command,
          goal: {
            description: t("goalCommand.description"),
            template:
              "The /goal command is handled by the plugin; verify the current goal state and continue.",
          },
        };
      }
      if (config.scheduling.enabled) {
        cfg.command = {
          ...cfg.command,
          loop: {
            description: t("schedulingCommand.loop.desc"),
            template:
              "The /loop command is handled by the plugin; repeat the requested prompt on a loop.",
          },
          "loop-stop": {
            description: t("schedulingCommand.loopStop.desc"),
            template: "The /loop-stop command is handled by the plugin; stop all loops.",
          },
        };
      }
    },
    "command.execute.before": async (
      input_: { command: string; sessionID: string; arguments: string },
      output: { parts: Array<Record<string, unknown>> },
    ) => {
      const lang = resolveLang(config.lang, process.env);
      const t = createTranslator(lang);

      if (input_.command === "goal" && config.goal.enabled) {
        if (!input_.sessionID) return;
        const message = applyGoalCommand(input_.sessionID, input_.arguments);
        await ctx.client.tui.showToast({
          title: t("goalCommand.title"),
          message,
          variant: "info",
        });
        output.parts.length = 0;
        output.parts.push({ type: "text", text: message, synthetic: true });
        return;
      }

      if (input_.command === "loop" && config.scheduling.enabled) {
        if (!input_.sessionID) return;
        const parsed = parseLoopCommand(input_.arguments);
        let message: string;
        if (parsed.kind === "invalid") {
          message = parsed.reason;
        } else {
          const prompt =
            parsed.prompt.length > 0 ? parsed.prompt : loadLoopMaintenancePrompt(input.directory);
          schedulingScheduler.startLoop(input_.sessionID, prompt, parsed.intervalSeconds);
          message = t("schedulingCommand.loopStart")
            .replace("{prompt}", prompt)
            .replace("{mode}", parsed.intervalSeconds !== undefined ? `${parsed.intervalSeconds}s` : "dynamic");
        }
        await ctx.client.tui.showToast({
          title: t("schedulingCommand.loop.desc"),
          message,
          variant: "info",
        });
        output.parts.length = 0;
        output.parts.push({ type: "text", text: message, synthetic: true });
        return;
      }

      if (input_.command === "loop-stop" && config.scheduling.enabled) {
        if (!input_.sessionID) return;
        const stopped = schedulingScheduler.stopAllLoops(input_.sessionID);
        const message = stopped > 0 ? t("schedulingCommand.loopStopDone") : t("schedulingCommand.loopStopNone");
        await ctx.client.tui.showToast({
          title: t("schedulingCommand.loopStop.desc"),
          message,
          variant: "info",
        });
        output.parts.length = 0;
        output.parts.push({ type: "text", text: message, synthetic: true });
        return;
      }
    },
  };
  const tools: Record<string, ToolDefinition> = {};
  if (config.goal.enabled) {
    Object.assign(tools, createGoalTools({ controller: goalController, getSessionID: () => undefined, isSubagent }));
  }
  if (config.scheduling.enabled) {
    Object.assign(
      tools,
      createSchedulingTools({
        store: schedulingStore,
        scheduler: schedulingScheduler,
        getSessionID: () => undefined,
        isSubagent,
      }),
    );
  }
  if (Object.keys(tools).length > 0) {
    hooks.tool = tools;
  }
  return Promise.resolve(hooks);
};

const plugin: PluginModule = {
  id: "my-opencode-toolkit",
  server,
};

export default plugin;
