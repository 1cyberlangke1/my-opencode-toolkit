export interface SchedulerConfig {
  /** Delay in ms before sending to confirm the session is still idle (default: 1500) */
  idleConfirmationDelay: number;
  /** Skip notification when there are incomplete todos (default: true) */
  skipIfIncompleteTodos: boolean;
  /** Maximum number of sessions to track before cleanup (default: 100) */
  maxTrackedSessions: number;
}

export interface SchedulerDeps {
  /** Check whether the session still has pending work (incomplete todos). */
  hasPendingWork(sessionID: string): Promise<boolean>;
  /** Send the notification for a confirmed-idle session. */
  send(sessionID: string): Promise<void>;
}

export interface IdleNotificationScheduler {
  /** Called when session activity is observed — cancels a pending notification. */
  markSessionActivity(sessionID: string): void;
  /** Called on session.idle — schedules a delayed, confirmable notification. */
  scheduleIdleNotification(sessionID: string): void;
  /** Called on session.deleted — cleans up all state for the session. */
  deleteSession(sessionID: string): void;
  /** Clear all pending timers and state. */
  dispose(): void;
}

/**
 * Schedules idle notifications with a confirmation delay, activity cancellation,
 * per-session dedup, and an optional incomplete-todos guard.
 */
export function createIdleNotificationScheduler(
  config: SchedulerConfig,
  deps: SchedulerDeps,
): IdleNotificationScheduler {
  const notifiedSessions = new Set<string>();
  const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const sessionActivitySinceIdle = new Set<string>();
  const notificationVersions = new Map<string, number>();
  const executingNotifications = new Set<string>();
  const scheduledAt = new Map<string, number>();

  function cleanupOldSessions(): void {
    if (notifiedSessions.size > config.maxTrackedSessions) {
      const overflow = Array.from(notifiedSessions).slice(
        0,
        notifiedSessions.size - config.maxTrackedSessions,
      );
      for (const id of overflow) notifiedSessions.delete(id);
    }
    if (sessionActivitySinceIdle.size > config.maxTrackedSessions) {
      const overflow = Array.from(sessionActivitySinceIdle).slice(
        0,
        sessionActivitySinceIdle.size - config.maxTrackedSessions,
      );
      for (const id of overflow) sessionActivitySinceIdle.delete(id);
    }
  }

  function cancelPendingNotification(sessionID: string): void {
    const timer = pendingTimers.get(sessionID);
    if (timer) {
      clearTimeout(timer);
      pendingTimers.delete(sessionID);
    }
    scheduledAt.delete(sessionID);
    sessionActivitySinceIdle.add(sessionID);
    notificationVersions.set(sessionID, (notificationVersions.get(sessionID) ?? 0) + 1);
  }

  async function executeNotification(sessionID: string, version: number): Promise<void> {
    pendingTimers.delete(sessionID);
    scheduledAt.delete(sessionID);

    if (executingNotifications.has(sessionID)) return;
    if (notificationVersions.get(sessionID) !== version) return;
    if (sessionActivitySinceIdle.has(sessionID)) {
      sessionActivitySinceIdle.delete(sessionID);
      return;
    }
    if (notifiedSessions.has(sessionID)) return;

    executingNotifications.add(sessionID);
    try {
      if (config.skipIfIncompleteTodos) {
        const hasPendingWork = await deps.hasPendingWork(sessionID);
        if (notificationVersions.get(sessionID) !== version) return;
        if (hasPendingWork) return;
      }

      if (notificationVersions.get(sessionID) !== version) return;
      if (sessionActivitySinceIdle.has(sessionID)) {
        sessionActivitySinceIdle.delete(sessionID);
        return;
      }

      notifiedSessions.add(sessionID);
      await deps.send(sessionID);
    } finally {
      executingNotifications.delete(sessionID);
      if (sessionActivitySinceIdle.has(sessionID)) {
        notifiedSessions.delete(sessionID);
        sessionActivitySinceIdle.delete(sessionID);
      }
    }
  }

  return {
    markSessionActivity(sessionID) {
      cancelPendingNotification(sessionID);
      if (!executingNotifications.has(sessionID)) {
        notifiedSessions.delete(sessionID);
      }
    },
    scheduleIdleNotification(sessionID) {
      if (notifiedSessions.has(sessionID)) return;
      if (pendingTimers.has(sessionID)) return;
      if (executingNotifications.has(sessionID)) return;

      sessionActivitySinceIdle.delete(sessionID);
      scheduledAt.set(sessionID, Date.now());

      const currentVersion = (notificationVersions.get(sessionID) ?? 0) + 1;
      notificationVersions.set(sessionID, currentVersion);

      const timer = setTimeout(() => {
        void executeNotification(sessionID, currentVersion);
      }, config.idleConfirmationDelay);

      pendingTimers.set(sessionID, timer);
      cleanupOldSessions();
    },
    deleteSession(sessionID) {
      cancelPendingNotification(sessionID);
      notifiedSessions.delete(sessionID);
      sessionActivitySinceIdle.delete(sessionID);
      notificationVersions.delete(sessionID);
      executingNotifications.delete(sessionID);
      scheduledAt.delete(sessionID);
    },
    dispose() {
      for (const timer of pendingTimers.values()) {
        clearTimeout(timer);
      }
      pendingTimers.clear();
      notifiedSessions.clear();
      sessionActivitySinceIdle.clear();
      notificationVersions.clear();
      executingNotifications.clear();
      scheduledAt.clear();
    },
  };
}
