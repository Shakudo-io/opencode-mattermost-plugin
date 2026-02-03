import { describe, test, expect, beforeEach, mock } from "bun:test";
import { createUnifiedStore, type UnifiedStore } from "../../src/persistence/unified-store.js";
import type { PostgresConfig } from "../../src/config.js";

mock.module("../../src/persistence/postgres/supabase-client.js", () => ({
  createSupabaseClientManager: () => null,
}));

mock.module("../../src/persistence/postgres/instance-registry.js", () => ({
  createInstanceRegistry: () => null,
}));

mock.module("../../src/persistence/postgres/degraded-mode.js", () => ({
  createDegradedModeManager: () => ({
    isActive: () => false,
    queueWrite: () => {},
    flush: async () => {},
  }),
}));

describe("createUnifiedStore", () => {
  const baseConfig: PostgresConfig = {
    enabled: false,
    migrationPhase: "1",
    heartbeatInterval: 30000,
    deadInstanceTimeout: 90000,
    claimDuration: 60000,
  };

  describe("postgres disabled", () => {
    let store: UnifiedStore;

    beforeEach(() => {
      store = createUnifiedStore({ postgresConfig: baseConfig });
    });

    test("isPostgresEnabled returns false", () => {
      expect(store.isPostgresEnabled()).toBe(false);
    });

    test("shouldWriteToPostgres returns false", () => {
      expect(store.shouldWriteToPostgres()).toBe(false);
    });

    test("shouldReadFromPostgres returns false", () => {
      expect(store.shouldReadFromPostgres()).toBe(false);
    });

    test("shouldWriteToJson returns true in phase 1", () => {
      expect(store.shouldWriteToJson()).toBe(true);
    });

    test("getInstanceId returns local", () => {
      expect(store.getInstanceId()).toBe("local");
    });

    test("isLeader returns true without registry", () => {
      expect(store.isLeader()).toBe(true);
    });

    test("getMigrationPhase returns configured phase", () => {
      expect(store.getMigrationPhase()).toBe("1");
    });

    test("getClientManager returns null", () => {
      expect(store.getClientManager()).toBeNull();
    });

    test("getInstanceRegistry returns null", () => {
      expect(store.getInstanceRegistry()).toBeNull();
    });
  });

  describe("migration phase logic", () => {
    test("phase 1: write to JSON, not read from Postgres", () => {
      const store = createUnifiedStore({
        postgresConfig: { ...baseConfig, migrationPhase: "1" },
      });
      
      expect(store.getMigrationPhase()).toBe("1");
      expect(store.shouldWriteToJson()).toBe(true);
    });

    test("phase 2: write to JSON", () => {
      const store = createUnifiedStore({
        postgresConfig: { ...baseConfig, migrationPhase: "2" },
      });
      
      expect(store.getMigrationPhase()).toBe("2");
      expect(store.shouldWriteToJson()).toBe(true);
    });

    test("phase 3: no JSON writes when degraded mode inactive", () => {
      const store = createUnifiedStore({
        postgresConfig: { ...baseConfig, migrationPhase: "3" },
      });
      
      expect(store.getMigrationPhase()).toBe("3");
      expect(store.shouldWriteToJson()).toBe(false);
    });
  });

  describe("leadership callback", () => {
    test("calls callback immediately with true when no registry", () => {
      const store = createUnifiedStore({ postgresConfig: baseConfig });
      
      let callbackCalled = false;
      let callbackValue: boolean | null = null;
      
      store.onLeadershipChange((isLeader) => {
        callbackCalled = true;
        callbackValue = isLeader;
      });
      
      expect(callbackCalled).toBe(true);
      expect(callbackValue).toBe(true);
    });

    test("returns cleanup function", () => {
      const store = createUnifiedStore({ postgresConfig: baseConfig });
      const cleanup = store.onLeadershipChange(() => {});
      
      expect(typeof cleanup).toBe("function");
    });
  });
});
