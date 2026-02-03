/**
 * Mock factory for Supabase client
 * Use this to test PostgreSQL persistence without real database calls
 */

export interface MockSupabaseResponse<T> {
  data: T | null;
  error: { message: string; code?: string } | null;
}

export interface MockRealtimeChannel {
  on: ReturnType<typeof createMockFn>;
  subscribe: ReturnType<typeof createMockFn>;
  unsubscribe: ReturnType<typeof createMockFn>;
}

export interface MockSupabaseClient {
  from: ReturnType<typeof createMockFn>;
  channel: ReturnType<typeof createMockFn>;
  removeChannel: ReturnType<typeof createMockFn>;
  
  // Query builder chain
  _queryBuilder: MockQueryBuilder;
  
  // Test helpers
  _reset: () => void;
  _setQueryResponse: <T>(tableName: string, method: string, response: MockSupabaseResponse<T>) => void;
  _simulateRealtimeEvent: (channel: string, event: string, payload: unknown) => void;
}

export interface MockQueryBuilder {
  select: ReturnType<typeof createMockFn>;
  insert: ReturnType<typeof createMockFn>;
  update: ReturnType<typeof createMockFn>;
  upsert: ReturnType<typeof createMockFn>;
  delete: ReturnType<typeof createMockFn>;
  eq: ReturnType<typeof createMockFn>;
  neq: ReturnType<typeof createMockFn>;
  gt: ReturnType<typeof createMockFn>;
  lt: ReturnType<typeof createMockFn>;
  gte: ReturnType<typeof createMockFn>;
  lte: ReturnType<typeof createMockFn>;
  in: ReturnType<typeof createMockFn>;
  is: ReturnType<typeof createMockFn>;
  order: ReturnType<typeof createMockFn>;
  limit: ReturnType<typeof createMockFn>;
  single: ReturnType<typeof createMockFn>;
  maybeSingle: ReturnType<typeof createMockFn>;
}

// Simple mock function factory (Bun-compatible)
function createMockFn() {
  const calls: unknown[][] = [];
  const fn = (...args: unknown[]) => {
    calls.push(args);
    return fn._returnValue ?? fn;
  };
  fn.calls = calls;
  fn._returnValue = undefined as unknown;
  fn.mockResolvedValue = (value: unknown) => {
    fn._returnValue = Promise.resolve(value);
    return fn;
  };
  fn.mockRejectedValue = (error: unknown) => {
    fn._returnValue = Promise.reject(error);
    return fn;
  };
  fn.mockReturnValue = (value: unknown) => {
    fn._returnValue = value;
    return fn;
  };
  fn.mockReturnThis = () => {
    fn._returnValue = undefined; // Will return fn (this) by default
    return fn;
  };
  fn.mockClear = () => {
    calls.length = 0;
  };
  return fn;
}

/**
 * Create a mock Supabase client for testing
 */
export function createMockSupabaseClient(): MockSupabaseClient {
  const responseStore = new Map<string, MockSupabaseResponse<unknown>>();
  const realtimeHandlers = new Map<string, Map<string, ((payload: unknown) => void)[]>>();

  // Create query builder that chains properly
  const createQueryBuilder = (): MockQueryBuilder => {
    const builder: MockQueryBuilder = {
      select: createMockFn().mockReturnThis(),
      insert: createMockFn().mockReturnThis(),
      update: createMockFn().mockReturnThis(),
      upsert: createMockFn().mockReturnThis(),
      delete: createMockFn().mockReturnThis(),
      eq: createMockFn().mockReturnThis(),
      neq: createMockFn().mockReturnThis(),
      gt: createMockFn().mockReturnThis(),
      lt: createMockFn().mockReturnThis(),
      gte: createMockFn().mockReturnThis(),
      lte: createMockFn().mockReturnThis(),
      in: createMockFn().mockReturnThis(),
      is: createMockFn().mockReturnThis(),
      order: createMockFn().mockReturnThis(),
      limit: createMockFn().mockReturnThis(),
      single: createMockFn().mockResolvedValue({ data: null, error: null }),
      maybeSingle: createMockFn().mockResolvedValue({ data: null, error: null }),
    };

    // Make chainable methods return the builder
    Object.keys(builder).forEach((key) => {
      const fn = builder[key as keyof MockQueryBuilder];
      if (key !== "single" && key !== "maybeSingle") {
        fn._returnValue = builder;
      }
    });

    return builder;
  };

  const queryBuilder = createQueryBuilder();

  const createRealtimeChannel = (channelName: string): MockRealtimeChannel => {
    const handlers = new Map<string, ((payload: unknown) => void)[]>();
    realtimeHandlers.set(channelName, handlers);

    return {
      on: createMockFn().mockImplementation((_event: string, _filter: unknown, callback: (payload: unknown) => void) => {
        const eventHandlers = handlers.get(_event) || [];
        eventHandlers.push(callback);
        handlers.set(_event, eventHandlers);
        return createRealtimeChannel(channelName);
      }),
      subscribe: createMockFn().mockReturnValue({ status: "SUBSCRIBED" }),
      unsubscribe: createMockFn().mockResolvedValue(undefined),
    };
  };

  // Helper to make mockImplementation work
  function mockImplementation(fn: ReturnType<typeof createMockFn>, impl: (...args: unknown[]) => unknown) {
    const originalFn = fn;
    const newFn = (...args: unknown[]) => {
      originalFn.calls.push(args);
      return impl(...args);
    };
    Object.assign(newFn, originalFn);
    return newFn;
  }

  const mock: MockSupabaseClient = {
    from: createMockFn().mockReturnValue(queryBuilder),
    channel: createMockFn(),
    removeChannel: createMockFn().mockResolvedValue(undefined),

    _queryBuilder: queryBuilder,

    _reset: () => {
      responseStore.clear();
      realtimeHandlers.clear();
      // Reset all mock functions
      Object.values(queryBuilder).forEach((fn) => {
        if (typeof fn === "function" && "mockClear" in fn) {
          fn.mockClear();
        }
      });
      mock.from.mockClear();
      mock.channel.mockClear();
      mock.removeChannel.mockClear();
    },

    _setQueryResponse: <T>(tableName: string, method: string, response: MockSupabaseResponse<T>) => {
      const key = `${tableName}:${method}`;
      responseStore.set(key, response as MockSupabaseResponse<unknown>);
      
      // Update the appropriate query builder method
      if (method === "select") {
        queryBuilder.single.mockResolvedValue(response);
        queryBuilder.maybeSingle.mockResolvedValue(response);
      }
    },

    _simulateRealtimeEvent: (channel: string, event: string, payload: unknown) => {
      const handlers = realtimeHandlers.get(channel);
      if (handlers) {
        const eventHandlers = handlers.get(event) || [];
        eventHandlers.forEach((handler) => handler(payload));
      }
    },
  };

  // Set up channel to return realtime channels
  mock.channel = mockImplementation(mock.channel, (channelName: string) => {
    return createRealtimeChannel(channelName);
  }) as ReturnType<typeof createMockFn>;

  return mock;
}

// Default mock instance for simple imports
export const mockSupabaseClient = createMockSupabaseClient();

/**
 * Helper to create mock thread mapping data
 */
export function createMockThreadMapping(overrides: Partial<{
  id: string;
  thread_root_post_id: string;
  channel_id: string;
  opencode_session_id: string;
  mattermost_user_id: string;
  mode: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}> = {}) {
  return {
    id: "mock-uuid",
    thread_root_post_id: "post-123",
    channel_id: "channel-456",
    opencode_session_id: "ses_abc123",
    mattermost_user_id: "user-789",
    mode: "normal",
    metadata: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Helper to create mock scheduled task data
 */
export function createMockScheduledTask(overrides: Partial<{
  id: string;
  name: string;
  cron: string;
  prompt: string;
  timezone: string;
  enabled: boolean;
  target_user: string;
  last_run_at: string | null;
  next_run_at: string;
}> = {}) {
  return {
    id: "mock-task-uuid",
    name: "test-task",
    cron: "0 9 * * *",
    prompt: "Test prompt",
    timezone: "UTC",
    enabled: true,
    target_user: "user-123",
    last_run_at: null,
    next_run_at: new Date().toISOString(),
    ...overrides,
  };
}
