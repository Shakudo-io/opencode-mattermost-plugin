import type { SupabaseClientManager, ConnectionState } from "./supabase-client.js";
import { log } from "../../logger.js";

export type DegradedModeState = {
  isActive: boolean;
  reason: string | null;
  enteredAt: Date | null;
  failedOperations: number;
};

export type QueuedWrite = {
  table: string;
  operation: "insert" | "update" | "upsert" | "delete";
  data: Record<string, unknown>;
  timestamp: number;
  id?: string;
};

export type WriteQueueStats = {
  size: number;
  oldestTimestamp: number | null;
  isFull: boolean;
  isExpired: boolean;
};

export type DegradedModeManager = {
  getState: () => DegradedModeState;
  isActive: () => boolean;
  enter: (reason: string) => void;
  exit: () => void;
  recordFailure: () => void;
  recordSuccess: () => void;
  shouldUsePostgres: () => boolean;
  onStateChange: (callback: (state: DegradedModeState) => void) => () => void;
  queueWrite: (write: Omit<QueuedWrite, "timestamp">) => boolean;
  getQueuedWrites: () => QueuedWrite[];
  clearQueue: () => void;
  getQueueStats: () => WriteQueueStats;
  onQueueFlushNeeded: (callback: (writes: QueuedWrite[]) => Promise<void>) => () => void;
};

const FAILURE_THRESHOLD = 3;
const RECOVERY_SUCCESS_THRESHOLD = 5;
const MAX_QUEUE_SIZE = 1000;
const QUEUE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

export function createDegradedModeManager(
  clientManager: SupabaseClientManager | null
): DegradedModeManager {
  let state: DegradedModeState = {
    isActive: false,
    reason: null,
    enteredAt: null,
    failedOperations: 0,
  };

  let consecutiveSuccesses = 0;
  const stateCallbacks: Set<(state: DegradedModeState) => void> = new Set();
  const writeQueue: QueuedWrite[] = [];
  const flushCallbacks: Set<(writes: QueuedWrite[]) => Promise<void>> = new Set();

  function notifyStateChange() {
    for (const cb of stateCallbacks) {
      try {
        cb({ ...state });
      } catch (e) {
        log.error("[degraded-mode] Error in state callback", e);
      }
    }
  }

  function isQueueFull(): boolean {
    return writeQueue.length >= MAX_QUEUE_SIZE;
  }

  function isQueueExpired(): boolean {
    if (writeQueue.length === 0) return false;
    const oldestWrite = writeQueue[0];
    return Date.now() - oldestWrite.timestamp > QUEUE_MAX_AGE_MS;
  }

  function getQueueStats(): WriteQueueStats {
    return {
      size: writeQueue.length,
      oldestTimestamp: writeQueue.length > 0 ? writeQueue[0].timestamp : null,
      isFull: isQueueFull(),
      isExpired: isQueueExpired(),
    };
  }

  async function triggerFlush() {
    if (writeQueue.length === 0) return;

    const writesToFlush = [...writeQueue];
    log.info(`[degraded-mode] Flushing ${writesToFlush.length} queued writes`);

    for (const callback of flushCallbacks) {
      try {
        await callback(writesToFlush);
      } catch (e) {
        log.error("[degraded-mode] Error in flush callback", e);
      }
    }

    writeQueue.length = 0;
  }

  if (clientManager) {
    clientManager.onStateChange((connectionState: ConnectionState) => {
      if (connectionState === "degraded" || connectionState === "disconnected") {
        if (!state.isActive) {
          state = {
            isActive: true,
            reason: `Connection state: ${connectionState}`,
            enteredAt: new Date(),
            failedOperations: state.failedOperations,
          };
          log.warn(`[degraded-mode] Entered degraded mode: ${state.reason}`);
          notifyStateChange();
        }
      } else if (connectionState === "connected" && state.isActive) {
        consecutiveSuccesses++;
        if (consecutiveSuccesses >= RECOVERY_SUCCESS_THRESHOLD) {
          state = {
            isActive: false,
            reason: null,
            enteredAt: null,
            failedOperations: 0,
          };
          consecutiveSuccesses = 0;
          log.info("[degraded-mode] Exited degraded mode: connection recovered");
          notifyStateChange();
          triggerFlush();
        }
      }
    });
  }

  return {
    getState() {
      return { ...state };
    },

    isActive() {
      return state.isActive;
    },

    enter(reason: string) {
      if (!state.isActive) {
        state = {
          isActive: true,
          reason,
          enteredAt: new Date(),
          failedOperations: state.failedOperations,
        };
        consecutiveSuccesses = 0;
        log.warn(`[degraded-mode] Entered degraded mode: ${reason}`);
        notifyStateChange();
      }
    },

    exit() {
      if (state.isActive) {
        state = {
          isActive: false,
          reason: null,
          enteredAt: null,
          failedOperations: 0,
        };
        consecutiveSuccesses = 0;
        log.info("[degraded-mode] Exited degraded mode");
        notifyStateChange();
      }
    },

    recordFailure() {
      state.failedOperations++;
      consecutiveSuccesses = 0;

      if (!state.isActive && state.failedOperations >= FAILURE_THRESHOLD) {
        state = {
          isActive: true,
          reason: `${state.failedOperations} consecutive failures`,
          enteredAt: new Date(),
          failedOperations: state.failedOperations,
        };
        log.warn(`[degraded-mode] Entered degraded mode: ${state.reason}`);
        notifyStateChange();
      }
    },

    recordSuccess() {
      if (state.isActive) {
        consecutiveSuccesses++;
        if (consecutiveSuccesses >= RECOVERY_SUCCESS_THRESHOLD) {
          state = {
            isActive: false,
            reason: null,
            enteredAt: null,
            failedOperations: 0,
          };
          consecutiveSuccesses = 0;
          log.info("[degraded-mode] Exited degraded mode: operations recovered");
          notifyStateChange();
          triggerFlush();
        }
      } else {
        state.failedOperations = 0;
      }
    },

    shouldUsePostgres() {
      if (!clientManager) return false;
      if (state.isActive) return false;
      return clientManager.getConnectionState() === "connected";
    },

    onStateChange(callback: (state: DegradedModeState) => void) {
      stateCallbacks.add(callback);
      return () => {
        stateCallbacks.delete(callback);
      };
    },

    queueWrite(write: Omit<QueuedWrite, "timestamp">): boolean {
      if (isQueueFull()) {
        log.warn("[degraded-mode] Write queue full, rejecting write", { table: write.table, operation: write.operation });
        return false;
      }

      if (isQueueExpired()) {
        log.warn("[degraded-mode] Write queue expired, clearing and rejecting write", { table: write.table });
        writeQueue.length = 0;
        return false;
      }

      writeQueue.push({ ...write, timestamp: Date.now() });
      log.debug(`[degraded-mode] Queued write: ${write.operation} on ${write.table} (queue size: ${writeQueue.length})`);
      return true;
    },

    getQueuedWrites(): QueuedWrite[] {
      return [...writeQueue];
    },

    clearQueue() {
      const cleared = writeQueue.length;
      writeQueue.length = 0;
      if (cleared > 0) {
        log.info(`[degraded-mode] Cleared ${cleared} queued writes`);
      }
    },

    getQueueStats,

    onQueueFlushNeeded(callback: (writes: QueuedWrite[]) => Promise<void>) {
      flushCallbacks.add(callback);
      return () => {
        flushCallbacks.delete(callback);
      };
    },
  };
}
