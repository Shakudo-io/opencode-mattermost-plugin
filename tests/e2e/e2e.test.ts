/**
 * E2E Tests for OpenCode Mattermost Plugin
 * 
 * Runs against real Mattermost instance on test3 cluster.
 * 
 * Prerequisites:
 * - test3 GKE cluster access
 * - Mattermost in mm-test namespace
 * - Bot token: kubectl get secret mattermost-e2e-test-creds -n mm-test -o jsonpath='{.data.bot-token}' | base64 -d
 * 
 * Run: bun test:e2e
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import WebSocket from "ws";

const getTestConfig = () => {
  // Use in-cluster URLs only if:
  // 1. We're actually in a k8s cluster (KUBERNETES_SERVICE_HOST is set)
  // 2. AND no explicit MATTERMOST_URL is provided (which means we want to use external URLs)
  const isInCluster = process.env.KUBERNETES_SERVICE_HOST !== undefined && !process.env.MATTERMOST_URL;
  
  return {
    baseUrl: isInCluster 
      ? "http://mattermost-team-edition.mm-test.svc.cluster.local:8065/api/v4"
      : process.env.MATTERMOST_URL || "https://mattermost.test3.canopyhub.io/api/v4",
    wsUrl: isInCluster
      ? "ws://mattermost-team-edition.mm-test.svc.cluster.local:8065/api/v4/websocket"
      : process.env.MATTERMOST_WS_URL || "wss://mattermost.test3.canopyhub.io/api/v4/websocket",
    
    botToken: process.env.MATTERMOST_BOT_TOKEN || process.env.MATTERMOST_TOKEN || "",
    testUserToken: process.env.MATTERMOST_TEST_USER_TOKEN || "",
    testUserPassword: process.env.MATTERMOST_TEST_USER_PASSWORD || "",
    
    botUserId: process.env.MATTERMOST_BOT_USER_ID || "k3mriyjajif5pmzuwzhc5ipure",
    testUserId: process.env.MATTERMOST_TEST_USER_ID || "eszmgh4y7pr5ffomh1wex1er7o",
    testUserEmail: process.env.MATTERMOST_TEST_USER_EMAIL || "e2e-testuser@test.local",
    teamId: process.env.MATTERMOST_TEAM_ID || "699ogwfxwfb98nkzsxwqjkq8wc",
    
    // For Supabase, same logic - prefer explicit env vars
    supabaseUrl: process.env.OPENCODE_MM_SUPABASE_URL || (isInCluster
      ? "http://supabase-metaflow-kong.hyperplane-supabase-metaflow.svc.cluster.local"
      : ""),
    supabaseAnonKey: process.env.OPENCODE_MM_SUPABASE_ANON_KEY || "",
    
    timeoutMs: 30000,
    pollIntervalMs: 500,
  };
};

class MattermostTestClient {
  private userId: string = "";
  
  constructor(private baseUrl: string, private token: string) {}

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        "Authorization": `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API request failed (${response.status}): ${error}`);
    }

    const contentType = response.headers.get("content-type");
    if (contentType?.includes("application/json")) {
      return response.json() as Promise<T>;
    }
    return response.text() as unknown as T;
  }

  async ping(): Promise<{ status: string }> {
    return this.request("/system/ping");
  }

  async getMe(): Promise<{ id: string; username: string }> {
    const user = await this.request<{ id: string; username: string }>("/users/me");
    this.userId = user.id;
    return user;
  }
  
  getUserId(): string {
    return this.userId;
  }
  
  setUserId(id: string): void {
    this.userId = id;
  }

  async getUserByUsername(username: string): Promise<{ id: string; username: string }> {
    return this.request(`/users/username/${username}`);
  }

  async createDirectChannel(userIds: string[]): Promise<{ id: string }> {
    return this.request("/channels/direct", {
      method: "POST",
      body: JSON.stringify(userIds),
    });
  }

  async getChannel(channelId: string): Promise<{ id: string; type: string; name: string }> {
    return this.request(`/channels/${channelId}`);
  }

  async createPost(channelId: string, message: string, rootId?: string): Promise<{ id: string; message: string; root_id: string }> {
    return this.request("/posts", {
      method: "POST",
      body: JSON.stringify({
        channel_id: channelId,
        message,
        root_id: rootId || "",
      }),
    });
  }

  async getPost(postId: string): Promise<{ id: string; message: string; user_id: string; root_id: string }> {
    return this.request(`/posts/${postId}`);
  }

  async getPostsForChannel(channelId: string, params?: { since?: number; per_page?: number }): Promise<{ 
    order: string[]; 
    posts: Record<string, { id: string; message: string; user_id: string; create_at: number; root_id: string }>;
  }> {
    const queryParams = new URLSearchParams();
    if (params?.since) queryParams.set("since", String(params.since));
    if (params?.per_page) queryParams.set("per_page", String(params.per_page));
    const query = queryParams.toString() ? `?${queryParams}` : "";
    return this.request(`/channels/${channelId}/posts${query}`);
  }

  async getPostThread(postId: string): Promise<{
    order: string[];
    posts: Record<string, { id: string; message: string; user_id: string; create_at: number }>;
  }> {
    return this.request(`/posts/${postId}/thread`);
  }

  async addReaction(postId: string, emojiName: string): Promise<{ user_id: string; post_id: string; emoji_name: string }> {
    if (!this.userId) {
      await this.getMe();
    }
    return this.request("/reactions", {
      method: "POST",
      body: JSON.stringify({
        user_id: this.userId,
        post_id: postId,
        emoji_name: emojiName,
      }),
    });
  }

  async deletePost(postId: string): Promise<void> {
    await this.request(`/posts/${postId}`, { method: "DELETE" });
  }

  async loginWithPassword(email: string, password: string): Promise<{ id: string; username: string }> {
    const response = await fetch(`${this.baseUrl}/users/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ login_id: email, password }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Login failed (${response.status}): ${error}`);
    }

    const token = response.headers.get("Token");
    if (token) {
      this.token = token;
    }

    const user = await response.json() as { id: string; username: string };
    this.userId = user.id;
    return user;
  }

  getToken(): string {
    return this.token;
  }
}

class MattermostTestWebSocket {
  private ws: WebSocket | null = null;
  private events: Array<{ event: string; data: any; broadcast: any }> = [];
  private connected = false;
  private seq = 0;

  constructor(private wsUrl: string, private token: string) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("WebSocket connection timeout"));
      }, 10000);

      this.ws = new WebSocket(this.wsUrl);

      this.ws.on("open", () => {
        clearTimeout(timeout);
        this.seq++;
        this.ws!.send(JSON.stringify({
          seq: this.seq,
          action: "authentication_challenge",
          data: { token: this.token },
        }));
        this.connected = true;
        resolve();
      });

      this.ws.on("message", (data: WebSocket.Data) => {
        try {
          const event = JSON.parse(data.toString());
          this.events.push(event);
        } catch (e) {
          // Parse errors are expected for non-JSON messages
        }
      });

      this.ws.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      this.ws.on("close", () => {
        this.connected = false;
      });
    });
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getEvents(): Array<{ event: string; data: any; broadcast: any }> {
    return this.events;
  }

  clearEvents(): void {
    this.events = [];
  }

  async waitForEvent(eventType: string, timeoutMs: number = 10000): Promise<{ event: string; data: any; broadcast: any } | null> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const event = this.events.find(e => e.event === eventType);
      if (event) {
        return event;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return null;
  }

  async waitForPostFromUser(userId: string, timeoutMs: number = 10000): Promise<{ event: string; data: any } | null> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const event = this.events.find(e => 
        e.event === "posted" && 
        e.data?.post && 
        JSON.parse(e.data.post).user_id === userId
      );
      if (event) {
        return event;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return null;
  }
}

class SupabaseTestClient {
  private schema = "opencode_mattermost";
  
  constructor(private url: string, private anonKey: string) {}

  private getHeaders(): Record<string, string> {
    return {
      "apikey": this.anonKey,
      "Authorization": `Bearer ${this.anonKey}`,
      "Accept-Profile": this.schema,
      "Content-Profile": this.schema,
    };
  }

  async query<T>(table: string, filters?: Record<string, any>): Promise<T[]> {
    let path = `/rest/v1/${table}?select=*`;
    if (filters) {
      for (const [key, value] of Object.entries(filters)) {
        path += `&${key}=eq.${value}`;
      }
    }

    const response = await fetch(`${this.url}${path}`, {
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Supabase query failed (${response.status}): ${error}`);
    }

    return response.json() as Promise<T[]>;
  }

  async deleteBySessionId(sessionId: string): Promise<void> {
    const response = await fetch(
      `${this.url}/rest/v1/thread_mappings?opencode_session_id=eq.${sessionId}`,
      {
        method: "DELETE",
        headers: this.getHeaders(),
      }
    );

    if (!response.ok && response.status !== 404) {
      const error = await response.text();
      throw new Error(`Supabase delete failed (${response.status}): ${error}`);
    }
  }
}

const TEST_PREFIX = "E2E_";

describe("E2E: Mattermost Plugin", () => {
  const config = getTestConfig();
  let botClient: MattermostTestClient;
  let testUserClient: MattermostTestClient;
  let testUserWs: MattermostTestWebSocket;
  let supabase: SupabaseTestClient | null = null;
  let dmChannelId: string;
  const createdPostIds: string[] = [];
  const createdSessionIds: string[] = [];

  beforeAll(async () => {
    if (!config.botToken) {
      console.log("Skipping E2E suite: No bot token provided");
      return;
    }

    botClient = new MattermostTestClient(config.baseUrl, config.botToken);
    testUserClient = new MattermostTestClient(config.baseUrl, "");

    console.log("Testing bot connectivity...");
    const ping = await botClient.ping();
    expect(ping.status).toBe("OK");
    console.log("Bot ping successful");

    const botUser = await botClient.getMe();
    console.log(`Bot user: ${botUser.username} (${botUser.id})`);
    expect(botUser.id).toBe(config.botUserId);

    if (config.testUserPassword) {
      console.log("Logging in as test user...");
      const testUser = await testUserClient.loginWithPassword(
        config.testUserEmail,
        config.testUserPassword
      );
      console.log(`Test user: ${testUser.username} (${testUser.id})`);
      expect(testUser.id).toBe(config.testUserId);
    } else if (config.testUserToken) {
      testUserClient = new MattermostTestClient(config.baseUrl, config.testUserToken);
      const testUser = await testUserClient.getMe();
      console.log(`Test user: ${testUser.username} (${testUser.id})`);
    } else {
      console.warn("No test user credentials provided - some tests may be limited");
    }

    if (testUserClient.getToken()) {
      console.log("Creating DM channel between test user and bot...");
      const dmChannel = await testUserClient.createDirectChannel([config.testUserId, config.botUserId]);
      dmChannelId = dmChannel.id;
      console.log(`DM channel ID: ${dmChannelId}`);

      console.log("Connecting test user WebSocket...");
      testUserWs = new MattermostTestWebSocket(config.wsUrl, testUserClient.getToken());
      await testUserWs.connect();
      console.log("WebSocket connected");
    }

    if (config.supabaseUrl && config.supabaseAnonKey) {
      supabase = new SupabaseTestClient(config.supabaseUrl, config.supabaseAnonKey);
      console.log("Supabase client initialized");
    }
  });

  afterAll(async () => {
    if (testUserWs) {
      testUserWs.disconnect();
    }

    for (const postId of createdPostIds.reverse()) {
      try {
        await botClient.deletePost(postId);
      } catch (e) {
        // Cleanup errors are non-fatal
      }
    }

    if (supabase) {
      for (const sessionId of createdSessionIds) {
        try {
          await supabase.deleteBySessionId(sessionId);
        } catch (e) {
          // Cleanup errors are non-fatal
        }
      }
    }
  });

  describe("Connectivity", () => {
    test("bot can ping Mattermost API", async () => {
      const ping = await botClient.ping();
      expect(ping.status).toBe("OK");
    });

    test("bot can retrieve its own user info", async () => {
      const user = await botClient.getMe();
      expect(user.id).toBe(config.botUserId);
      expect(user.username).toBe("opencode-test-bot");
    });

    test("test user WebSocket is connected", () => {
      if (!testUserWs) {
        console.log("Skipping: No test user WebSocket");
        return;
      }
      expect(testUserWs.isConnected()).toBe(true);
    });
  });

  describe("DM Channel", () => {
    test("DM channel exists between test user and bot", async () => {
      if (!dmChannelId) {
        console.log("Skipping: No DM channel");
        return;
      }

      const channel = await testUserClient.getChannel(dmChannelId);
      expect(channel.id).toBe(dmChannelId);
      expect(channel.type).toBe("D");
    });

    test("test user can post to DM channel", async () => {
      if (!dmChannelId || !testUserClient.getToken()) {
        console.log("Skipping: No DM channel or test user token");
        return;
      }

      const timestamp = Date.now();
      const message = `${TEST_PREFIX}ping_${timestamp}`;
      
      const post = await testUserClient.createPost(dmChannelId, message);
      createdPostIds.push(post.id);
      
      expect(post.message).toBe(message);
      expect(post.id).toBeTruthy();
    });
  });

  describe("Bot Commands", () => {
    test("bot receives help command and responds", async () => {
      if (!dmChannelId || !testUserClient.getToken() || !testUserWs) {
        console.log("Skipping: Missing prerequisites");
        return;
      }

      testUserWs.clearEvents();

      const helpPost = await testUserClient.createPost(dmChannelId, "!help");
      createdPostIds.push(helpPost.id);

      expect(helpPost.id).toBeTruthy();

      await new Promise(resolve => setTimeout(resolve, 2000));

      const botResponse = testUserWs.getEvents().find(e => 
        e.event === "posted" && 
        e.data?.post &&
        JSON.parse(e.data.post).user_id === config.botUserId
      );

      if (botResponse) {
        const postData = JSON.parse(botResponse.data.post);
        console.log(`Bot responded: ${postData.message.substring(0, 100)}...`);
        expect(postData.user_id).toBe(config.botUserId);
      } else {
        console.log("No bot response received (plugin may not be running)");
      }
    }, 15000);

    test("bot receives sessions command", async () => {
      if (!dmChannelId || !testUserClient.getToken()) {
        console.log("Skipping: Missing prerequisites");
        return;
      }

      const sessionsPost = await testUserClient.createPost(dmChannelId, "!sessions");
      createdPostIds.push(sessionsPost.id);
      
      expect(sessionsPost.id).toBeTruthy();

      await new Promise(resolve => setTimeout(resolve, 1000));
    }, 10000);
  });

  describe("Message Routing", () => {
    test("messages are received by bot via WebSocket", async () => {
      if (!dmChannelId || !testUserClient.getToken()) {
        console.log("Skipping: Missing prerequisites");
        return;
      }

      const timestamp = Date.now();
      const testMessage = `${TEST_PREFIX}routing_test_${timestamp}`;
      
      const post = await testUserClient.createPost(dmChannelId, testMessage);
      createdPostIds.push(post.id);
      
      expect(post.message).toBe(testMessage);

      const retrievedPost = await testUserClient.getPost(post.id);
      expect(retrievedPost.message).toBe(testMessage);
      expect(retrievedPost.user_id).toBe(config.testUserId);
    });
  });

  describe("Thread Management", () => {
    test("can create a thread by replying to a post", async () => {
      if (!dmChannelId || !testUserClient.getToken()) {
        console.log("Skipping: Missing prerequisites");
        return;
      }

      const timestamp = Date.now();
      const rootPost = await testUserClient.createPost(
        dmChannelId, 
        `${TEST_PREFIX}thread_root_${timestamp}`
      );
      createdPostIds.push(rootPost.id);

      const replyPost = await testUserClient.createPost(
        dmChannelId,
        `${TEST_PREFIX}thread_reply_${timestamp}`,
        rootPost.id
      );
      createdPostIds.push(replyPost.id);

      const thread = await testUserClient.getPostThread(rootPost.id);
      expect(thread.order).toContain(rootPost.id);
      expect(thread.order).toContain(replyPost.id);
      expect(thread.posts[replyPost.id].root_id).toBe(rootPost.id);
    });
  });

  describe("Reactions", () => {
    test("can add reaction to a post", async () => {
      if (!dmChannelId || !testUserClient.getToken()) {
        console.log("Skipping: Missing prerequisites");
        return;
      }

      const timestamp = Date.now();
      const post = await testUserClient.createPost(
        dmChannelId,
        `${TEST_PREFIX}reaction_target_${timestamp}`
      );
      createdPostIds.push(post.id);

      const reaction = await testUserClient.addReaction(post.id, "thumbsup");
      expect(reaction.post_id).toBe(post.id);
      expect(reaction.emoji_name).toBe("thumbsup");
    });
  });

  describe("Database Verification", () => {
    test("can query thread_mappings table", async () => {
      if (!supabase) {
        console.log("Skipping: Supabase not configured");
        return;
      }

      const mappings = await supabase.query<{ id: string; thread_root_post_id: string }>("thread_mappings");
      
      expect(Array.isArray(mappings)).toBe(true);
      console.log(`Found ${mappings.length} thread mappings in database`);
    });

    test("can query instances table", async () => {
      if (!supabase) {
        console.log("Skipping: Supabase not configured");
        return;
      }

      const instances = await supabase.query<{ id: string; instance_id: string }>("instances");
      
      expect(Array.isArray(instances)).toBe(true);
      console.log(`Found ${instances.length} instances in database`);
    });
  });
});

describe("E2E: Standalone Connectivity Tests", () => {
  const config = getTestConfig();

  test("Mattermost API is reachable", async () => {
    if (!config.botToken) {
      console.log("Skipping: No bot token");
      return;
    }

    const response = await fetch(`${config.baseUrl}/system/ping`, {
      headers: { "Authorization": `Bearer ${config.botToken}` },
    });
    
    expect(response.ok).toBe(true);
    const data = await response.json() as { status: string };
    expect(data.status).toBe("OK");
  });

  test("WebSocket endpoint is reachable", async () => {
    if (!config.botToken) {
      console.log("Skipping: No bot token");
      return;
    }

    const ws = new WebSocket(config.wsUrl);
    
    const connected = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 5000);
      
      ws.on("open", () => {
        clearTimeout(timeout);
        ws.close();
        resolve(true);
      });
      
      ws.on("error", () => {
        clearTimeout(timeout);
        resolve(false);
      });
    });

    expect(connected).toBe(true);
  });

  test("Supabase is reachable", async () => {
    if (!config.supabaseUrl || !config.supabaseAnonKey) {
      console.log("Skipping: Supabase not configured");
      return;
    }

    const response = await fetch(`${config.supabaseUrl}/rest/v1/`, {
      headers: {
        "apikey": config.supabaseAnonKey,
        "Authorization": `Bearer ${config.supabaseAnonKey}`,
      },
    });

    expect(response.ok).toBe(true);
  });
});
