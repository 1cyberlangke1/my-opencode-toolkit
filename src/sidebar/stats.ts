import type { Message, Part } from "@opencode-ai/sdk/v2";

export interface CacheStats {
  /** Total input tokens (excludes cache reads) */
  input: number;
  /** Total output tokens */
  output: number;
  /** Tokens read from prompt cache */
  cacheRead: number;
  /** Tokens written to prompt cache */
  cacheWrite: number;
}

export interface ToolCount {
  name: string;
  count: number;
}

export interface SessionStats {
  cache: CacheStats;
  tools: ToolCount[];
  /** Number of subtask parts / subagent tool calls in this session. */
  subagentCount: number;
}

function isCacheTokenMessage(message: Message): message is Message & {
  tokens: { input: number; output: number; cache: { read: number; write: number } };
} {
  return message.role === "assistant" && "tokens" in message && "cache" in message.tokens;
}

/** Aggregate cache + tool stats from a session's messages and parts. */
export function computeSessionStats(
  messages: readonly Message[],
  getParts: (messageID: string) => readonly Part[],
): SessionStats {
  const cache: CacheStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const toolCounts = new Map<string, number>();
  let subagentCount = 0;

  for (const message of messages) {
    if (isCacheTokenMessage(message)) {
      cache.input += message.tokens.input;
      cache.output += message.tokens.output;
      cache.cacheRead += message.tokens.cache.read;
      cache.cacheWrite += message.tokens.cache.write;
    }

    for (const part of getParts(message.id)) {
      if (part.type === "tool") {
        const name = part.tool;
        toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
      } else if (part.type === "subtask") {
        subagentCount += 1;
      }
    }
  }

  const tools = Array.from(toolCounts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  return { cache, tools, subagentCount };
}

/** Compute hit rate from cache stats. Returns a ratio in [0, 1]. */
export function cacheHitRate(cache: CacheStats): number {
  const total = cache.cacheRead + cache.input;
  if (total <= 0) return 0;
  return cache.cacheRead / total;
}

/** Format a token count as a compact human string (e.g. 5200 → "5.2k"). */
export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Format a ratio in [0,1] as a percentage string (e.g. 0.625 → "62.5%"). */
export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}
