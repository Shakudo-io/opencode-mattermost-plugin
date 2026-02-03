import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    Object.keys(process.env).forEach((key) => {
      if (key.startsWith("MATTERMOST_") || key.startsWith("OPENCODE_MM_")) {
        delete process.env[key];
      }
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("mattermost config", () => {
    test("loads baseUrl from MATTERMOST_URL", () => {
      process.env.MATTERMOST_URL = "https://mm.example.com";
      const config = loadConfig();
      expect(config.mattermost.baseUrl).toBe("https://mm.example.com/api/v4");
    });

    test("appends /api/v4 if missing", () => {
      process.env.MATTERMOST_URL = "https://mm.example.com/";
      const config = loadConfig();
      expect(config.mattermost.baseUrl).toBe("https://mm.example.com/api/v4");
    });

    test("preserves /api/v4 if already present", () => {
      process.env.MATTERMOST_URL = "https://mm.example.com/api/v4";
      const config = loadConfig();
      expect(config.mattermost.baseUrl).toBe("https://mm.example.com/api/v4");
    });

    test("loads token from MATTERMOST_TOKEN", () => {
      process.env.MATTERMOST_URL = "https://mm.example.com/api/v4";
      process.env.MATTERMOST_TOKEN = "test-token-123";
      const config = loadConfig();
      expect(config.mattermost.token).toBe("test-token-123");
    });

    test("loads ownerUserId from MATTERMOST_OWNER_USER_ID", () => {
      process.env.MATTERMOST_URL = "https://mm.example.com/api/v4";
      process.env.MATTERMOST_OWNER_USER_ID = "owner-123";
      const config = loadConfig();
      expect(config.mattermost.ownerUserId).toBe("owner-123");
    });

    test("sets debug true when MATTERMOST_DEBUG=true", () => {
      process.env.MATTERMOST_URL = "https://mm.example.com/api/v4";
      process.env.MATTERMOST_DEBUG = "true";
      const config = loadConfig();
      expect(config.mattermost.debug).toBe(true);
    });

    test("sets autoConnect false when MATTERMOST_AUTO_CONNECT=false", () => {
      process.env.MATTERMOST_URL = "https://mm.example.com/api/v4";
      process.env.MATTERMOST_AUTO_CONNECT = "false";
      const config = loadConfig();
      expect(config.mattermost.autoConnect).toBe(false);
    });
  });

  describe("streaming config", () => {
    test("uses default bufferSize of 50", () => {
      process.env.MATTERMOST_URL = "https://mm.example.com/api/v4";
      const config = loadConfig();
      expect(config.streaming.bufferSize).toBe(50);
    });

    test("loads custom bufferSize from OPENCODE_MM_BUFFER_SIZE", () => {
      process.env.MATTERMOST_URL = "https://mm.example.com/api/v4";
      process.env.OPENCODE_MM_BUFFER_SIZE = "100";
      const config = loadConfig();
      expect(config.streaming.bufferSize).toBe(100);
    });

    test("uses default maxPostLength of 15000", () => {
      process.env.MATTERMOST_URL = "https://mm.example.com/api/v4";
      const config = loadConfig();
      expect(config.streaming.maxPostLength).toBe(15000);
    });
  });

  describe("sessions config", () => {
    test("uses default allowedChannelTypes of D,G,O,P", () => {
      process.env.MATTERMOST_URL = "https://mm.example.com/api/v4";
      const config = loadConfig();
      expect(config.sessions.allowedChannelTypes).toEqual(["D", "G", "O", "P"]);
    });

    test("loads custom allowedChannelTypes", () => {
      process.env.MATTERMOST_URL = "https://mm.example.com/api/v4";
      process.env.OPENCODE_MM_ALLOWED_CHANNEL_TYPES = "D,G";
      const config = loadConfig();
      expect(config.sessions.allowedChannelTypes).toEqual(["D", "G"]);
    });

    test("loads allowedUsers from comma-separated string", () => {
      process.env.MATTERMOST_URL = "https://mm.example.com/api/v4";
      process.env.OPENCODE_MM_ALLOWED_USERS = "user1,user2,user3";
      const config = loadConfig();
      expect(config.sessions.allowedUsers).toEqual(["user1", "user2", "user3"]);
    });

    test("filters empty values from allowedUsers", () => {
      process.env.MATTERMOST_URL = "https://mm.example.com/api/v4";
      process.env.OPENCODE_MM_ALLOWED_USERS = "user1,,user2,";
      const config = loadConfig();
      expect(config.sessions.allowedUsers).toEqual(["user1", "user2"]);
    });
  });

  describe("postgres config", () => {
    test("disabled by default", () => {
      process.env.MATTERMOST_URL = "https://mm.example.com/api/v4";
      const config = loadConfig();
      expect(config.postgres.enabled).toBe(false);
    });

    test("enabled when OPENCODE_MM_POSTGRES_ENABLED=true", () => {
      process.env.MATTERMOST_URL = "https://mm.example.com/api/v4";
      process.env.OPENCODE_MM_POSTGRES_ENABLED = "true";
      const config = loadConfig();
      expect(config.postgres.enabled).toBe(true);
    });

    test("loads supabase credentials", () => {
      process.env.MATTERMOST_URL = "https://mm.example.com/api/v4";
      process.env.OPENCODE_MM_SUPABASE_URL = "https://xxx.supabase.co";
      process.env.OPENCODE_MM_SUPABASE_ANON_KEY = "anon-key-123";
      const config = loadConfig();
      expect(config.postgres.supabaseUrl).toBe("https://xxx.supabase.co");
      expect(config.postgres.supabaseAnonKey).toBe("anon-key-123");
    });

    test("uses default migrationPhase of 1", () => {
      process.env.MATTERMOST_URL = "https://mm.example.com/api/v4";
      const config = loadConfig();
      expect(config.postgres.migrationPhase).toBe("1");
    });

    test("loads custom migrationPhase", () => {
      process.env.MATTERMOST_URL = "https://mm.example.com/api/v4";
      process.env.OPENCODE_MM_MIGRATION_PHASE = "3";
      const config = loadConfig();
      expect(config.postgres.migrationPhase).toBe("3");
    });

    test("loads instanceId from MY_POD_NAME", () => {
      process.env.MATTERMOST_URL = "https://mm.example.com/api/v4";
      process.env.MY_POD_NAME = "my-pod-abc123";
      const config = loadConfig();
      expect(config.postgres.instanceId).toBe("my-pod-abc123");
    });

    test("falls back to HOSTNAME for instanceId", () => {
      process.env.MATTERMOST_URL = "https://mm.example.com/api/v4";
      delete process.env.MY_POD_NAME;
      process.env.HOSTNAME = "my-hostname";
      const config = loadConfig();
      expect(config.postgres.instanceId).toBe("my-hostname");
    });
  });

  describe("sessionSelection config", () => {
    test("uses default commandPrefix of !", () => {
      process.env.MATTERMOST_URL = "https://mm.example.com/api/v4";
      const config = loadConfig();
      expect(config.sessionSelection.commandPrefix).toBe("!");
    });

    test("autoCreateSession enabled by default", () => {
      process.env.MATTERMOST_URL = "https://mm.example.com/api/v4";
      const config = loadConfig();
      expect(config.sessionSelection.autoCreateSession).toBe(true);
    });

    test("autoCreateSession disabled when OPENCODE_MM_AUTO_CREATE_SESSION=false", () => {
      process.env.MATTERMOST_URL = "https://mm.example.com/api/v4";
      process.env.OPENCODE_MM_AUTO_CREATE_SESSION = "false";
      const config = loadConfig();
      expect(config.sessionSelection.autoCreateSession).toBe(false);
    });
  });
});
