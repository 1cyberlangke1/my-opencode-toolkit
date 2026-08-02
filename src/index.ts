import type { Plugin, PluginModule } from "@opencode-ai/plugin";

import { loadConfig } from "./config/load";
import { createTranslator, resolveLang } from "./i18n";
import { createGoalContinuation } from "./goal/continuation";
import { createGoalController } from "./goal/controller";
import { createGoalTools } from "./goal/tools";
import { parseGoalCommand } from "./goal/parse-command";
import { createEventHandler } from "./notification/event";
import { createSessionNotification } from "./notification/session-notification";
import { createTodoReminder } from "./notification/todo-reminder";

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

  const event = createEventHandler({
    ctx,
    sessionNotification,
    todoReminder,
    goal: goalContinuation,
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
      if (config.goal.enabled) {
        const lang = resolveLang(config.lang, process.env);
        const t = createTranslator(lang);
        cfg.command = {
          ...cfg.command,
          goal: {
            description: t("goalCommand.description"),
            template:
              "The /goal command is handled by the plugin; verify the current goal state and continue.",
          },
        };
      }
    },
    "command.execute.before": async (
      input_: { command: string; sessionID: string; arguments: string },
      output: { parts: Array<Record<string, unknown>> },
    ) => {
      if (input_.command !== "goal" || !config.goal.enabled) return;
      if (!input_.sessionID) return;
      const message = applyGoalCommand(input_.sessionID, input_.arguments);
      const lang = resolveLang(config.lang, process.env);
      const t = createTranslator(lang);
      await ctx.client.tui.showToast({
        title: t("goalCommand.title"),
        message,
        variant: "info",
      });
      output.parts.length = 0;
      output.parts.push({ type: "text", text: message, synthetic: true });
    },
  };
  if (config.goal.enabled) {
    hooks.tool = createGoalTools({
      controller: goalController,
      getSessionID: () => undefined,
      isSubagent: async (sessionID) => {
        const session = await input.client.session
          .get({ path: { id: sessionID } })
          .then((r) => r.data)
          .catch(() => undefined);
        return typeof session?.parentID === "string" && session.parentID.length > 0;
      },
    });
  }
  return Promise.resolve(hooks);
};

const plugin: PluginModule = {
  id: "my-opencode-toolkit",
  server,
};

export default plugin;
