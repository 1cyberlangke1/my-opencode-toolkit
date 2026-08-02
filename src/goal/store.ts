import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { isGoalFile, type Goal, type GoalFile, type GoalUpdate, type GoalStatus } from "./types";

const STORE_VERSION = 1;

export interface GoalStoreRef {
  baseDir: string;
  sessionID: string;
}

export function goalFilePath(ref: GoalStoreRef): string {
  return join(ref.baseDir, `${encodeURIComponent(ref.sessionID)}.json`);
}

export function ensureGoalStoreDir(baseDir: string): void {
  mkdirSync(baseDir, { recursive: true });
}

function parseGoalFile(raw: string): GoalFile {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isGoalFile(parsed)) return parsed;
  } catch {
    // fallthrough
  }
  return { version: STORE_VERSION, goal: null };
}

export function readGoal(ref: GoalStoreRef): Goal | null {
  let raw: string;
  try {
    raw = readFileSync(goalFilePath(ref), "utf8");
  } catch {
    return null;
  }
  return parseGoalFile(raw).goal;
}

export function writeGoal(ref: GoalStoreRef, goal: Goal | null): void {
  const filePath = goalFilePath(ref);
  const tempPath = `${filePath}.tmp.${randomUUID()}`;
  const file: GoalFile = { version: STORE_VERSION, goal };
  ensureGoalStoreDir(dirname(filePath));
  writeFileSync(tempPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  renameSync(tempPath, filePath);
}

export function clearGoal(ref: GoalStoreRef): boolean {
  const filePath = goalFilePath(ref);
  try {
    unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export function createGoal(ref: GoalStoreRef, objective: string): Goal {
  const now = nowSeconds();
  const goal: Goal = {
    goalId: randomUUID(),
    sessionID: ref.sessionID,
    objective,
    status: "active",
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: now,
    updatedAt: now,
  };
  writeGoal(ref, goal);
  return goal;
}

export function updateGoal(ref: GoalStoreRef, update: GoalUpdate): Goal | null {
  const existing = readGoal(ref);
  if (existing === null) return null;

  const now = nowSeconds();
  const updated: Goal = {
    ...existing,
    tokensUsed: update.tokensUsed ?? existing.tokensUsed,
    timeUsedSeconds: update.timeUsedSeconds ?? existing.timeUsedSeconds,
    updatedAt: now,
  };

  if (update.status !== undefined) {
    updated.status = update.status;
    if (update.status === "active" && existing.status !== "active") {
      delete updated.lastBlockedReason;
      delete updated.blockedStreak;
    }
    if (update.status === "complete") {
      delete updated.lastBlockedReason;
      delete updated.blockedStreak;
    }
  }

  writeGoal(ref, updated);
  return updated;
}

export function setGoalStatus(ref: GoalStoreRef, status: GoalStatus): Goal | null {
  return updateGoal(ref, { status });
}

function nowSeconds(): number {
  return Math.trunc(Date.now() / 1000);
}
