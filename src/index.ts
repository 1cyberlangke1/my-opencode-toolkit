import type { Plugin, PluginModule } from "@opencode-ai/plugin";

import { createEventHandler } from "./notification/event";
import { createSessionNotification } from "./notification/session-notification";

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
      },
    },
  };

  const sessionNotification = createSessionNotification(ctx);

  const event = createEventHandler({
    ctx,
    sessionNotification,
  });

  const hooks = {
    event,
  };
  return Promise.resolve(hooks);
};

const plugin: PluginModule = {
  id: "my-opencode-toolkit",
  server,
};

export default plugin;
