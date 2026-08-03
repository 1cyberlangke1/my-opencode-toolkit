import { createMemo } from "solid-js";
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui";

type RGB = { r: number; g: number; b: number };

function rgb(raw: unknown): RGB | null {
  if (typeof raw === "string" && raw.startsWith("#")) {
    const h = raw.slice(1);
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (typeof o.r === "number" && typeof o.g === "number" && typeof o.b === "number") {
      const scale = o.r > 1 || o.g > 1 || o.b > 1 ? 1 : 255;
      return { r: Math.round(o.r * scale), g: Math.round(o.g * scale), b: Math.round(o.b * scale) };
    }
  }
  return null;
}

function saturation(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const delta = max - min;
  if (delta === 0) return 0;
  const l = (max + min) / 2;
  return l <= 0.5 ? delta / (max + min) : delta / (2 - max - min);
}

function desaturateTo(raw: unknown, maxSat: number, fallback: string): string {
  const c = rgb(raw);
  if (!c) return fallback;
  const sat = saturation(c.r, c.g, c.b);
  if (sat <= maxSat) {
    return `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }
  const luma = c.r * 0.299 + c.g * 0.587 + c.b * 0.114;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    const nr = Math.round(c.r + (luma - c.r) * mid);
    const ng = Math.round(c.g + (luma - c.g) * mid);
    const nb = Math.round(c.b + (luma - c.b) * mid);
    if (saturation(nr, ng, nb) > maxSat) lo = mid;
    else hi = mid;
  }
  const nr = Math.round(c.r + (luma - c.r) * hi);
  const ng = Math.round(c.g + (luma - c.g) * hi);
  const nb = Math.round(c.b + (luma - c.b) * hi);
  return `#${[nr, ng, nb]
    .map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0"))
    .join("")}`;
}

function dimColor(hex: string, factor = 0.5): string {
  const c = rgb(hex);
  if (!c) return hex;
  const r = Math.round(c.r * factor);
  const g = Math.round(c.g * factor);
  const b = Math.round(c.b * factor);
  return `#${[r, g, b]
    .map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** Morandi low-saturation fallback palette used when the theme lacks a key. */export const FALLBACK = {
  primary: "#8B9DAF",
  text: "#C5C5BB",
  muted: "#7A7A72",
  success: "#9CAF8B",
  warning: "#C5B88D",
  error: "#B08A8A",
  border: "#6B6B63",
} as const;

const MAX_SAT = 0.28;

export interface Palette {
  primary: string;
  text: string;
  muted: string;
  success: string;
  warning: string;
  error: string;
  border: string;
}

/** Build a low-saturation palette from the current OpenTUI theme. */
export function usePalette(theme: TuiThemeCurrent) {
  return createMemo<Palette>(() => {
    const th = theme as unknown as Record<string, unknown>;
    const sat = (key: string, fb: string): string => desaturateTo(th[key], MAX_SAT, fb);
    return {
      primary: sat("primary", FALLBACK.primary),
      text: sat("text", FALLBACK.text),
      muted: sat("textMuted", FALLBACK.muted),
      success: sat("success", FALLBACK.success),
      warning: sat("warning", FALLBACK.warning),
      error: sat("error", FALLBACK.error),
      border: sat("border", FALLBACK.border),
    };
  });
}

/**
 * HSL → hex。h 为色相角度（0-360），s/l 为 0-1。
 * YOLO 彩虹渐变用：`hue = (now % period) / period * 360` 即可让颜色沿色相环旋转。
 */
export function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) {
    r = c;
    g = x;
  } else if (hue < 120) {
    r = x;
    g = c;
  } else if (hue < 180) {
    g = c;
    b = x;
  } else if (hue < 240) {
    g = x;
    b = c;
  } else if (hue < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  return `#${[r, g, b]
    .map((v) =>
      Math.max(0, Math.min(255, Math.round((v + m) * 255)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** 随时间旋转的彩虹色（高饱和、中亮度），用于 YOLO 激活指示。 */
export function rainbowColor(now: number, periodMs = 4000): string {
  const hue = ((now % periodMs) / periodMs) * 360;
  return hslToHex(hue, 0.85, 0.55);
}

export { dimColor, rgb, saturation };
