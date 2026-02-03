import type { RealtimeChannel, RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import type { SupabaseClientManager } from "./supabase-client.js";
import { ThreadMappingSchema, type ThreadMapping } from "./schema.js";
import { log } from "../../logger.js";

export type RealtimeEventType = "INSERT" | "UPDATE" | "DELETE";

export type ThreadMappingChangeEvent = {
  eventType: RealtimeEventType;
  old: ThreadMapping | null;
  new: ThreadMapping | null;
  timestamp: Date;
};

export type RealtimeSyncOptions = {
  clientManager: SupabaseClientManager;
  instanceId: string;
  onThreadMappingChange?: (event: ThreadMappingChangeEvent) => void;
  pollingIntervalMs?: number;
};

export type RealtimeSync = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  isConnected: () => boolean;
  isPolling: () => boolean;
};

const DEFAULT_POLLING_INTERVAL_MS = 5000;
const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_ATTEMPTS = 10;

export function createRealtimeSync(options: RealtimeSyncOptions): RealtimeSync {
  const {
    clientManager,
    instanceId,
    onThreadMappingChange,
    pollingIntervalMs = DEFAULT_POLLING_INTERVAL_MS,
  } = options;

  let threadMappingChannel: RealtimeChannel | null = null;
  let isConnected = false;
  let pollingTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectAttempts = 0;
  let stopped = false;
  let lastKnownUpdatedAt: Date | null = null;

  async function subscribeToThreadMappings(): Promise<void> {
    if (stopped) return;

    const { client } = clientManager;

    threadMappingChannel = client
      .channel("thread_mappings_changes")
      .on<ThreadMapping>(
        "postgres_changes",
        {
          event: "*",
          schema: "opencode_mm_plugin",
          table: "thread_mappings",
        },
        (payload: RealtimePostgresChangesPayload<ThreadMapping>) => {
          handleThreadMappingChange(payload);
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          log.info(`[realtime-sync] Connected to thread_mappings Realtime channel`);
          isConnected = true;
          reconnectAttempts = 0;
          stopPolling();
        } else if (status === "CLOSED" || status === "CHANNEL_ERROR") {
          log.warn(`[realtime-sync] Thread mappings channel ${status}, starting fallback polling`);
          isConnected = false;
          startPolling();
          scheduleReconnect();
        }
      });
  }

  function handleThreadMappingChange(payload: RealtimePostgresChangesPayload<ThreadMapping>): void {
    if (!onThreadMappingChange) return;

    try {
      const eventType = payload.eventType as RealtimeEventType;
      let oldRecord: ThreadMapping | null = null;
      let newRecord: ThreadMapping | null = null;

      if (payload.old && Object.keys(payload.old).length > 0) {
        const parsed = ThreadMappingSchema.safeParse(payload.old);
        if (parsed.success) {
          oldRecord = parsed.data;
        }
      }

      if (payload.new && Object.keys(payload.new).length > 0) {
        const parsed = ThreadMappingSchema.safeParse(payload.new);
        if (parsed.success) {
          newRecord = parsed.data;
        }
      }

      const event: ThreadMappingChangeEvent = {
        eventType,
        old: oldRecord,
        new: newRecord,
        timestamp: new Date(),
      };

      log.debug(
        `[realtime-sync] Thread mapping ${eventType}: session=${newRecord?.opencode_session_id || oldRecord?.opencode_session_id}`
      );

      onThreadMappingChange(event);
    } catch (e) {
      log.error("[realtime-sync] Error processing thread mapping change:", e);
    }
  }

  function startPolling(): void {
    if (pollingTimer || stopped) return;

    log.info(`[realtime-sync] Starting fallback polling every ${pollingIntervalMs}ms`);

    pollingTimer = setInterval(async () => {
      await pollForChanges();
    }, pollingIntervalMs);
  }

  function stopPolling(): void {
    if (pollingTimer) {
      log.info("[realtime-sync] Stopping fallback polling (Realtime reconnected)");
      clearInterval(pollingTimer);
      pollingTimer = null;
    }
  }

  async function pollForChanges(): Promise<void> {
    if (!onThreadMappingChange) return;

    try {
      const { client } = clientManager;
      let query = client.from("thread_mappings").select("*").order("updated_at", { ascending: false });

      if (lastKnownUpdatedAt) {
        query = query.gt("updated_at", lastKnownUpdatedAt.toISOString());
      }

      const { data, error } = await query.limit(100);

      if (error) {
        log.error("[realtime-sync] Polling error:", error);
        return;
      }

      if (!data || data.length === 0) return;

      for (const row of data) {
        const parsed = ThreadMappingSchema.safeParse(row);
        if (!parsed.success) continue;

        const record = parsed.data;
        const event: ThreadMappingChangeEvent = {
          eventType: "UPDATE",
          old: null,
          new: record,
          timestamp: new Date(record.updated_at),
        };

        onThreadMappingChange(event);

        if (!lastKnownUpdatedAt || record.updated_at > lastKnownUpdatedAt) {
          lastKnownUpdatedAt = record.updated_at;
        }
      }

      log.debug(`[realtime-sync] Polled ${data.length} updated thread mappings`);
    } catch (e) {
      log.error("[realtime-sync] Polling exception:", e);
    }
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        log.error(
          `[realtime-sync] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached, staying in polling mode`
        );
      }
      return;
    }

    reconnectAttempts++;
    const delay = RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts - 1);

    log.info(`[realtime-sync] Scheduling reconnect attempt ${reconnectAttempts} in ${delay}ms`);

    setTimeout(async () => {
      if (stopped || isConnected) return;

      try {
        await unsubscribeFromChannel();
        await subscribeToThreadMappings();
      } catch (e) {
        log.error("[realtime-sync] Reconnect failed:", e);
        scheduleReconnect();
      }
    }, delay);
  }

  async function unsubscribeFromChannel(): Promise<void> {
    if (threadMappingChannel) {
      await threadMappingChannel.unsubscribe();
      threadMappingChannel = null;
    }
  }

  return {
    async start() {
      stopped = false;
      log.info(`[realtime-sync] Starting Realtime sync for instance ${instanceId}`);

      try {
        await subscribeToThreadMappings();
      } catch (e) {
        log.error("[realtime-sync] Failed to start Realtime subscription, falling back to polling:", e);
        startPolling();
      }
    },

    async stop() {
      stopped = true;
      log.info("[realtime-sync] Stopping Realtime sync");

      stopPolling();
      await unsubscribeFromChannel();
      isConnected = false;
    },

    isConnected() {
      return isConnected;
    },

    isPolling() {
      return pollingTimer !== null;
    },
  };
}
