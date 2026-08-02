import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { clearGoal, createGoal, readGoal, setGoalStatus, updateGoal, writeGoal, type GoalStoreRef } from "./store";
import type { Goal, GoalStatus } from "./types";

export interface GoalControllerOptions {
  projectDir: string;
  /** Max LLM-failure cooldown in ms (default 60000). */
  maxRetryCooldownMs?: number;
}

export interface TokenUsageSnapshot {
  input: number;
  output: number;
}

export interface GoalTuiSnapshot {
  version: 1;
  sessionID: string;
  goal: {
    goalId: string;
    objective: string;
    status: GoalStatus;
    tokensUsed: number;
    timeUsedSeconds: number;
    tokenBudget?: number;
  } | null;
}

const BLOCKED_STREAK_REQUIRED = 3;

export type GoalController = ReturnType<typeof createGoalController>;

export function createGoalController(options: GoalControllerOptions) {
  const baseDir = join(options.projectDir, ".opencode-toolkit", "goal");
  const tuiMirrorBaseDir = join(options.projectDir, ".opencode-toolkit", "goal-tui");

  const storeRef = (sessionID: string): GoalStoreRef => ({ baseDir, sessionID });
  const tuiMirrorPath = (sessionID: string): string =>
    join(tuiMirrorBaseDir, `${encodeURIComponent(sessionID)}.json`);

  const writeTuiMirror = (sessionID: string, goal: Goal | null): void => {
    const snapshot: GoalTuiSnapshot = {
      version: 1,
      sessionID,
      goal:
        goal === null
          ? null
          : {
              goalId: goal.goalId,
              objective: goal.objective,
              status: goal.status,
              tokensUsed: goal.tokensUsed,
              timeUsedSeconds: goal.timeUsedSeconds,
              ...(goal.tokenBudget !== undefined ? { tokenBudget: goal.tokenBudget } : {}),
            },
    };
    const path = tuiMirrorPath(sessionID);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  };

  return {
    setGoal(sessionID: string, objective: string): Goal {
      const ref = storeRef(sessionID);
      clearGoal(ref);
      const goal = createGoal(ref, objective);
      writeTuiMirror(sessionID, goal);
      return goal;
    },

    setGoalTokenBudget(sessionID: string, tokenBudget: number): Goal | null {
      const ref = storeRef(sessionID);
      const goal = readGoal(ref);
      if (goal === null) return null;
      goal.tokenBudget = tokenBudget;
      writeGoal(ref, goal);
      writeTuiMirror(sessionID, goal);
      return goal;
    },

    getGoal(sessionID: string): Goal | null {
      return readGoal(storeRef(sessionID));
    },

    pauseGoal(sessionID: string): Goal | null {
      const goal = setGoalStatus(storeRef(sessionID), "paused");
      if (goal !== null) writeTuiMirror(sessionID, goal);
      return goal;
    },

    resumeGoal(sessionID: string): Goal | null {
      const goal = setGoalStatus(storeRef(sessionID), "active");
      if (goal !== null) writeTuiMirror(sessionID, goal);
      return goal;
    },

    clearGoal(sessionID: string): boolean {
      const ref = storeRef(sessionID);
      const existed = readGoal(ref) !== null;
      clearGoal(ref);
      writeTuiMirror(sessionID, null);
      return existed;
    },

    markComplete(sessionID: string): Goal | null {
      const goal = setGoalStatus(storeRef(sessionID), "complete");
      if (goal !== null) writeTuiMirror(sessionID, goal);
      return goal;
    },

    markBudgetLimited(sessionID: string): Goal | null {
      const goal = setGoalStatus(storeRef(sessionID), "budget_limited");
      if (goal !== null) writeTuiMirror(sessionID, goal);
      return goal;
    },

    markBlocked(sessionID: string, reason: string): Goal | null {
      const ref = storeRef(sessionID);
      const existing = readGoal(ref);
      if (existing === null) return null;

      const sameReason = existing.lastBlockedReason === reason;
      const streak = sameReason ? (existing.blockedStreak ?? 1) + 1 : 1;
      if (streak < BLOCKED_STREAK_REQUIRED) {
        const goal = updateGoal(ref, {});
        if (goal !== null) {
          goal.lastBlockedReason = reason;
          goal.blockedStreak = streak;
          writeGoal(ref, goal);
          writeTuiMirror(sessionID, goal);
        }
        return goal;
      }

      const goal = setGoalStatus(ref, "blocked");
      if (goal !== null) {
        goal.lastBlockedReason = reason;
        goal.blockedStreak = streak;
        writeGoal(ref, goal);
        writeTuiMirror(sessionID, goal);
      }
      return goal;
    },

    accountUsage(sessionID: string, usage: TokenUsageSnapshot, elapsedSeconds: number): Goal | null {
      const ref = storeRef(sessionID);
      const goal = readGoal(ref);
      if (goal === null || goal.status !== "active") return goal;

      const tokenDelta = Math.max(0, usage.input) + Math.max(0, usage.output);
      let updated = updateGoal(ref, {
        tokensUsed: goal.tokensUsed + tokenDelta,
        timeUsedSeconds: goal.timeUsedSeconds + Math.max(0, elapsedSeconds),
      });
      if (updated === null) return null;

      if (updated.tokenBudget !== undefined && updated.tokensUsed >= updated.tokenBudget) {
        updated = setGoalStatus(ref, "budget_limited");
      }
      if (updated !== null) writeTuiMirror(sessionID, updated);
      return updated;
    },

    updateTui(sessionID: string): void {
      writeTuiMirror(sessionID, readGoal(storeRef(sessionID)));
    },

    readTuiMirror(sessionID: string): GoalTuiSnapshot | null {
      try {
        const raw = readFileSync(tuiMirrorPath(sessionID), "utf8");
        return JSON.parse(raw) as GoalTuiSnapshot;
      } catch {
        return null;
      }
    },
  };
}
