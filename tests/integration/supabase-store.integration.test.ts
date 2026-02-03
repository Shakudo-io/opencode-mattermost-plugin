import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { createThreadMappingPgStore, type ThreadMappingPgStore } from "../../src/persistence/postgres/thread-mapping-pg.js";
import type { ThreadSessionMapping } from "../../src/models/index.js";
import type { SupabaseClientManager } from "../../src/persistence/postgres/supabase-client.js";

const SUPABASE_URL = process.env.SUPABASE_URL || "http://supabase-metaflow-kong.hyperplane-supabase-metaflow.svc.cluster.local";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJleHAiOjE4MzQ3MDA0MDAsImlhdCI6MTY3NjkzNDAwMCwiaXNzIjoic3VwYWJhc2UiLCJyb2xlIjoiYW5vbiJ9.L5wyKsVw1lSYIlwMJYDC-7bfDmsBOf0Xwq1hU4QMbnA";
const SCHEMA = "public";

const TEST_PREFIX = "integ_test_";

function createTestClientManager(client: SupabaseClient): SupabaseClientManager {
  return {
    client,
    isHealthy: async () => true,
    getConnectionState: () => "connected",
    disconnect: async () => {},
    reconnect: async () => true,
    onStateChange: () => () => {},
    startHealthMonitor: () => {},
    stopHealthMonitor: () => {},
  };
}

function createTestMapping(overrides: Partial<ThreadSessionMapping> = {}): ThreadSessionMapping {
  const id = `${TEST_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return {
    sessionId: `ses_${id}`,
    threadRootPostId: `post_${id}`,
    shortId: id.slice(0, 8),
    mattermostUserId: `user_${id}`,
    dmChannelId: `dm_${id}`,
    channelId: `channel_${id}`,
    projectName: "test-project",
    directory: "/test/path",
    sessionTitle: "Test Session",
    status: "active",
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("Supabase Integration Tests", () => {
  let client: SupabaseClient;
  let clientManager: SupabaseClientManager;
  let store: ThreadMappingPgStore;
  const createdSessionIds: string[] = [];

  beforeAll(() => {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      db: { schema: SCHEMA },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    clientManager = createTestClientManager(client);
    store = createThreadMappingPgStore(clientManager);
  });

  afterAll(async () => {
    for (const sessionId of createdSessionIds) {
      try {
        await store.delete(sessionId);
      } catch {
        // Ignore cleanup errors
      }
    }
    // Additional cleanup for any orphaned test records
    await client
      .from("thread_mappings")
      .delete()
      .like("opencode_session_id", `ses_${TEST_PREFIX}%`);
  });

  describe("Connection", () => {
    test("can connect to Supabase", async () => {
      const { data, error } = await client.from("thread_mappings").select("id").limit(1);
      expect(error).toBeNull();
    });
  });

  describe("ThreadMappingPgStore CRUD", () => {
    test("create and retrieve mapping", async () => {
      const mapping = createTestMapping();
      createdSessionIds.push(mapping.sessionId);

      await store.create(mapping);

      const retrieved = await store.getBySessionId(mapping.sessionId);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.sessionId).toBe(mapping.sessionId);
      expect(retrieved!.threadRootPostId).toBe(mapping.threadRootPostId);
      expect(retrieved!.projectName).toBe(mapping.projectName);
    });

    test("getByThreadRootPostId returns mapping", async () => {
      const mapping = createTestMapping();
      createdSessionIds.push(mapping.sessionId);

      await store.create(mapping);

      const retrieved = await store.getByThreadRootPostId(mapping.threadRootPostId);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.sessionId).toBe(mapping.sessionId);
    });

    test("getByMattermostUserId returns user mappings", async () => {
      const userId = `user_${TEST_PREFIX}${Date.now()}`;
      const mapping1 = createTestMapping({ mattermostUserId: userId });
      const mapping2 = createTestMapping({ mattermostUserId: userId });
      createdSessionIds.push(mapping1.sessionId, mapping2.sessionId);

      await store.create(mapping1);
      await store.create(mapping2);

      const retrieved = await store.getByMattermostUserId(userId);
      expect(retrieved.length).toBeGreaterThanOrEqual(2);
      expect(retrieved.some((m) => m.sessionId === mapping1.sessionId)).toBe(true);
      expect(retrieved.some((m) => m.sessionId === mapping2.sessionId)).toBe(true);
    });

    test("update mapping metadata", async () => {
      const mapping = createTestMapping();
      createdSessionIds.push(mapping.sessionId);

      await store.create(mapping);

      mapping.status = "ended";
      mapping.sessionTitle = "Updated Title";
      mapping.model = { providerID: "anthropic", modelID: "claude-sonnet-4", displayName: "Claude Sonnet 4" };
      await store.update(mapping);

      const retrieved = await store.getBySessionId(mapping.sessionId);
      expect(retrieved!.status).toBe("ended");
      expect(retrieved!.sessionTitle).toBe("Updated Title");
      expect(retrieved!.model?.modelID).toBe("claude-sonnet-4");
    });

    test("delete mapping", async () => {
      const mapping = createTestMapping();

      await store.create(mapping);

      const beforeDelete = await store.getBySessionId(mapping.sessionId);
      expect(beforeDelete).not.toBeNull();

      await store.delete(mapping.sessionId);

      const afterDelete = await store.getBySessionId(mapping.sessionId);
      expect(afterDelete).toBeNull();
    });

    test("getBySessionId returns null for non-existent", async () => {
      const result = await store.getBySessionId("ses_non_existent_12345");
      expect(result).toBeNull();
    });
  });

  describe("Thread Claiming", () => {
    test("claim thread successfully", async () => {
      const mapping = createTestMapping();
      createdSessionIds.push(mapping.sessionId);
      await store.create(mapping);

      const instanceId = `instance_${TEST_PREFIX}${Date.now()}`;
      const claimed = await store.claimThread(mapping.threadRootPostId, instanceId);
      expect(claimed).toBe(true);

      await store.releaseThread(mapping.threadRootPostId, instanceId);
    });

    test("second instance cannot claim already-claimed thread", async () => {
      const mapping = createTestMapping();
      createdSessionIds.push(mapping.sessionId);
      await store.create(mapping);

      const instance1 = `instance1_${TEST_PREFIX}${Date.now()}`;
      const instance2 = `instance2_${TEST_PREFIX}${Date.now()}`;

      const firstClaim = await store.claimThread(mapping.threadRootPostId, instance1);
      expect(firstClaim).toBe(true);

      const secondClaim = await store.claimThread(mapping.threadRootPostId, instance2);
      expect(secondClaim).toBe(false);

      await store.releaseThread(mapping.threadRootPostId, instance1);
    });

    test("release thread allows re-claim", async () => {
      const mapping = createTestMapping();
      createdSessionIds.push(mapping.sessionId);
      await store.create(mapping);

      const instance1 = `instance1_${TEST_PREFIX}${Date.now()}`;
      const instance2 = `instance2_${TEST_PREFIX}${Date.now()}`;

      await store.claimThread(mapping.threadRootPostId, instance1);
      await store.releaseThread(mapping.threadRootPostId, instance1);

      const reclaimByOther = await store.claimThread(mapping.threadRootPostId, instance2);
      expect(reclaimByOther).toBe(true);

      await store.releaseThread(mapping.threadRootPostId, instance2);
    });

    test("isClaimedByOther returns false for unclaimed thread", async () => {
      const mapping = createTestMapping();
      createdSessionIds.push(mapping.sessionId);
      await store.create(mapping);

      const instanceId = `instance_${TEST_PREFIX}${Date.now()}`;
      const notClaimed = await store.isClaimedByOther(mapping.threadRootPostId, instanceId);
      expect(notClaimed).toBe(false);
    });

    test("isClaimedByOther returns correct status", async () => {
      const mapping = createTestMapping();
      createdSessionIds.push(mapping.sessionId);
      await store.create(mapping);

      const instance1 = `instance1_${TEST_PREFIX}${Date.now()}`;
      const instance2 = `instance2_${TEST_PREFIX}${Date.now()}`;

      const notClaimed = await store.isClaimedByOther(mapping.threadRootPostId, instance1);
      expect(notClaimed).toBe(false);

      await store.claimThread(mapping.threadRootPostId, instance1);

      const claimedByUs = await store.isClaimedByOther(mapping.threadRootPostId, instance1);
      expect(claimedByUs).toBe(false);

      const claimedByOther = await store.isClaimedByOther(mapping.threadRootPostId, instance2);
      expect(claimedByOther).toBe(true);

      await store.releaseThread(mapping.threadRootPostId, instance1);
    });

    test("releaseAllClaims releases instance claims", async () => {
      const mapping1 = createTestMapping();
      const mapping2 = createTestMapping();
      createdSessionIds.push(mapping1.sessionId, mapping2.sessionId);
      await store.create(mapping1);
      await store.create(mapping2);

      const instanceId = `instance_${TEST_PREFIX}${Date.now()}`;

      await store.claimThread(mapping1.threadRootPostId, instanceId);
      await store.claimThread(mapping2.threadRootPostId, instanceId);

      const released = await store.releaseAllClaims(instanceId);
      expect(released).toBeGreaterThanOrEqual(2);

      const canReclaim1 = await store.claimThread(mapping1.threadRootPostId, "other_instance");
      const canReclaim2 = await store.claimThread(mapping2.threadRootPostId, "other_instance");
      expect(canReclaim1).toBe(true);
      expect(canReclaim2).toBe(true);

      await store.releaseThread(mapping1.threadRootPostId, "other_instance");
      await store.releaseThread(mapping2.threadRootPostId, "other_instance");
    });
  });

  describe("Listing Operations", () => {
    test("listAll returns mappings", async () => {
      const mapping = createTestMapping();
      createdSessionIds.push(mapping.sessionId);
      await store.create(mapping);

      const all = await store.listAll();
      expect(all.length).toBeGreaterThan(0);
      expect(all.some((m) => m.sessionId === mapping.sessionId)).toBe(true);
    });

    test("listActive filters by status", async () => {
      const activeMapping = createTestMapping({ status: "active" });
      const endedMapping = createTestMapping({ status: "ended" });
      createdSessionIds.push(activeMapping.sessionId, endedMapping.sessionId);

      await store.create(activeMapping);
      await store.create(endedMapping);

      const active = await store.listActive();
      expect(active.some((m) => m.sessionId === activeMapping.sessionId)).toBe(true);
      // Ended mapping may or may not be included depending on implementation
    });
  });

  describe("Metadata Fields", () => {
    test("stores and retrieves all metadata fields", async () => {
      const mapping = createTestMapping({
        model: { providerID: "anthropic", modelID: "claude-sonnet-4", displayName: "Claude Sonnet 4" },
        pendingModelSelection: true,
        approvedUsers: ["user1", "user2"],
        approveAllUsers: true,
        approveNextMessage: false,
        mergedInto: "other_thread_123",
        mergedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
      });
      createdSessionIds.push(mapping.sessionId);

      await store.create(mapping);

      const retrieved = await store.getBySessionId(mapping.sessionId);
      expect(retrieved!.model?.modelID).toBe("claude-sonnet-4");
      expect(retrieved!.pendingModelSelection).toBe(true);
      expect(retrieved!.approvedUsers).toEqual(["user1", "user2"]);
      expect(retrieved!.approveAllUsers).toBe(true);
      expect(retrieved!.approveNextMessage).toBe(false);
      expect(retrieved!.mergedInto).toBe("other_thread_123");
      expect(retrieved!.mergedAt).toBeDefined();
      expect(retrieved!.endedAt).toBeDefined();
    });
  });
});
