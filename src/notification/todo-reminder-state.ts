/** Per-session continuation state store, faithfully mirroring omo's todo-continuation-enforcer. */

export type ContinuationBlockReason = "directive-response" | "user-interruption";

export interface TodoItem {
  status: string;
  content?: string;
  priority?: string;
  id?: string;
}

export interface SessionState {
  stagnationCount: number;
  consecutiveFailures: number;
  lastInjectedAt?: number | undefined;
  abortDetectedAt?: number | undefined;
  wasCancelled?: boolean | undefined;
  tokenLimitDetected?: boolean | undefined;
  awaitingPostInjectionProgressCheck?: boolean | undefined;
  continuationResponseObserved?: boolean | undefined;
  continuationBlockReason?: ContinuationBlockReason | undefined;
  pendingUserMessageID?: string | undefined;
  countdownStartedAt?: number | undefined;
  inFlight?: boolean | undefined;
  allTodosCompletedAt?: number | undefined;
  lastIncompleteCount?: number | undefined;
  countdownTimer?: ReturnType<typeof setTimeout> | undefined;
  countdownInterval?: ReturnType<typeof setInterval> | undefined;
}

export interface ContinuationProgressUpdate {
  previousIncompleteCount?: number | undefined;
  previousStagnationCount: number;
  stagnationCount: number;
  hasProgressed: boolean;
}

export interface SessionStateStore {
  getState: (sessionID: string) => SessionState;
  getExistingState: (sessionID: string) => SessionState | undefined;
  trackContinuationProgress: (
    sessionID: string,
    incompleteCount: number,
    todos?: TodoItem[],
  ) => ContinuationProgressUpdate;
  resetContinuationProgress: (sessionID: string) => void;
  cancelCountdown: (sessionID: string) => void;
  cleanup: (sessionID: string) => void;
  cancelAllCountdowns: () => void;
  shutdown: () => void;
}

/**
 * Snapshot only the {id → status} mapping. Content/priority changes do not
 * represent meaningful progress and must not reset the stagnation counter.
 */
function getTodoSnapshot(todos: TodoItem[]): string {
  const entries = todos
    .map((todo) => ({
      key: todo.id ?? `${todo.content}:${todo.priority ?? ""}`,
      status: todo.status,
    }))
    .sort((left, right) => left.key.localeCompare(right.key))
    .map(({ key, status }) => `${key}=${status}`);
  return entries.join("|");
}

interface TrackedSessionState {
  state: SessionState;
  lastCompletedCount?: number | undefined;
  lastTodoSnapshot?: string | undefined;
}

export function createSessionStateStore(): SessionStateStore {
  const sessions = new Map<string, TrackedSessionState>();

  function getTrackedSession(sessionID: string): TrackedSessionState {
    const existing = sessions.get(sessionID);
    if (existing) return existing;

    const tracked: TrackedSessionState = {
      state: {
        stagnationCount: 0,
        consecutiveFailures: 0,
      },
    };
    sessions.set(sessionID, tracked);
    return tracked;
  }

  function getState(sessionID: string): SessionState {
    return getTrackedSession(sessionID).state;
  }

  function getExistingState(sessionID: string): SessionState | undefined {
    return sessions.get(sessionID)?.state;
  }

  function trackContinuationProgress(
    sessionID: string,
    incompleteCount: number,
    todos?: TodoItem[],
  ): ContinuationProgressUpdate {
    const tracked = getTrackedSession(sessionID);
    const state = tracked.state;
    const previousIncompleteCount = state.lastIncompleteCount;
    const previousStagnationCount = state.stagnationCount;

    const currentCompletedCount = todos?.filter((todo) => todo.status === "completed").length;
    const currentTodoSnapshot = todos ? getTodoSnapshot(todos) : undefined;
    const hasCompletedMoreTodos =
      currentCompletedCount !== undefined &&
      tracked.lastCompletedCount !== undefined &&
      currentCompletedCount > tracked.lastCompletedCount;
    const hasTodoSnapshotChanged =
      currentTodoSnapshot !== undefined &&
      tracked.lastTodoSnapshot !== undefined &&
      currentTodoSnapshot !== tracked.lastTodoSnapshot;
    const hadSuccessfulInjectionAwaitingProgressCheck =
      state.awaitingPostInjectionProgressCheck === true;

    state.lastIncompleteCount = incompleteCount;
    if (currentCompletedCount !== undefined) tracked.lastCompletedCount = currentCompletedCount;
    if (currentTodoSnapshot !== undefined) tracked.lastTodoSnapshot = currentTodoSnapshot;

    if (previousIncompleteCount === undefined) {
      state.stagnationCount = 0;
      return {
        previousIncompleteCount,
        previousStagnationCount,
        stagnationCount: state.stagnationCount,
        hasProgressed: false,
      };
    }

    const hasProgressed =
      incompleteCount < previousIncompleteCount || hasCompletedMoreTodos || hasTodoSnapshotChanged;

    if (hasProgressed) {
      state.stagnationCount = 0;
      state.awaitingPostInjectionProgressCheck = false;
      state.continuationResponseObserved = false;
      state.continuationBlockReason = undefined;
      state.pendingUserMessageID = undefined;
      return {
        previousIncompleteCount,
        previousStagnationCount,
        stagnationCount: state.stagnationCount,
        hasProgressed: true,
      };
    }

    if (!hadSuccessfulInjectionAwaitingProgressCheck) {
      return {
        previousIncompleteCount,
        previousStagnationCount,
        stagnationCount: state.stagnationCount,
        hasProgressed: false,
      };
    }

    state.awaitingPostInjectionProgressCheck = false;
    if (
      state.continuationResponseObserved === true &&
      state.continuationBlockReason !== "user-interruption"
    ) {
      state.continuationBlockReason = "directive-response";
    }
    state.continuationResponseObserved = false;
    state.pendingUserMessageID = undefined;
    state.stagnationCount += 1;
    return {
      previousIncompleteCount,
      previousStagnationCount,
      stagnationCount: state.stagnationCount,
      hasProgressed: false,
    };
  }

  function resetContinuationProgress(sessionID: string): void {
    const tracked = sessions.get(sessionID);
    if (!tracked) return;

    const { state } = tracked;
    state.lastIncompleteCount = undefined;
    state.stagnationCount = 0;
    state.awaitingPostInjectionProgressCheck = false;
    state.continuationResponseObserved = false;
    state.continuationBlockReason = undefined;
    state.pendingUserMessageID = undefined;
    state.allTodosCompletedAt = undefined;
    tracked.lastCompletedCount = undefined;
    tracked.lastTodoSnapshot = undefined;
  }

  function cancelCountdown(sessionID: string): void {
    const tracked = sessions.get(sessionID);
    if (!tracked) return;

    const state = tracked.state;
    if (state.countdownTimer) {
      clearTimeout(state.countdownTimer);
      state.countdownTimer = undefined;
    }
    if (state.countdownInterval) {
      clearInterval(state.countdownInterval);
      state.countdownInterval = undefined;
    }
    state.inFlight = false;
    state.countdownStartedAt = undefined;
  }

  function cleanup(sessionID: string): void {
    cancelCountdown(sessionID);
    sessions.delete(sessionID);
  }

  function cancelAllCountdowns(): void {
    for (const sessionID of sessions.keys()) {
      cancelCountdown(sessionID);
    }
  }

  function shutdown(): void {
    cancelAllCountdowns();
    sessions.clear();
  }

  return {
    getState,
    getExistingState,
    trackContinuationProgress,
    resetContinuationProgress,
    cancelCountdown,
    cleanup,
    cancelAllCountdowns,
    shutdown,
  };
}
