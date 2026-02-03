/**
 * Mock factory for MattermostClient
 * Use this to test components that depend on MattermostClient without real HTTP calls
 */

import type { MattermostConfig } from "../../src/config.js";

export interface MockPost {
  id: string;
  channel_id: string;
  user_id: string;
  message: string;
  root_id?: string;
  file_ids?: string[];
  create_at?: number;
  update_at?: number;
  metadata?: Record<string, unknown>;
}

export interface MockChannel {
  id: string;
  type: "D" | "G" | "O" | "P";
  name: string;
  display_name: string;
  team_id?: string;
}

export interface MockUser {
  id: string;
  username: string;
  email?: string;
  first_name?: string;
  last_name?: string;
}

export interface MockReaction {
  user_id: string;
  post_id: string;
  emoji_name: string;
  create_at: number;
}

export interface MockMattermostClient {
  // Post operations
  createPost: ReturnType<typeof createMockFn>;
  updatePost: ReturnType<typeof createMockFn>;
  getPost: ReturnType<typeof createMockFn>;
  deletePost: ReturnType<typeof createMockFn>;
  getPostThread: ReturnType<typeof createMockFn>;
  
  // Channel operations
  getChannel: ReturnType<typeof createMockFn>;
  getDirectChannel: ReturnType<typeof createMockFn>;
  getChannelMembers: ReturnType<typeof createMockFn>;
  
  // User operations
  getUser: ReturnType<typeof createMockFn>;
  getMe: ReturnType<typeof createMockFn>;
  getUserByUsername: ReturnType<typeof createMockFn>;
  
  // File operations
  uploadFile: ReturnType<typeof createMockFn>;
  getFile: ReturnType<typeof createMockFn>;
  getFileInfo: ReturnType<typeof createMockFn>;
  
  // Reaction operations
  addReaction: ReturnType<typeof createMockFn>;
  removeReaction: ReturnType<typeof createMockFn>;
  getReactions: ReturnType<typeof createMockFn>;
  
  // Connection
  connect: ReturnType<typeof createMockFn>;
  disconnect: ReturnType<typeof createMockFn>;
  isConnected: ReturnType<typeof createMockFn>;
  
  // Config
  config: MattermostConfig;
  
  // Test helpers
  _reset: () => void;
  _setPostResponse: (postId: string, post: MockPost) => void;
  _setChannelResponse: (channelId: string, channel: MockChannel) => void;
  _setUserResponse: (userId: string, user: MockUser) => void;
}

// Simple mock function factory (Bun-compatible)
function createMockFn() {
  const calls: unknown[][] = [];
  const fn = (...args: unknown[]) => {
    calls.push(args);
    return fn._returnValue;
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
  fn.mockClear = () => {
    calls.length = 0;
  };
  return fn;
}

/**
 * Create a mock MattermostClient for testing
 */
export function createMockMattermostClient(
  configOverrides: Partial<MattermostConfig> = {}
): MockMattermostClient {
  const postStore = new Map<string, MockPost>();
  const channelStore = new Map<string, MockChannel>();
  const userStore = new Map<string, MockUser>();

  const defaultConfig: MattermostConfig = {
    baseUrl: "https://test.mattermost.com/api/v4",
    wsUrl: "wss://test.mattermost.com/api/v4/websocket",
    token: "test-token",
    botUsername: "test-bot",
    defaultTeam: "test-team",
    debug: false,
    reconnectInterval: 5000,
    maxReconnectAttempts: 10,
    autoConnect: false,
    ownerUserId: undefined,
    ...configOverrides,
  };

  const mock: MockMattermostClient = {
    // Post operations
    createPost: createMockFn().mockResolvedValue({ id: "new-post-id", message: "" }),
    updatePost: createMockFn().mockResolvedValue({ id: "updated-post-id" }),
    getPost: createMockFn().mockResolvedValue(null),
    deletePost: createMockFn().mockResolvedValue(undefined),
    getPostThread: createMockFn().mockResolvedValue({ order: [], posts: {} }),

    // Channel operations
    getChannel: createMockFn().mockResolvedValue(null),
    getDirectChannel: createMockFn().mockResolvedValue({ id: "dm-channel-id", type: "D" }),
    getChannelMembers: createMockFn().mockResolvedValue([]),

    // User operations
    getUser: createMockFn().mockResolvedValue(null),
    getMe: createMockFn().mockResolvedValue({ id: "bot-user-id", username: "test-bot" }),
    getUserByUsername: createMockFn().mockResolvedValue(null),

    // File operations
    uploadFile: createMockFn().mockResolvedValue({ file_infos: [{ id: "file-id" }] }),
    getFile: createMockFn().mockResolvedValue(Buffer.from("")),
    getFileInfo: createMockFn().mockResolvedValue({ id: "file-id", name: "test.txt" }),

    // Reaction operations
    addReaction: createMockFn().mockResolvedValue(undefined),
    removeReaction: createMockFn().mockResolvedValue(undefined),
    getReactions: createMockFn().mockResolvedValue([]),

    // Connection
    connect: createMockFn().mockResolvedValue(undefined),
    disconnect: createMockFn().mockResolvedValue(undefined),
    isConnected: createMockFn().mockReturnValue(true),

    // Config
    config: defaultConfig,

    // Test helpers
    _reset: () => {
      postStore.clear();
      channelStore.clear();
      userStore.clear();
      // Reset all mock functions
      Object.values(mock).forEach((value) => {
        if (typeof value === "function" && "mockClear" in value) {
          (value as ReturnType<typeof createMockFn>).mockClear();
        }
      });
    },

    _setPostResponse: (postId: string, post: MockPost) => {
      postStore.set(postId, post);
      mock.getPost.mockResolvedValue(post);
    },

    _setChannelResponse: (channelId: string, channel: MockChannel) => {
      channelStore.set(channelId, channel);
      mock.getChannel.mockResolvedValue(channel);
    },

    _setUserResponse: (userId: string, user: MockUser) => {
      userStore.set(userId, user);
      mock.getUser.mockResolvedValue(user);
    },
  };

  return mock;
}

// Default mock instance for simple imports
export const mockMattermostClient = createMockMattermostClient();
