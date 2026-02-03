import type { PostgresConfig } from "../config.js";
import { createSupabaseClientManager, type SupabaseClientManager } from "./postgres/supabase-client.js";
import { createInstanceRegistry, type InstanceRegistry } from "./postgres/instance-registry.js";
import { createDegradedModeManager, type DegradedModeManager } from "./postgres/degraded-mode.js";
import { log } from "../logger.js";

export type MigrationPhase = "1" | "2" | "3";

export type UnifiedStoreOptions = {
  postgresConfig: PostgresConfig;
};

export type UnifiedStore = {
  initialize: () => Promise<void>;
  shutdown: () => Promise<void>;
  getInstanceId: () => string;
  isLeader: () => boolean;
  getMigrationPhase: () => MigrationPhase;
  shouldWriteToPostgres: () => boolean;
  shouldReadFromPostgres: () => boolean;
  shouldWriteToJson: () => boolean;
  getClientManager: () => SupabaseClientManager | null;
  getInstanceRegistry: () => InstanceRegistry | null;
  getDegradedModeManager: () => DegradedModeManager;
  onLeadershipChange: (callback: (isLeader: boolean) => void) => () => void;
};

export function createUnifiedStore(options: UnifiedStoreOptions): UnifiedStore {
  const { postgresConfig } = options;
  const migrationPhase = postgresConfig.migrationPhase;

  let clientManager: SupabaseClientManager | null = null;
  let instanceRegistry: InstanceRegistry | null = null;
  let degradedModeManager: DegradedModeManager;
  let initialized = false;

  if (postgresConfig.enabled) {
    clientManager = createSupabaseClientManager(postgresConfig);
    if (clientManager) {
      instanceRegistry = createInstanceRegistry(clientManager, postgresConfig);
    }
  }

  degradedModeManager = createDegradedModeManager(clientManager);

  function shouldWriteToPostgres(): boolean {
    if (!postgresConfig.enabled || !clientManager) return false;
    if (degradedModeManager.isActive()) return false;

    switch (migrationPhase) {
      case "1":
      case "2":
      case "3":
        return true;
      default:
        return false;
    }
  }

  function shouldReadFromPostgres(): boolean {
    if (!postgresConfig.enabled || !clientManager) return false;
    if (degradedModeManager.isActive()) return false;

    switch (migrationPhase) {
      case "1":
        return false;
      case "2":
      case "3":
        return true;
      default:
        return false;
    }
  }

  function shouldWriteToJson(): boolean {
    switch (migrationPhase) {
      case "1":
      case "2":
        return true;
      case "3":
        return degradedModeManager.isActive();
      default:
        return true;
    }
  }

  return {
    async initialize() {
      if (initialized) return;

      if (postgresConfig.enabled) {
        log.info(`[unified-store] Initializing with Postgres (phase ${migrationPhase})`);

        if (instanceRegistry) {
          await instanceRegistry.start();
        }
      } else {
        log.info("[unified-store] Postgres disabled, using JSON-only mode");
      }

      initialized = true;
    },

    async shutdown() {
      if (!initialized) return;

      if (instanceRegistry) {
        await instanceRegistry.stop();
      }

      if (clientManager) {
        await clientManager.disconnect();
      }

      initialized = false;
      log.info("[unified-store] Shutdown complete");
    },

    getInstanceId() {
      return instanceRegistry?.getInstanceId() || "local";
    },

    isLeader() {
      if (!instanceRegistry) return true;
      return instanceRegistry.isLeader();
    },

    getMigrationPhase() {
      return migrationPhase;
    },

    shouldWriteToPostgres,
    shouldReadFromPostgres,
    shouldWriteToJson,

    getClientManager() {
      return clientManager;
    },

    getInstanceRegistry() {
      return instanceRegistry;
    },

    getDegradedModeManager() {
      return degradedModeManager;
    },

    onLeadershipChange(callback: (isLeader: boolean) => void) {
      if (!instanceRegistry) {
        callback(true);
        return () => {};
      }
      return instanceRegistry.onLeadershipChange(callback);
    },
  };
}
