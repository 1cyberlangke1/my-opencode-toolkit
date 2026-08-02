/** Per-session todo-reminder state. Simplified: no turn-boundary/stagnation/blockReason. */

export interface TodoItem {
  status: string;
  content?: string;
}

export interface SessionState {
  consecutiveFailures: number;
  lastInjectedAt?: number | undefined;
  abortDetectedAt?: number | undefined;
  wasCancelled?: boolean | undefined;
  tokenLimitDetected?: boolean | undefined;
  inFlight?: boolean | undefined;
  lastIncompleteCount?: number | undefined;
  countdownTimer?: ReturnType<typeof setTimeout> | undefined;
  countdownInterval?: ReturnType<typeof setInterval> | undefined;
}

export interface SessionStateStore {
  getState: (sessionID: string) => SessionState;
  getExistingState: (sessionID: string) => SessionState | undefined;
  resetState: (sessionID: string) => void;
  cancelCountdown: (sessionID: string) => void;
  cleanup: (sessionID: string) => void;
  cancelAllCountdowns: () => void;
  shutdown: () => void;
}

export function createSessionStateStore(): SessionStateStore {
  const sessions = new Map<string, SessionState>();

  function getState(sessionID: string): SessionState {
    const existing = sessions.get(sessionID);
    if (existing) return existing;
    const state: SessionState = { consecutiveFailures: 0 };
    sessions.set(sessionID, state);
    return state;
  }

  function getExistingState(sessionID: string): SessionState | undefined {
    return sessions.get(sessionID);
  }

  function resetState(sessionID: string): void {
    const state = sessions.get(sessionID);
    if (!state) return;
    state.lastInjectedAt = undefined;
    state.abortDetectedAt = undefined;
    state.wasCancelled = false;
    state.tokenLimitDetected = false;
    state.inFlight = false;
    state.consecutiveFailures = 0;
  }

  function cancelCountdown(sessionID: string): void {
    const state = sessions.get(sessionID);
    if (!state) return;
    if (state.countdownTimer) {
      clearTimeout(state.countdownTimer);
      state.countdownTimer = undefined;
    }
    if (state.countdownInterval) {
      clearInterval(state.countdownInterval);
      state.countdownInterval = undefined;
    }
    state.inFlight = false;
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
    resetState,
    cancelCountdown,
    cleanup,
    cancelAllCountdowns,
    shutdown,
  };
}
