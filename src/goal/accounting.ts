import type { GoalController } from "./controller";

/** Session client surface used for goal token accounting. */
export interface GoalAccountingContext {
  client: {
    session: {
      messages(
        id: string,
      ): Promise<
        Array<{ info: Record<string, unknown>; parts?: Array<{ type?: string; text?: string }> }> | undefined
      >;
    };
  };
}

interface AccountingSnapshot {
  input: number;
  output: number;
  accountedAt: number;
}

/**
 * Per-session goal usage accounting. On each idle the deltas of assistant tokens
 * and wall-clock time since the last snapshot are charged to the goal via the
 * controller's `accountUsage` (which only accrues while the goal is active).
 */
export function createGoalAccounting(): {
  account: (
    ctx: GoalAccountingContext,
    sessionID: string,
    controller: GoalController,
  ) => Promise<void>;
  clear: (sessionID: string) => void;
} {
  const snapshots = new Map<string, AccountingSnapshot>();

  async function account(
    ctx: GoalAccountingContext,
    sessionID: string,
    controller: GoalController,
  ): Promise<void> {
    const messages = await ctx.client.session.messages(sessionID).catch(() => undefined);
    if (!messages || messages.length === 0) return;

    let input = 0;
    let output = 0;
    for (const message of messages) {
      if (message.info.role !== "assistant") continue;
      const tokens = message.info.tokens as { input?: number; output?: number } | undefined;
      if (!tokens) continue;
      input += typeof tokens.input === "number" ? tokens.input : 0;
      output += typeof tokens.output === "number" ? tokens.output : 0;
    }

    const now = Date.now();
    const prev = snapshots.get(sessionID);
    const inputDelta = prev !== undefined ? Math.max(0, input - prev.input) : 0;
    const outputDelta = prev !== undefined ? Math.max(0, output - prev.output) : 0;
    const elapsed = prev !== undefined ? Math.floor((now - prev.accountedAt) / 1000) : 0;

    if (inputDelta > 0 || outputDelta > 0 || elapsed > 0) {
      controller.accountUsage(sessionID, { input: inputDelta, output: outputDelta }, elapsed);
    }
    snapshots.set(sessionID, { input, output, accountedAt: now });
  }

  function clear(sessionID: string): void {
    snapshots.delete(sessionID);
  }

  return { account, clear };
}
