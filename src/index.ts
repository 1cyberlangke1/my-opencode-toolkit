import type { Plugin, PluginModule } from "@opencode-ai/plugin";

import { loadConfig } from "./config/load";
import { createGoalContinuation } from "./goal/continuation";
import { createGoalController } from "./goal/controller";
import { createGoalTools } from "./goal/tools";
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
  const hooks: Record<string, unknown> = {
    event,
  };
  if (config.goal.enabled) {
    hooks.tool = createGoalTools({
      controller: goalController,
      getSessionID: () => undefined,
    });
  }
  return Promise.resolve(hooks);
};

const plugin: PluginModule = {
  id: "my-opencode-toolkit",
  server,
};

export default plugin;
