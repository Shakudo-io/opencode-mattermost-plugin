/**
 * Mock factories index
 * Import all mocks from this file for convenience
 */

export {
  createMockMattermostClient,
  mockMattermostClient,
  type MockMattermostClient,
  type MockPost,
  type MockChannel,
  type MockUser,
  type MockReaction,
} from "./mattermost-client.mock.js";

export {
  createMockSupabaseClient,
  mockSupabaseClient,
  createMockThreadMapping,
  createMockScheduledTask,
  type MockSupabaseClient,
  type MockSupabaseResponse,
  type MockQueryBuilder,
  type MockRealtimeChannel,
} from "./supabase-client.mock.js";

/**
 * Test utilities
 */

/**
 * Create a mock Post object for testing
 */
export function createMockPost(overrides: Partial<{
  id: string;
  channel_id: string;
  user_id: string;
  message: string;
  root_id: string;
  file_ids: string[];
  create_at: number;
  update_at: number;
  metadata: Record<string, unknown>;
}> = {}) {
  return {
    id: "post-123",
    channel_id: "channel-456",
    user_id: "user-789",
    message: "Test message",
    root_id: "",
    file_ids: [],
    create_at: Date.now(),
    update_at: Date.now(),
    metadata: {},
    ...overrides,
  };
}

/**
 * Create mock thread session mapping for testing
 */
export function createMockThreadSessionMapping(overrides: Partial<{
  threadRootPostId: string;
  channelId: string;
  sessionId: string;
  mattermostUserId: string;
  status: "active" | "ended" | "disconnected" | "merged" | "orphaned";
  mergedInto?: string;
  createdAt: Date;
  lastActivityAt: Date;
}> = {}) {
  return {
    threadRootPostId: "thread-root-123",
    channelId: "channel-456",
    sessionId: "ses_abc123",
    mattermostUserId: "user-789",
    status: "active" as const,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    ...overrides,
  };
}

/**
 * Wait for a specified number of milliseconds
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Flush all pending promises (useful for testing async code)
 */
export async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}
