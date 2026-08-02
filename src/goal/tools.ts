import { tool, type ToolDefinition } from "@opencode-ai/plugin";

import type { GoalController } from "./controller";

export interface GoalToolsDeps {
  controller: GoalController;
  getSessionID: () => string | undefined;
  isSubagent: (sessionID: string) => Promise<boolean>;
}

function formatGoal(goal: ReturnType<GoalController["getGoal"]>): string {
  return JSON.stringify({ goal }, null, 2);
}

export function createGoalTool(deps: GoalToolsDeps): ToolDefinition {
  return tool({
    description: `Create a persistent goal for the current session.

Use this when the user asks you to set a goal, or when you decide a new high-level objective is needed. The goal persists across turns and is shown in the TUI.

The objective should be concise and describe the desired outcome, not a single action. If this thread already has an unfinished goal, creating a new one fails; complete or clear the existing goal first.`,
    args: {
      objective: tool.schema.string().describe("Concise outcome the session should achieve"),
      token_budget: tool.schema
        .number()
        .int()
        .positive()
        .optional()
        .describe("Optional token budget; the goal becomes budget_limited when tokensUsed reaches it"),
    },
    execute: async (args, context) => {
      const sessionID = deps.getSessionID() ?? context.sessionID;
      if (await deps.isSubagent(sessionID)) {
        return "Error: goal tools are not available to subagents.";
      }
      const existing = deps.controller.getGoal(sessionID);
      if (existing !== null && existing.status !== "complete" && existing.status !== "blocked") {
        return "Error: this thread has an unfinished goal; complete or clear it before creating a new one.";
      }
      deps.controller.setGoal(sessionID, args.objective);
      if (args.token_budget !== undefined) {
        deps.controller.setGoalTokenBudget(sessionID, args.token_budget);
      }
      return formatGoal(deps.controller.getGoal(sessionID));
    },
  });
}

export function getGoalTool(deps: GoalToolsDeps): ToolDefinition {
  return tool({
    description: `Read the active goal for the current session.

Returns the current objective, status, token budget and usage accounting. Returns null if no goal is set.`,
    args: {},
    execute: async (_args, context) => {
      const sessionID = deps.getSessionID() ?? context.sessionID;
      if (await deps.isSubagent(sessionID)) {
        return "Error: goal tools are not available to subagents.";
      }
      return formatGoal(deps.controller.getGoal(sessionID));
    },
  });
}

export function updateGoalTool(deps: GoalToolsDeps): ToolDefinition {
  return tool({
    description: `Update the status of the current session's goal.

Can only mark the goal as complete or blocked. Pause, resume, budget-limited, and usage-limited status changes are controlled by the user or system.

When you believe the goal has been achieved, first perform a completion audit against the actual current state (files, tests, command output), then call update_goal with status "complete". Use status "blocked" only when the same blocking condition has repeated for at least three consecutive goal turns.`,
    args: {
      status: tool.schema
        .enum(["complete", "blocked"])
        .describe("New goal status: complete or blocked"),
      block_reason: tool.schema
        .string()
        .optional()
        .describe("Required when status is blocked; describes the blocking condition"),
    },
    execute: async (args, context) => {
      const sessionID = deps.getSessionID() ?? context.sessionID;
      if (await deps.isSubagent(sessionID)) {
        return "Error: goal tools are not available to subagents.";
      }
      if (args.status === "complete") {
        const goal = deps.controller.markComplete(sessionID);
        if (goal === null) return "Error: no goal set for this session.";
        return formatGoal(goal);
      }
      const reason = args.block_reason?.trim() ?? "";
      if (reason.length === 0) {
        return "Error: block_reason is required when status is blocked.";
      }
      const goal = deps.controller.markBlocked(sessionID, reason);
      if (goal === null) return "Error: no goal set for this session.";
      return formatGoal(goal);
    },
  });
}

export function createGoalTools(deps: GoalToolsDeps): Record<string, ToolDefinition> {
  return {
    create_goal: createGoalTool(deps),
    get_goal: getGoalTool(deps),
    update_goal: updateGoalTool(deps),
  };
}
