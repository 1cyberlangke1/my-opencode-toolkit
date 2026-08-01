function charColumns(c: string): number {
  const code = c.codePointAt(0) ?? 0;
  if (code < 0x20) return 0;
  if (code < 0x7f) return 1;
  if (code < 0xa0) return 0;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe6f) ||
    (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** Visual width in terminal columns (CJK chars count as 2). */
export function visualWidth(s: string): number {
  let w = 0;
  for (const c of s) w += charColumns(c);
  return w;
}

/** Truncate to a max number of visual columns, appending "…". */
export function truncate(text: string, maxCols: number): string {
  if (visualWidth(text) <= maxCols) return text;
  let cols = 0;
  let i = 0;
  for (const c of text) {
    const w = charColumns(c);
    if (cols + w > maxCols - 1) break;
    cols += w;
    i += c.length;
  }
  return `${text.slice(0, i)}…`;
}

/** Pad to a target visual width with spaces. */
export function padRight(text: string, width: number): string {
  const pad = Math.max(0, width - visualWidth(text));
  return `${text}${" ".repeat(pad)}`;
}

/** Compact duration, e.g. 2m30s / 3.2s / 850ms. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}
