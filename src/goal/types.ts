export const GOAL_STATUS_VALUES = ["active", "paused", "blocked", "budget_limited", "complete"] as const;

export type GoalStatus = (typeof GOAL_STATUS_VALUES)[number];

export interface Goal {
  goalId: string;
  sessionID: string;
  objective: string;
  status: GoalStatus;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
  lastBlockedReason?: string;
  blockedStreak?: number;
}

export interface GoalFile {
  version: 1;
  goal: Goal | null;
}

export interface GoalUpdate {
  status?: GoalStatus;
  tokensUsed?: number;
  timeUsedSeconds?: number;
}

export function isGoalStatus(value: unknown): value is GoalStatus {
  return typeof value === "string" && (GOAL_STATUS_VALUES as readonly string[]).includes(value);
}

export function isGoal(value: unknown): value is Goal {
  if (typeof value !== "object" || value === null) return false;
  const g = value as Record<string, unknown>;
  return (
    typeof g.goalId === "string" &&
    typeof g.sessionID === "string" &&
    typeof g.objective === "string" &&
    isGoalStatus(g.status) &&
    typeof g.tokensUsed === "number" &&
    typeof g.timeUsedSeconds === "number" &&
    typeof g.createdAt === "number" &&
    typeof g.updatedAt === "number"
  );
}

export function isGoalFile(value: unknown): value is GoalFile {
  if (typeof value !== "object" || value === null) return false;
  const f = value as Record<string, unknown>;
  if (f.version !== 1) return false;
  if (f.goal === null) return true;
  return isGoal(f.goal);
}
