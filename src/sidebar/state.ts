import { createSignal } from "solid-js";

import { createConfigStore } from "../config/store";
import type { SidebarConfig } from "../config/types";

/**
 * Module-scoped reactive sidebar config signal.
 *
 * Unlike `store.get()` (a plain file read that Solid does not track), this is a
 * real Solid signal: any JSX that reads `sidebarConfigSignal()` establishes a
 * reactive dependency, and calling `applySidebarConfig(...)` re-renders every
 * subscriber automatically — no manual bump, no store.subscribe bridge.
 *
 * Mirrors the module-scoped `createSignal` pattern used by
 * opencode-subagent-magazine (`clearTick`), which is proven to work in OpenTUI
 * sidebar slots.
 */
const store = createConfigStore();

export const [sidebarConfigSignal, setSidebarConfigSignal] = createSignal<SidebarConfig>(
  store.get().sidebar,
);

/** Update the reactive sidebar config and persist it. */
export function applySidebarConfig(patch: Partial<SidebarConfig>): void {
  setSidebarConfigSignal({ ...sidebarConfigSignal(), ...patch });
  store.updateSidebar(patch);
}
