import { en, type TranslationDict } from "./en";
import { zh } from "./zh";

export type { TranslationDict } from "./en";
export type Lang = "zh" | "en" | "auto";

export const LANG_KEYS: readonly ("zh" | "en")[] = ["zh", "en"] as const;

/**
 * Detect the user's preferred language.
 *
 * Priority: OPENCODE_LANG env → LANG/LC_ALL env → system locale (Intl).
 * `Intl.DateTimeFormat().resolvedOptions().locale` reflects the OS locale,
 * which is the reliable signal on Windows where LANG is typically unset.
 */
export function detectLang(env: NodeJS.ProcessEnv): "zh" | "en" {
  const fromEnv = env.OPENCODE_LANG ?? env.LANG ?? env.LC_ALL ?? "";
  if (fromEnv.toLowerCase().startsWith("zh")) return "zh";
  if (fromEnv.length > 0) return "en";

  const systemLocale = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase();
  return systemLocale.startsWith("zh") ? "zh" : "en";
}

/** Resolve the effective language given the configured value. */
export function resolveLang(configured: Lang, env: NodeJS.ProcessEnv): "zh" | "en" {
  return configured === "auto" ? detectLang(env) : configured;
}

export function translate(lang: "zh" | "en", key: keyof TranslationDict): string {
  const dict: TranslationDict = lang === "zh" ? zh : en;
  return dict[key];
}

/** Create a bound translation function for a resolved language. */
export function createTranslator(lang: "zh" | "en") {
  return (key: keyof TranslationDict): string => translate(lang, key);
}

export type Translator = ReturnType<typeof createTranslator>;
