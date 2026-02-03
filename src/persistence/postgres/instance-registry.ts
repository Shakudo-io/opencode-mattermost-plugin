import type { SupabaseClientManager } from "./supabase-client.js";
import type { PostgresConfig } from "../../config.js";
import { handlePostgrestError, isRetryableError } from "./supabase-client.js";
import { InstanceSchema, InstanceInsertSchema, type Instance, type InstanceInsert, type InstanceStatus } from "./schema.js";
import { log } from "../../logger.js";
import { randomUUID } from "crypto";
import { hostname } from "os";

const LEADER_LOCK_ID = 42;

export type InstanceRegistry = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  getInstanceId: () => string;
  isLeader: () => boolean;
  getActiveInstances: () => Promise<Instance[]>;
  onLeadershipChange: (callback: (isLeader: boolean) => void) => () => void;
};

export function createInstanceRegistry(
  clientManager: SupabaseClientManager,
  config: PostgresConfig
): InstanceRegistry {
  const instanceId = config.instanceId || `instance-${randomUUID().slice(0, 8)}`;
  const heartbeatInterval = config.heartbeatInterval;
  const deadInstanceTimeout = config.deadInstanceTimeout;

  let heartbeatTimer: NodeJS.Timeout | null = null;
  let deadCheckTimer: NodeJS.Timeout | null = null;
  let currentIsLeader = false;
  let running = false;
  const leadershipCallbacks: Set<(isLeader: boolean) => void> = new Set();

  function notifyLeadershipChange(isLeader: boolean) {
    if (currentIsLeader !== isLeader) {
      currentIsLeader = isLeader;
      log.info(`[instance-registry] Leadership changed: ${isLeader ? "acquired" : "lost"}`);
      for (const cb of leadershipCallbacks) {
        try {
          cb(isLeader);
        } catch (e) {
          log.error("[instance-registry] Error in leadership callback", e);
        }
      }
    }
  }

  async function registerInstance(): Promise<boolean> {
    const client = clientManager.client;
    const insert: InstanceInsert = {
      instance_id: instanceId,
      hostname: hostname(),
      status: "active",
      is_leader: false,
      version: process.env.npm_package_version || "unknown",
      metadata: {
        pid: process.pid,
        node_version: process.version,
      },
    };

    const { error } = await client
      .from("instances")
      .upsert(insert, { onConflict: "instance_id" });

    if (error) {
      handlePostgrestError(error, "registerInstance");
      return false;
    }

    log.info(`[instance-registry] Registered instance: ${instanceId}`);
    return true;
  }

  async function sendHeartbeat(): Promise<boolean> {
    const client = clientManager.client;

    const { error } = await client
      .from("instances")
      .update({
        last_heartbeat: new Date().toISOString(),
        status: "active",
      })
      .eq("instance_id", instanceId);

    if (error) {
      handlePostgrestError(error, "sendHeartbeat");
      return false;
    }

    return true;
  }

  async function tryAcquireLeadership(): Promise<boolean> {
    const client = clientManager.client;

    const { data, error } = await client
      .rpc("pg_try_advisory_lock", { lock_id: LEADER_LOCK_ID });

    if (error) {
      log.warn("[instance-registry] Failed to try advisory lock", error);
      return false;
    }

    const acquired = data === true;

    if (acquired) {
      const { error: updateError } = await client
        .from("instances")
        .update({ is_leader: true })
        .eq("instance_id", instanceId);

      if (updateError) {
        handlePostgrestError(updateError, "updateLeaderStatus");
      }
    }

    return acquired;
  }

  async function releaseLeadership(): Promise<void> {
    if (!currentIsLeader) return;

    const client = clientManager.client;

    await client.rpc("pg_advisory_unlock", { lock_id: LEADER_LOCK_ID });

    const { error } = await client
      .from("instances")
      .update({ is_leader: false })
      .eq("instance_id", instanceId);

    if (error) {
      handlePostgrestError(error, "releaseLeadership");
    }

    notifyLeadershipChange(false);
  }

  async function markDeadInstances(): Promise<number> {
    const client = clientManager.client;
    const threshold = new Date(Date.now() - deadInstanceTimeout).toISOString();

    const { data, error } = await client
      .from("instances")
      .update({ status: "dead", is_leader: false })
      .eq("status", "active")
      .lt("last_heartbeat", threshold)
      .select("instance_id");

    if (error) {
      handlePostgrestError(error, "markDeadInstances");
      return 0;
    }

    const count = data?.length || 0;
    if (count > 0) {
      const ids = data?.map((d) => d.instance_id).join(", ");
      log.info(`[instance-registry] Marked ${count} dead instances: ${ids}`);
    }

    return count;
  }

  async function releaseClaimsFromDeadInstances(): Promise<number> {
    const client = clientManager.client;

    const { data: deadInstances, error: fetchError } = await client
      .from("instances")
      .select("instance_id")
      .eq("status", "dead");

    if (fetchError || !deadInstances?.length) {
      return 0;
    }

    const deadIds = deadInstances.map((d) => d.instance_id);

    const { data, error } = await client
      .from("thread_mappings")
      .update({ claimed_by: null, claimed_until: null })
      .in("claimed_by", deadIds)
      .select("id");

    if (error) {
      handlePostgrestError(error, "releaseClaimsFromDeadInstances");
      return 0;
    }

    const count = data?.length || 0;
    if (count > 0) {
      log.info(`[instance-registry] Released ${count} thread claims from dead instances`);
    }

    return count;
  }

  async function unregisterInstance(): Promise<void> {
    const client = clientManager.client;

    const { error } = await client
      .from("instances")
      .update({ status: "draining" })
      .eq("instance_id", instanceId);

    if (error) {
      handlePostgrestError(error, "unregisterInstance");
    }

    log.info(`[instance-registry] Unregistered instance: ${instanceId}`);
  }

  async function heartbeatLoop() {
    if (!running) return;

    const healthy = await sendHeartbeat();

    if (healthy && !currentIsLeader) {
      const acquired = await tryAcquireLeadership();
      notifyLeadershipChange(acquired);
    }

    heartbeatTimer = setTimeout(heartbeatLoop, heartbeatInterval);
  }

  async function deadCheckLoop() {
    if (!running) return;

    if (currentIsLeader) {
      await markDeadInstances();
      await releaseClaimsFromDeadInstances();
    }

    deadCheckTimer = setTimeout(deadCheckLoop, heartbeatInterval);
  }

  return {
    async start() {
      if (running) return;
      running = true;

      const registered = await registerInstance();
      if (!registered) {
        log.warn("[instance-registry] Failed to register, will retry on heartbeat");
      }

      heartbeatLoop();
      deadCheckLoop();

      log.info(`[instance-registry] Started with ID: ${instanceId}`);
    },

    async stop() {
      running = false;

      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }

      if (deadCheckTimer) {
        clearTimeout(deadCheckTimer);
        deadCheckTimer = null;
      }

      await releaseLeadership();
      await unregisterInstance();

      log.info(`[instance-registry] Stopped`);
    },

    getInstanceId() {
      return instanceId;
    },

    isLeader() {
      return currentIsLeader;
    },

    async getActiveInstances(): Promise<Instance[]> {
      const client = clientManager.client;

      const { data, error } = await client
        .from("instances")
        .select("*")
        .eq("status", "active")
        .order("started_at", { ascending: false });

      if (error) {
        handlePostgrestError(error, "getActiveInstances");
        return [];
      }

      return (data || []).map((row) => {
        const parsed = InstanceSchema.safeParse(row);
        return parsed.success ? parsed.data : null;
      }).filter((i): i is Instance => i !== null);
    },

    onLeadershipChange(callback: (isLeader: boolean) => void) {
      leadershipCallbacks.add(callback);
      return () => {
        leadershipCallbacks.delete(callback);
      };
    },
  };
}
