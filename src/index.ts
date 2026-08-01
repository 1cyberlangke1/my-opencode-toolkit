import type { Plugin, PluginModule } from "@opencode-ai/plugin";

import { createSessionNotificationHook } from "./notification/session-notification-hook";

const server: Plugin = (input) => {
  const hook = createSessionNotificationHook(
    {
      client: {
        session: {
          get: (id) => input.client.session.get({ path: { id } }).then((r) => r.data),
          messages: (id) =>
            input.client.session
              .messages({ path: { id }, query: { directory: input.directory } })
              .then((r) => r.data as Array<{ info: import("@opencode-ai/sdk").Message; parts: Array<{ type: string; text?: string }> }> | undefined),
          todo: (id) => input.client.session.todo({ path: { id } }).then((r) => r.data),
        },
      },
    },
    process.platform,
  );

  const hooks = {
    event: (input: { event: { type: string; properties?: unknown } }): Promise<void> =>
      hook.event(input),
    dispose: (): Promise<void> => {
      hook.dispose();
      return Promise.resolve();
    },
  };
  return Promise.resolve(hooks);
};

const plugin: PluginModule = {
  id: "my-opencode-toolkit",
  server,
};

export default plugin;
