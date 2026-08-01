/** @jsxImportSource @opentui/solid */

import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";

import { createConfigStore, type ConfigStore } from "./config/store";
import type { ToolkitConfig } from "./config/types";
import { createTranslator, resolveLang, type Lang, type Translator } from "./i18n";
import { createSidebarSlot } from "./sidebar";
import { applySidebarConfig, sidebarConfigSignal } from "./sidebar/state";

const ID = "my-opencode-toolkit";

// ---------------------------------------------------------------------------
// Menu model
// ---------------------------------------------------------------------------

type MenuAction =
  | { kind: "submenu"; items: MenuItem[] }
  | { kind: "bool"; get: () => boolean; apply: (value: boolean) => void }
  | { kind: "lang" };

interface MenuItem {
  key: string;
  title: string;
  description?: () => string;
  /** Help text shown inside the on/off dialog for this item. */
  help?: string;
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
    `${t("status.todos")}: ${onOff(n.skipIfIncompleteTodos)}`,
    `${t("status.mainonly")}: ${onOff(n.onlyMainSession)}`,
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
      help: t("help.notify"),
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
      help: t("help.complete"),
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
      help: t("help.question"),
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
      help: t("help.permission"),
      action: {
        kind: "bool",
        get: () => store.get().notification.onPermission,
        apply: (v) => store.updateNotification({ onPermission: v }),
      },
    },
    {
      key: "todos",
      title: t("config.todos"),
      description: () => onOff(store.get().notification.skipIfIncompleteTodos),
      help: t("help.todos"),
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
      help: t("help.mainonly"),
      action: {
        kind: "bool",
        get: () => store.get().notification.onlyMainSession,
        apply: (v) => store.updateNotification({ onlyMainSession: v }),
      },
    },
  ];

  const sidebarItems: MenuItem[] = [
    {
      key: "sidebar",
      title: t("config.sidebar"),
      description: () => onOff(sidebarConfigSignal().enabled),
      help: t("help.sidebar"),
      action: {
        kind: "bool",
        get: () => sidebarConfigSignal().enabled,
        apply: (v) => applySidebarConfig({ enabled: v }),
      },
    },
    {
      key: "sidebarCache",
      title: t("config.sidebarCache"),
      description: () => onOff(sidebarConfigSignal().showCache),
      help: t("help.sidebarCache"),
      action: {
        kind: "bool",
        get: () => sidebarConfigSignal().showCache,
        apply: (v) => applySidebarConfig({ showCache: v }),
      },
    },
    {
      key: "sidebarTools",
      title: t("config.sidebarTools"),
      description: () => onOff(sidebarConfigSignal().showTools),
      help: t("help.sidebarTools"),
      action: {
        kind: "bool",
        get: () => sidebarConfigSignal().showTools,
        apply: (v) => applySidebarConfig({ showTools: v }),
      },
    },
    {
      key: "sidebarSubagents",
      title: t("config.sidebarSubagents"),
      description: () => onOff(sidebarConfigSignal().showSubagents),
      help: t("help.sidebarSubagents"),
      action: {
        kind: "bool",
        get: () => sidebarConfigSignal().showSubagents,
        apply: (v) => applySidebarConfig({ showSubagents: v }),
      },
    },
    {
      key: "sidebarCollapsed",
      title: t("config.sidebarCollapsed"),
      description: () => onOff(sidebarConfigSignal().collapsed),
      help: t("help.sidebarCollapsed"),
      action: {
        kind: "bool",
        get: () => sidebarConfigSignal().collapsed,
        apply: (v) => applySidebarConfig({ collapsed: v }),
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
      help: t("help.toggle"),
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
  }
}

// ---------------------------------------------------------------------------
// Sub-dialogs (bool / lang) — return to current menu after applying
// ---------------------------------------------------------------------------

const HELP_MAX_LINES = 2;
const HELP_MAX_CHARS = 40;

/** Truncate a help text to at most HELP_MAX_LINES lines of HELP_MAX_CHARS. */
function formatHelpText(help: string): string {
  const lines = help.split("\n").slice(0, HELP_MAX_LINES);
  const truncated = lines.map((line) =>
    line.length > HELP_MAX_CHARS ? `${line.slice(0, HELP_MAX_CHARS - 1)}…` : line,
  );
  if (help.split("\n").length > HELP_MAX_LINES) {
    truncated[truncated.length - 1] = `${truncated[truncated.length - 1] ?? ""}…`;
  }
  return truncated.join("\n");
}

function openBoolDialog(
  nav: MenuNav,
  item: MenuItem,
  current: boolean,
  apply: (value: boolean) => void,
): void {
  const { api, store } = nav;
  const t = translatorFor(store.get());

  const boolOptions = [
    { title: t("misc.on"), value: true },
    { title: t("misc.off"), value: false },
  ];

  api.ui.dialog.replace(() => (
    <api.ui.DialogSelect
      title={item.help !== undefined ? `${item.title}\n${formatHelpText(item.help)}` : item.title}
      options={boolOptions}
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
