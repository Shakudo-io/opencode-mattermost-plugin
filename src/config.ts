import { z } from "zod";
import { log as fileLog } from "./logger.js";

// Configuration schema
const MattermostConfigSchema = z.object({
  baseUrl: z.string().url(),
  wsUrl: z.string(),
  token: z.string().default(""),
  botUsername: z.string().optional(),
  defaultTeam: z.string().optional(),
  debug: z.boolean().default(false),
  reconnectInterval: z.number().default(5000),
  maxReconnectAttempts: z.number().default(10),
  autoConnect: z.boolean().default(true),
  ownerUserId: z.string().optional(),
});

const StreamingConfigSchema = z.object({
  bufferSize: z.number().default(50),
  maxDelay: z.number().default(500),
  editRateLimit: z.number().default(10),
  maxPostLength: z.number().default(15000), // Mattermost limit is 16383, leave buffer for formatting
});

const NotificationsConfigSchema = z.object({
  onCompletion: z.boolean().default(true),
  onPermissionRequest: z.boolean().default(true),
  onError: z.boolean().default(true),
  onStatusUpdate: z.boolean().default(true),
  statusInterval: z.number().default(30000),
});

const SessionsConfigSchema = z.object({
  timeout: z.number().default(3600000),
  maxSessions: z.number().default(50),
  allowedUsers: z.array(z.string()).default([]),
});

const SessionSelectionConfigSchema = z.object({
  commandPrefix: z.string().default("!"),
  autoSelectSingle: z.boolean().default(true),
  refreshIntervalMs: z.number().default(60000),
  autoCreateSession: z.boolean().default(true),
});

const FilesConfigSchema = z.object({
  tempDir: z.string().default("/tmp/opencode-mm-plugin"),
  maxFileSize: z.number().default(10485760), // 10MB
  allowedExtensions: z.array(z.string()).default(["*"]),
});

const PluginConfigSchema = z.object({
  mattermost: MattermostConfigSchema,
  streaming: StreamingConfigSchema,
  notifications: NotificationsConfigSchema,
  sessions: SessionsConfigSchema,
  files: FilesConfigSchema,
  sessionSelection: SessionSelectionConfigSchema,
});

export type MattermostConfig = z.infer<typeof MattermostConfigSchema>;
export type StreamingConfig = z.infer<typeof StreamingConfigSchema>;
export type NotificationsConfig = z.infer<typeof NotificationsConfigSchema>;
export type SessionsConfig = z.infer<typeof SessionsConfigSchema>;
export type FilesConfig = z.infer<typeof FilesConfigSchema>;
export type SessionSelectionConfig = z.infer<typeof SessionSelectionConfigSchema>;
export type PluginConfig = z.infer<typeof PluginConfigSchema>;

// Default Mattermost configuration
// NOTE: These are example URLs - you must configure your own Mattermost instance
const DEFAULT_MATTERMOST_CONFIG = {
  baseUrl: "https://your-mattermost-instance.example.com/api/v4",
  wsUrl: "wss://your-mattermost-instance.example.com/api/v4/websocket",
  token: "", // REQUIRED: Set via MATTERMOST_TOKEN environment variable
  defaultTeam: "",
  debug: false,
  reconnectInterval: 5000,
  maxReconnectAttempts: 10,
};

/**
 * Load configuration from environment variables
 */
export function loadConfig(): PluginConfig {
  // Get baseUrl and ensure it has /api/v4 suffix
  let baseUrl = process.env.MATTERMOST_URL || DEFAULT_MATTERMOST_CONFIG.baseUrl;
  if (!baseUrl.includes("/api/v4")) {
    baseUrl = baseUrl.replace(/\/$/, "") + "/api/v4";
  }

  // Get wsUrl and ensure it has /api/v4/websocket suffix
  let wsUrl = process.env.MATTERMOST_WS_URL || DEFAULT_MATTERMOST_CONFIG.wsUrl;
  if (!wsUrl.includes("/api/v4/websocket")) {
    wsUrl = wsUrl.replace(/\/$/, "").replace(/\/websocket$/, "");
    wsUrl = wsUrl + "/api/v4/websocket";
  }

  const token = process.env.MATTERMOST_TOKEN || DEFAULT_MATTERMOST_CONFIG.token;

  const config: PluginConfig = {
    mattermost: {
      baseUrl,
      wsUrl,
      token,
      botUsername: process.env.MATTERMOST_BOT_USERNAME,
      defaultTeam: process.env.MATTERMOST_TEAM || DEFAULT_MATTERMOST_CONFIG.defaultTeam,
      debug: process.env.MATTERMOST_DEBUG === "true" || DEFAULT_MATTERMOST_CONFIG.debug,
      reconnectInterval:
        parseInt(process.env.MATTERMOST_RECONNECT_INTERVAL || "") ||
        DEFAULT_MATTERMOST_CONFIG.reconnectInterval,
      maxReconnectAttempts:
        parseInt(process.env.MATTERMOST_MAX_RECONNECT_ATTEMPTS || "") ||
        DEFAULT_MATTERMOST_CONFIG.maxReconnectAttempts,
      autoConnect: process.env.MATTERMOST_AUTO_CONNECT !== "false",
      ownerUserId: process.env.MATTERMOST_OWNER_USER_ID || undefined,
    },
    streaming: {
      bufferSize: parseInt(process.env.OPENCODE_MM_BUFFER_SIZE || "") || 50,
      maxDelay: parseInt(process.env.OPENCODE_MM_MAX_DELAY || "") || 500,
      editRateLimit: parseInt(process.env.OPENCODE_MM_EDIT_RATE_LIMIT || "") || 10,
      maxPostLength: parseInt(process.env.OPENCODE_MM_MAX_POST_LENGTH || "") || 15000,
    },
    notifications: {
      onCompletion: process.env.OPENCODE_MM_NOTIFY_COMPLETION !== "false",
      onPermissionRequest: process.env.OPENCODE_MM_NOTIFY_PERMISSION !== "false",
      onError: process.env.OPENCODE_MM_NOTIFY_ERROR !== "false",
      onStatusUpdate: process.env.OPENCODE_MM_NOTIFY_STATUS !== "false",
      statusInterval: parseInt(process.env.OPENCODE_MM_STATUS_INTERVAL || "") || 30000,
    },
    sessions: {
      timeout: parseInt(process.env.OPENCODE_MM_SESSION_TIMEOUT || "") || 3600000,
      maxSessions: parseInt(process.env.OPENCODE_MM_MAX_SESSIONS || "") || 50,
      allowedUsers: process.env.OPENCODE_MM_ALLOWED_USERS?.split(",").filter(Boolean) || [],
    },
    files: {
      tempDir: process.env.OPENCODE_MM_TEMP_DIR || "/tmp/opencode-mm-plugin",
      maxFileSize: parseInt(process.env.OPENCODE_MM_MAX_FILE_SIZE || "") || 10485760,
      allowedExtensions:
        process.env.OPENCODE_MM_ALLOWED_EXTENSIONS?.split(",").filter(Boolean) || ["*"],
    },
    sessionSelection: {
      commandPrefix: process.env.OPENCODE_MM_COMMAND_PREFIX || "!",
      autoSelectSingle: process.env.OPENCODE_MM_AUTO_SELECT !== "false",
      refreshIntervalMs: parseInt(process.env.OPENCODE_MM_SESSION_REFRESH_INTERVAL || "") || 60000,
      autoCreateSession: process.env.OPENCODE_MM_AUTO_CREATE_SESSION !== "false",
    },
  };

  // Validate configuration
  return PluginConfigSchema.parse(config);
}

export function createLogger(debug: boolean) {
  return {
    debug: (...args: unknown[]) => {
      if (debug) fileLog.debug(args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" "));
    },
    info: (...args: unknown[]) => {
      fileLog.info(args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" "));
    },
    warn: (...args: unknown[]) => {
      fileLog.warn(args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" "));
    },
    error: (...args: unknown[]) => {
      fileLog.error(args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" "));
    },
  };
}
