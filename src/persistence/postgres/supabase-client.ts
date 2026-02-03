import { createClient, SupabaseClient, PostgrestError } from "@supabase/supabase-js";
import type { PostgresConfig } from "../../config.js";
import { log } from "../../logger.js";

// Use any for the database type to avoid schema type conflicts
// The actual schema is set in createClient options
type SupabaseClientAny = SupabaseClient<any, any, any>;

export type SupabaseClientManager = {
  client: SupabaseClientAny;
  isHealthy: () => Promise<boolean>;
  getConnectionState: () => ConnectionState;
  disconnect: () => Promise<void>;
  reconnect: () => Promise<boolean>;
  onStateChange: (callback: (state: ConnectionState) => void) => () => void;
  startHealthMonitor: () => void;
  stopHealthMonitor: () => void;
};

export type ConnectionState = "connected" | "disconnected" | "reconnecting" | "degraded";

type StateChangeCallback = (state: ConnectionState) => void;

const SCHEMA = "opencode_mm_plugin";
const HEALTH_CHECK_QUERY = "SELECT 1 as health";
const RECONNECT_DELAY_BASE = 1000;
const MAX_RECONNECT_DELAY = 30000;
const HEALTH_CHECK_INTERVAL_MS = 30000; // 30 seconds

export function createSupabaseClientManager(config: PostgresConfig): SupabaseClientManager | null {
  if (!config.enabled) {
    log.info("[supabase-client] Postgres is disabled");
    return null;
  }

  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    log.error("[supabase-client] Missing OPENCODE_MM_SUPABASE_URL or OPENCODE_MM_SUPABASE_ANON_KEY");
    return null;
  }

  let state: ConnectionState = "disconnected";
  const stateCallbacks: Set<StateChangeCallback> = new Set();
  let reconnectAttempts = 0;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let healthMonitorTimer: NodeJS.Timeout | null = null;

  const client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    db: {
      schema: SCHEMA,
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    realtime: {
      params: {
        eventsPerSecond: 10,
      },
    },
  });

  function setState(newState: ConnectionState) {
    if (state !== newState) {
      const oldState = state;
      state = newState;
      log.info(`[supabase-client] State changed: ${oldState} -> ${newState}`);
      for (const cb of stateCallbacks) {
        try {
          cb(newState);
        } catch (e) {
          log.error("[supabase-client] Error in state change callback", e);
        }
      }
    }
  }

  async function checkHealth(): Promise<boolean> {
    try {
      const { error } = await client.rpc("", { sql: HEALTH_CHECK_QUERY }).single();
      if (error && error.code !== "PGRST202") {
        const { data, error: selectError } = await client
          .from("instances")
          .select("instance_id")
          .limit(1);
        if (selectError) {
          log.warn("[supabase-client] Health check failed", selectError);
          return false;
        }
      }
      return true;
    } catch (e) {
      log.warn("[supabase-client] Health check exception", e);
      return false;
    }
  }

  async function reconnect(): Promise<boolean> {
    if (state === "reconnecting") {
      return false;
    }

    setState("reconnecting");
    reconnectAttempts++;

    const healthy = await checkHealth();
    if (healthy) {
      setState("connected");
      reconnectAttempts = 0;
      log.info("[supabase-client] Reconnected successfully");
      return true;
    }

    const delay = Math.min(RECONNECT_DELAY_BASE * Math.pow(2, reconnectAttempts - 1), MAX_RECONNECT_DELAY);
    log.warn(`[supabase-client] Reconnect failed, retry in ${delay}ms (attempt ${reconnectAttempts})`);

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }

    reconnectTimer = setTimeout(() => {
      reconnect();
    }, delay);

    setState("degraded");
    return false;
  }

  async function disconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    if (healthMonitorTimer) {
      clearInterval(healthMonitorTimer);
      healthMonitorTimer = null;
    }

    await client.removeAllChannels();
    setState("disconnected");
    log.info("[supabase-client] Disconnected");
  }

  function startHealthMonitor() {
    if (healthMonitorTimer) {
      return; // Already running
    }

    log.info(`[supabase-client] Starting health monitor (every ${HEALTH_CHECK_INTERVAL_MS / 1000}s)`);

    healthMonitorTimer = setInterval(async () => {
      if (state === "reconnecting") {
        return; // Skip health check during reconnection
      }

      const healthy = await checkHealth();
      if (state === "connected" && !healthy) {
        log.warn("[supabase-client] Health check failed, triggering reconnect");
        setState("degraded");
        reconnect();
      } else if (state === "degraded" && healthy) {
        log.info("[supabase-client] Health check passed in degraded mode, recovering");
        setState("connected");
        reconnectAttempts = 0;
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  function stopHealthMonitor() {
    if (healthMonitorTimer) {
      clearInterval(healthMonitorTimer);
      healthMonitorTimer = null;
      log.info("[supabase-client] Stopped health monitor");
    }
  }

  checkHealth().then((healthy) => {
    if (healthy) {
      setState("connected");
      log.info("[supabase-client] Initial connection successful");
    } else {
      setState("degraded");
      log.warn("[supabase-client] Initial connection failed, entering degraded mode");
    }
  });

  return {
    client,

    isHealthy: async () => {
      if (state === "connected") {
        const healthy = await checkHealth();
        if (!healthy) {
          setState("degraded");
          reconnect();
        }
        return healthy;
      }
      return false;
    },

    getConnectionState: () => state,

    disconnect,

    reconnect,

    onStateChange: (callback: StateChangeCallback) => {
      stateCallbacks.add(callback);
      return () => {
        stateCallbacks.delete(callback);
      };
    },

    startHealthMonitor,
    stopHealthMonitor,
  };
}

export function handlePostgrestError(error: PostgrestError | null, operation: string): void {
  if (!error) return;

  log.error(`[supabase-client] ${operation} failed`, {
    code: error.code,
    message: error.message,
    details: error.details,
    hint: error.hint,
  });
}

export function isRetryableError(error: PostgrestError | null): boolean {
  if (!error) return false;

  const retryableCodes = [
    "08000", // connection_exception
    "08003", // connection_does_not_exist
    "08006", // connection_failure
    "08001", // sqlclient_unable_to_establish_sqlconnection
    "08004", // sqlserver_rejected_establishment_of_sqlconnection
    "57P01", // admin_shutdown
    "57P02", // crash_shutdown
    "57P03", // cannot_connect_now
    "40001", // serialization_failure (retry)
    "40P01", // deadlock_detected (retry)
  ];

  return retryableCodes.includes(error.code);
}
