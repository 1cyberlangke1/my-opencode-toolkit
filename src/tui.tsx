/** @jsxImportSource @opentui/solid */

import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";

import { createConfigStore, type ConfigStore } from "./config/store";
import type { ToolkitConfig } from "./config/types";
import { createTranslator, resolveLang, type Lang, type Translator } from "./i18n";
import { createSidebarSlot } from "./sidebar";

const ID = "my-opencode-toolkit";

// ---------------------------------------------------------------------------
// Menu model
// ---------------------------------------------------------------------------

type MenuAction =
  | { kind: "submenu"; items: MenuItem[] }
  | { kind: "bool"; get: () => boolean; apply: (value: boolean) => void }
  | { kind: "lang" }
  | { kind: "delay" };

interface MenuItem {
  key: string;
  title: string;
  description?: () => string;
  action: MenuAction;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function translatorFor(config: ToolkitConfig): Translator {
  return createTranslator(resolveLang(config.lang, process.env));
}

function showStatus(api: TuiPluginApi, config: ToolkitConfig, t: Translator): void {
  const n = config.notification;
  const onOff = (v: boolean): string => (v ? t("misc.on") : t("misc.off"));
  const lines = [
    `${t("status.plugin")}: ${onOff(config.enabled)}`,
    `${t("status.lang")}: ${config.lang}`,
    `${t("status.notification")}: ${onOff(n.enabled)}`,
    `${t("status.complete")}: ${onOff(n.onComplete)}`,
    `${t("status.question")}: ${onOff(n.onQuestion)}`,
    `${t("status.permission")}: ${onOff(n.onPermission)}`,
    `${t("status.sound")}: ${onOff(n.playSound)}`,
    `${t("status.todos")}: ${onOff(n.skipIfIncompleteTodos)}`,
    `${t("status.mainonly")}: ${onOff(n.onlyMainSession)}`,
    `${t("status.delay")}: ${n.idleConfirmationDelay}ms`,
  ];
  api.ui.toast({ message: lines.join("\n"), duration: 6000 });
}

// ---------------------------------------------------------------------------
// Menu builder
// ---------------------------------------------------------------------------

function buildMenu(t: Translator, store: ConfigStore): MenuItem[] {
  const onOff = (v: boolean): string => (v ? t("misc.on") : t("misc.off"));

  const notificationItems: MenuItem[] = [
    {
      key: "notify",
      title: t("config.notify"),
      description: () => onOff(store.get().notification.enabled),
      action: {
        kind: "bool",
        get: () => store.get().notification.enabled,
        apply: (v) => store.updateNotification({ enabled: v }),
      },
    },
    {
      key: "complete",
      title: t("config.complete"),
      description: () => onOff(store.get().notification.onComplete),
      action: {
        kind: "bool",
        get: () => store.get().notification.onComplete,
        apply: (v) => store.updateNotification({ onComplete: v }),
      },
    },
    {
      key: "question",
      title: t("config.question"),
      description: () => onOff(store.get().notification.onQuestion),
      action: {
        kind: "bool",
        get: () => store.get().notification.onQuestion,
        apply: (v) => store.updateNotification({ onQuestion: v }),
      },
    },
    {
      key: "permission",
      title: t("config.permission"),
      description: () => onOff(store.get().notification.onPermission),
      action: {
        kind: "bool",
        get: () => store.get().notification.onPermission,
        apply: (v) => store.updateNotification({ onPermission: v }),
      },
    },
    {
      key: "sound",
      title: t("config.sound"),
      description: () => onOff(store.get().notification.playSound),
      action: {
        kind: "bool",
        get: () => store.get().notification.playSound,
        apply: (v) => store.updateNotification({ playSound: v }),
      },
    },
    {
      key: "todos",
      title: t("config.todos"),
      description: () => onOff(store.get().notification.skipIfIncompleteTodos),
      action: {
        kind: "bool",
        get: () => store.get().notification.skipIfIncompleteTodos,
        apply: (v) => store.updateNotification({ skipIfIncompleteTodos: v }),
      },
    },
    {
      key: "mainonly",
      title: t("config.mainonly"),
      description: () => onOff(store.get().notification.onlyMainSession),
      action: {
        kind: "bool",
        get: () => store.get().notification.onlyMainSession,
        apply: (v) => store.updateNotification({ onlyMainSession: v }),
      },
    },
    {
      key: "delay",
      title: t("config.delay"),
      description: () => `${store.get().notification.idleConfirmationDelay}ms`,
      action: { kind: "delay" },
    },
  ];

  const sidebarItems: MenuItem[] = [
    {
      key: "sidebar",
      title: t("config.sidebar"),
      description: () => onOff(store.get().sidebar.enabled),
      action: {
        kind: "bool",
        get: () => store.get().sidebar.enabled,
        apply: (v) => store.updateSidebar({ enabled: v }),
      },
    },
    {
      key: "sidebarCache",
      title: t("config.sidebarCache"),
      description: () => onOff(store.get().sidebar.showCache),
      action: {
        kind: "bool",
        get: () => store.get().sidebar.showCache,
        apply: (v) => store.updateSidebar({ showCache: v }),
      },
    },
    {
      key: "sidebarTools",
      title: t("config.sidebarTools"),
      description: () => onOff(store.get().sidebar.showTools),
      action: {
        kind: "bool",
        get: () => store.get().sidebar.showTools,
        apply: (v) => store.updateSidebar({ showTools: v }),
      },
    },
    {
      key: "sidebarSubagents",
      title: t("config.sidebarSubagents"),
      description: () => onOff(store.get().sidebar.showSubagents),
      action: {
        kind: "bool",
        get: () => store.get().sidebar.showSubagents,
        apply: (v) => store.updateSidebar({ showSubagents: v }),
      },
    },
    {
      key: "sidebarCollapsed",
      title: t("config.sidebarCollapsed"),
      description: () => onOff(store.get().sidebar.collapsed),
      action: {
        kind: "bool",
        get: () => store.get().sidebar.collapsed,
        apply: (v) => store.updateSidebar({ collapsed: v }),
      },
    },
  ];

  return [
    {
      key: "lang",
      title: t("config.lang"),
      description: () => store.get().lang,
      action: { kind: "lang" },
    },
    {
      key: "toggle",
      title: t("config.toggle"),
      description: () => onOff(store.get().enabled),
      action: {
        kind: "bool",
        get: () => store.get().enabled,
        apply: (v) => store.update({ enabled: v }),
      },
    },
    {
      key: "notificationGroup",
      title: t("config.notificationGroup"),
      action: { kind: "submenu", items: notificationItems },
    },
    {
      key: "sidebarGroup",
      title: t("config.sidebarGroup"),
      action: { kind: "submenu", items: sidebarItems },
    },
  ];
}

// ---------------------------------------------------------------------------
// Menu navigation (arbitrary depth via a stack of items arrays)
// ---------------------------------------------------------------------------

interface MenuNav {
  api: TuiPluginApi;
  store: ConfigStore;
  /** Stack of menu item arrays; index 0 is the root menu. */
  stack: MenuItem[][];
}

function buildRootNav(api: TuiPluginApi, store: ConfigStore): MenuNav {
  const t = translatorFor(store.get());
  return { api, store, stack: [buildMenu(t, store)] };
}

function currentMenu(nav: MenuNav): MenuItem[] {
  const top = nav.stack.at(-1);
  return top ?? [];
}

function renderCurrent(nav: MenuNav): void {
  const { api, store } = nav;
  const t = translatorFor(store.get());
  const items = currentMenu(nav);
  const isRoot = nav.stack.length <= 1;

  const options: Array<{ title: string; value: string; description?: string }> = [];
  if (!isRoot) {
    options.push({ title: t("config.return"), value: "__back" });
  }
  for (const item of items) {
    const description = item.description?.();
    options.push(description === undefined ? { title: item.title, value: item.key } : { title: item.title, value: item.key, description });
  }

  const title = isRoot ? t("config.title") : itemsTitle(nav);

  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title={title}
      options={options}
      onSelect={(option) => handleSelect(nav, option.value)}
    />
  ));
}

function itemsTitle(nav: MenuNav): string {
  // Last menu's group title: reuse the submenu's own title if derivable.
  const parent = nav.stack.at(-2);
  const child = nav.stack.at(-1);
  if (!parent || !child) return "";
  const entry = parent.find((item) => item.action.kind === "submenu" && item.action.items === child);
  return entry?.title ?? "";
}

function handleSelect(nav: MenuNav, value: string): void {
  if (value === "__back") {
    nav.stack.pop();
    renderCurrent(nav);
    return;
  }

  const item = currentMenu(nav).find((entry) => entry.key === value);
  if (!item) return;

  switch (item.action.kind) {
    case "submenu":
      nav.stack.push(item.action.items);
      renderCurrent(nav);
      return;
    case "bool": {
      openBoolDialog(nav, item, item.action.get(), item.action.apply);
      return;
    }
    case "lang": {
      openLangDialog(nav);
      return;
    }
    case "delay": {
      openDelayDialog(nav);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Sub-dialogs (bool / lang / delay) — return to current menu after applying
// ---------------------------------------------------------------------------

function openBoolDialog(
  nav: MenuNav,
  item: MenuItem,
  current: boolean,
  apply: (value: boolean) => void,
): void {
  const { api, store } = nav;
  const t = translatorFor(store.get());

  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title={item.title}
      options={[
        { title: t("misc.on"), value: true },
        { title: t("misc.off"), value: false },
      ]}
      current={current}
      onSelect={(option) => {
        const v = option.value === true;
        apply(v);
        api.ui.toast({ message: `${item.title}: ${t(v ? "misc.on" : "misc.off")}` });
        renderCurrent(nav);
      }}
    />
  ));
}

function openLangDialog(nav: MenuNav, onLangChange?: () => void): void {
  const { api, store } = nav;
  const t = translatorFor(store.get());

  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title={t("dialog.lang.title")}
      options={[
        { title: t("dialog.lang.auto"), value: "auto" },
        { title: t("dialog.lang.zh"), value: "zh" },
        { title: t("dialog.lang.en"), value: "en" },
      ]}
      onSelect={(option) => {
        const lang = option.value as Lang;
        store.update({ lang });
        const nextT = translatorFor(store.get());
        api.ui.toast({ message: `${t("toast.lang")} ${lang}` });
        // Rebuild root menu with the new language.
        nav.stack = [buildMenu(nextT, store)];
        onLangChange?.();
        renderCurrent(nav);
      }}
    />
  ));
}

function openDelayDialog(nav: MenuNav): void {
  const { api, store } = nav;
  const t = translatorFor(store.get());

  api.ui.dialog.replace(() => (
    <api.ui.DialogPrompt
      title={t("dialog.delay.title")}
      description={() => <text>{t("dialog.delay.description")}</text>}
      onConfirm={(value) => {
        const ms = Number.parseInt(value, 10);
        if (Number.isNaN(ms) || ms < 0) {
          api.ui.toast({ message: t("toast.delayInvalid"), variant: "error" });
          return;
        }
        store.updateNotification({ idleConfirmationDelay: ms });
        api.ui.toast({ message: `${t("toast.delay")} ${ms}ms` });
        renderCurrent(nav);
      }}
    />
  ));
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

const tui: TuiPlugin = async (api) => {
  const store = createConfigStore();
  let unregisterCommands: (() => void) | undefined;

  // Register the sidebar stats panel (cache / tools / subagents).
  api.slots.register(createSidebarSlot(api, store));

  // Register the slash commands with the current language. Returns an
  // unregister function so the commands can be re-registered when the
  // language changes (opencode only evaluates the command list once at
  // registration time).
  function registerCommands(): void {
    unregisterCommands?.();
    const t = translatorFor(store.get());
    unregisterCommands = api.command?.register(() => [
      {
        title: t("cmd.mot.title"),
        value: "mot",
        description: t("cmd.mot.desc"),
        slash: { name: "mot" },
        onSelect: () => {
          renderCurrent(buildRootNav(api, store));
        },
      },
      {
        title: t("cmd.status.title"),
        value: "mot-status",
        description: t("cmd.status.desc"),
        slash: { name: "mot-status" },
        onSelect: () => {
          const config = store.get();
          showStatus(api, config, translatorFor(config));
        },
      },
      {
        title: t("cmd.lang.title"),
        value: "mot-lang",
        description: t("cmd.lang.desc"),
        slash: { name: "mot-lang" },
        onSelect: () => {
          const nav = buildRootNav(api, store);
          openLangDialog(nav, registerCommands);
        },
      },
    ]);
  }

  registerCommands();
};

const plugin: TuiPluginModule & { id: string } = {
  id: `${ID}:tui`,
  tui,
};

export default plugin;
