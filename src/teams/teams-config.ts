/**
 * MS Teams Bot Configuration
 *
 * Zod schema validation for all Teams-specific environment variables.
 * This follows the same pattern as the Mattermost config in src/config.ts
 */

import { z } from "zod";
import { log } from "../logger.js";

// =============================================================================
// Schema Definitions
// =============================================================================

/**
 * Azure AD Configuration
 * Required for Bot Framework authentication
 */
const AzureConfigSchema = z.object({
  // Required - Bot Framework credentials
  appId: z.string().min(1, "AZURE_APP_ID is required"),
  appPassword: z.string().min(1, "AZURE_APP_PASSWORD is required"),
  tenantId: z.string().min(1, "AZURE_TENANT_ID is required"),

  // Required - Authorization
  authorizedGroupId: z.string().min(1, "AZURE_AD_AUTHORIZED_GROUP_ID is required"),

  // Optional - Bot Framework endpoint (for multi-tenant scenarios)
  botEndpoint: z.string().url().optional(),
});

/**
 * Teams Bot Server Configuration
 */
const TeamsServerConfigSchema = z.object({
  // Port for the Express server (default: 3978 - standard Bot Framework port)
  port: z.number().int().min(1).max(65535).default(3978),

  // Base path for bot endpoints (default: /api)
  basePath: z.string().default("/api"),

  // Health check endpoint path
  healthPath: z.string().default("/health"),

  // Messages endpoint path (Bot Framework standard)
  messagesPath: z.string().default("/messages"),
});

/**
 * Teams Bot Behavior Configuration
 */
const TeamsBotConfigSchema = z.object({
  // Card update interval during streaming (ms) - Teams doesn't support real-time updates
  cardUpdateInterval: z.number().int().min(1000).default(5000),

  // Maximum card size before pagination (Teams limit is ~28KB)
  maxCardSize: z.number().int().default(25000),

  // Rate limit for Teams API calls (requests per second)
  rateLimit: z.number().int().min(1).max(50).default(30),

  // Question expiration time (ms) - default 30 minutes
  questionExpirationMs: z.number().int().default(30 * 60 * 1000),

  // Permission request expiration time (ms) - default 5 minutes
  permissionExpirationMs: z.number().int().default(5 * 60 * 1000),

  // Guest approval expiration time (ms) - default 30 minutes
  guestApprovalExpirationMs: z.number().int().default(30 * 60 * 1000),

  // Authorization check cache duration (ms) - default 1 hour
  authCacheDurationMs: z.number().int().default(60 * 60 * 1000),
});

/**
 * Teams-specific Logging Configuration
 */
const TeamsLoggingConfigSchema = z.object({
  // Log file path (default: same directory as Mattermost plugin logs)
  logFile: z.string().default("/tmp/opencode-teams-plugin.log"),

  // Debug mode
  debug: z.boolean().default(false),
});

/**
 * OpenCode Server Connection Configuration
 */
const OpenCodeConnectionConfigSchema = z.object({
  // OpenCode server URL
  serverUrl: z.string().url().default("http://localhost:4096"),

  // Connection timeout (ms)
  connectionTimeout: z.number().int().default(5000),

  // Reconnection interval on failure (ms)
  reconnectInterval: z.number().int().default(5000),

  // Maximum reconnection attempts
  maxReconnectAttempts: z.number().int().default(10),
});

/**
 * Combined Teams Configuration Schema
 */
const TeamsConfigSchema = z.object({
  azure: AzureConfigSchema,
  server: TeamsServerConfigSchema,
  bot: TeamsBotConfigSchema,
  logging: TeamsLoggingConfigSchema,
  opencode: OpenCodeConnectionConfigSchema,
});

// =============================================================================
// Type Exports
// =============================================================================

export type AzureConfig = z.infer<typeof AzureConfigSchema>;
export type TeamsServerConfig = z.infer<typeof TeamsServerConfigSchema>;
export type TeamsBotConfig = z.infer<typeof TeamsBotConfigSchema>;
export type TeamsLoggingConfig = z.infer<typeof TeamsLoggingConfigSchema>;
export type OpenCodeConnectionConfig = z.infer<typeof OpenCodeConnectionConfigSchema>;
export type TeamsConfig = z.infer<typeof TeamsConfigSchema>;

// =============================================================================
// Configuration Loading
// =============================================================================

/**
 * Load Teams configuration from environment variables
 *
 * Required environment variables:
 * - AZURE_APP_ID: Azure AD application (client) ID
 * - AZURE_APP_PASSWORD: Azure AD application secret
 * - AZURE_TENANT_ID: Azure AD tenant ID
 * - AZURE_AD_AUTHORIZED_GROUP_ID: Azure AD group ID for authorization
 *
 * Optional environment variables (with defaults):
 * - TEAMS_BOT_PORT: Express server port (default: 3978)
 * - TEAMS_LOG_FILE: Log file path (default: /tmp/opencode-teams-plugin.log)
 * - TEAMS_DEBUG: Enable debug logging (default: false)
 * - TEAMS_BOT_ENDPOINT: Bot Framework messaging endpoint URL
 * - OPENCODE_SERVER_URL: OpenCode server URL (default: http://localhost:4096)
 *
 * @returns Validated TeamsConfig object
 * @throws ZodError if required config is missing or invalid
 */
export function loadTeamsConfig(): TeamsConfig {
  const config: TeamsConfig = {
    azure: {
      appId: process.env.AZURE_APP_ID || "",
      appPassword: process.env.AZURE_APP_PASSWORD || "",
      tenantId: process.env.AZURE_TENANT_ID || "",
      authorizedGroupId: process.env.AZURE_AD_AUTHORIZED_GROUP_ID || "",
      botEndpoint: process.env.TEAMS_BOT_ENDPOINT || undefined,
    },
    server: {
      port: parseInt(process.env.TEAMS_BOT_PORT || "") || 3978,
      basePath: process.env.TEAMS_BASE_PATH || "/api",
      healthPath: process.env.TEAMS_HEALTH_PATH || "/health",
      messagesPath: process.env.TEAMS_MESSAGES_PATH || "/messages",
    },
    bot: {
      cardUpdateInterval: parseInt(process.env.TEAMS_CARD_UPDATE_INTERVAL || "") || 5000,
      maxCardSize: parseInt(process.env.TEAMS_MAX_CARD_SIZE || "") || 25000,
      rateLimit: parseInt(process.env.TEAMS_RATE_LIMIT || "") || 30,
      questionExpirationMs: parseInt(process.env.TEAMS_QUESTION_EXPIRATION_MS || "") || 30 * 60 * 1000,
      permissionExpirationMs: parseInt(process.env.TEAMS_PERMISSION_EXPIRATION_MS || "") || 5 * 60 * 1000,
      guestApprovalExpirationMs: parseInt(process.env.TEAMS_GUEST_APPROVAL_EXPIRATION_MS || "") || 30 * 60 * 1000,
      authCacheDurationMs: parseInt(process.env.TEAMS_AUTH_CACHE_DURATION_MS || "") || 60 * 60 * 1000,
    },
    logging: {
      logFile: process.env.TEAMS_LOG_FILE || "/tmp/opencode-teams-plugin.log",
      debug: process.env.TEAMS_DEBUG === "true",
    },
    opencode: {
      serverUrl: process.env.OPENCODE_SERVER_URL || "http://localhost:4096",
      connectionTimeout: parseInt(process.env.OPENCODE_CONNECTION_TIMEOUT || "") || 5000,
      reconnectInterval: parseInt(process.env.OPENCODE_RECONNECT_INTERVAL || "") || 5000,
      maxReconnectAttempts: parseInt(process.env.OPENCODE_MAX_RECONNECT_ATTEMPTS || "") || 10,
    },
  };

  // Validate configuration
  return TeamsConfigSchema.parse(config);
}

/**
 * Validate Teams configuration and return helpful error messages
 *
 * @returns Object with isValid flag and array of error messages
 */
export function validateTeamsConfig(): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check required Azure config
  if (!process.env.AZURE_APP_ID) {
    errors.push("AZURE_APP_ID is required - Azure AD application (client) ID");
  }
  if (!process.env.AZURE_APP_PASSWORD) {
    errors.push("AZURE_APP_PASSWORD is required - Azure AD application secret");
  }
  if (!process.env.AZURE_TENANT_ID) {
    errors.push("AZURE_TENANT_ID is required - Azure AD tenant ID");
  }
  if (!process.env.AZURE_AD_AUTHORIZED_GROUP_ID) {
    errors.push("AZURE_AD_AUTHORIZED_GROUP_ID is required - Azure AD group ID for user authorization");
  }

  // Validate port if provided
  const port = parseInt(process.env.TEAMS_BOT_PORT || "");
  if (process.env.TEAMS_BOT_PORT && (isNaN(port) || port < 1 || port > 65535)) {
    errors.push("TEAMS_BOT_PORT must be a valid port number (1-65535)");
  }

  // Validate URLs if provided
  if (process.env.TEAMS_BOT_ENDPOINT) {
    try {
      new URL(process.env.TEAMS_BOT_ENDPOINT);
    } catch {
      errors.push("TEAMS_BOT_ENDPOINT must be a valid URL");
    }
  }

  if (process.env.OPENCODE_SERVER_URL) {
    try {
      new URL(process.env.OPENCODE_SERVER_URL);
    } catch {
      errors.push("OPENCODE_SERVER_URL must be a valid URL");
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Log configuration at startup (with secrets redacted)
 *
 * @param config Validated TeamsConfig object
 */
export function logTeamsConfig(config: TeamsConfig): void {
  const redact = (value: string): string => {
    if (!value) return "(not set)";
    if (value.length <= 8) return "****";
    return value.substring(0, 4) + "****" + value.substring(value.length - 4);
  };

  log.info("=== MS Teams Bot Configuration ===");
  log.info("Azure Configuration:");
  log.info(`  App ID: ${redact(config.azure.appId)}`);
  log.info(`  App Password: ${redact(config.azure.appPassword)}`);
  log.info(`  Tenant ID: ${redact(config.azure.tenantId)}`);
  log.info(`  Authorized Group ID: ${redact(config.azure.authorizedGroupId)}`);
  log.info(`  Bot Endpoint: ${config.azure.botEndpoint || "(not set)"}`);

  log.info("Server Configuration:");
  log.info(`  Port: ${config.server.port}`);
  log.info(`  Base Path: ${config.server.basePath}`);
  log.info(`  Messages Path: ${config.server.messagesPath}`);
  log.info(`  Health Path: ${config.server.healthPath}`);

  log.info("Bot Configuration:");
  log.info(`  Card Update Interval: ${config.bot.cardUpdateInterval}ms`);
  log.info(`  Max Card Size: ${config.bot.maxCardSize} bytes`);
  log.info(`  Rate Limit: ${config.bot.rateLimit} RPS`);
  log.info(`  Question Expiration: ${config.bot.questionExpirationMs / 60000} minutes`);
  log.info(`  Permission Expiration: ${config.bot.permissionExpirationMs / 60000} minutes`);

  log.info("Logging Configuration:");
  log.info(`  Log File: ${config.logging.logFile}`);
  log.info(`  Debug: ${config.logging.debug}`);

  log.info("OpenCode Connection:");
  log.info(`  Server URL: ${config.opencode.serverUrl}`);
  log.info(`  Connection Timeout: ${config.opencode.connectionTimeout}ms`);
  log.info(`  Reconnect Interval: ${config.opencode.reconnectInterval}ms`);
  log.info(`  Max Reconnect Attempts: ${config.opencode.maxReconnectAttempts}`);

  log.info("=================================");
}

// =============================================================================
// Singleton Instance
// =============================================================================

let cachedConfig: TeamsConfig | null = null;

/**
 * Get Teams configuration (cached singleton)
 *
 * @returns Validated TeamsConfig object
 * @throws ZodError if configuration is invalid
 */
export function getTeamsConfig(): TeamsConfig {
  if (!cachedConfig) {
    cachedConfig = loadTeamsConfig();
  }
  return cachedConfig;
}

/**
 * Clear cached configuration (useful for testing)
 */
export function clearTeamsConfigCache(): void {
  cachedConfig = null;
}
