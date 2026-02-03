import type { SupabaseClientManager, ConnectionState } from "./supabase-client.js";
import { log } from "../../logger.js";

export type DegradedModeState = {
  isActive: boolean;
  reason: string | null;
  enteredAt: Date | null;
  failedOperations: number;
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
};

const FAILURE_THRESHOLD = 3;
const RECOVERY_SUCCESS_THRESHOLD = 5;

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

  function notifyStateChange() {
    for (const cb of stateCallbacks) {
      try {
        cb({ ...state });
      } catch (e) {
        log.error("[degraded-mode] Error in state callback", e);
      }
    }
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
  };
}
