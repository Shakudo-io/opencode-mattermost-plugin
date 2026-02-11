/**
 * MS Teams Bot Framework Adapter
 *
 * Configures the CloudAdapter for Azure AD single-tenant authentication.
 * The CloudAdapter is the modern replacement for BotFrameworkAdapter.
 *
 * Token validation is handled automatically by the CloudAdapter when configured
 * with BotFrameworkAuthentication credentials.
 */

import {
  CloudAdapter,
  ConfigurationServiceClientCredentialFactory,
  ConfigurationBotFrameworkAuthentication,
} from "botbuilder";
import { teamsLog } from "./teams-logger.js";
import { getTeamsConfig, type TeamsConfig } from "./teams-config.js";

// =============================================================================
// Adapter Factory
// =============================================================================

/**
 * Create a configured CloudAdapter for MS Teams
 *
 * The CloudAdapter handles:
 * - Token validation for incoming Bot Framework messages
 * - Automatic retry on throttled responses
 * - Proper channel-specific formatting
 *
 * @param config Optional TeamsConfig (uses cached config if not provided)
 * @returns Configured CloudAdapter instance
 */
export function createTeamsAdapter(config?: TeamsConfig): CloudAdapter {
  const log = teamsLog.withContext("TeamsAdapter");
  log.debug("createTeamsAdapter entry");
  const teamsConfig = config ?? getTeamsConfig();
  log.info("Creating CloudAdapter for MS Teams bot", {
    appId: teamsConfig.azure.appId,
    tenantId: teamsConfig.azure.tenantId,
  });

  log.debug(`Configuring adapter for tenant: ${teamsConfig.azure.tenantId.substring(0, 8)}...`);

  // Build credentials factory for single-tenant (Shakudo corporate)
  // This is the pattern used by Microsoft's official Teams samples
  const credentialsFactory = new ConfigurationServiceClientCredentialFactory({
    MicrosoftAppId: teamsConfig.azure.appId,
    MicrosoftAppPassword: teamsConfig.azure.appPassword,
    MicrosoftAppTenantId: teamsConfig.azure.tenantId,
    MicrosoftAppType: "SingleTenant",
  });

  // Create authentication instance with empty config + factory
  // The empty first arg is critical — it tells the SDK to use the factory's
  // credential handling instead of the default token endpoint
  const botFrameworkAuth = new ConfigurationBotFrameworkAuthentication(
    {},
    credentialsFactory
  );

  // Create adapter with authentication
  // The CloudAdapter automatically validates tokens on incoming requests
  const adapter = new CloudAdapter(botFrameworkAuth);

  // Configure error handler
  adapter.onTurnError = async (context, error) => {
    log.error("[onTurnError] Unhandled error", {
      message: error.message,
      stack: error.stack,
    });

    const activity = context.activity;
    log.error("[onTurnError] Activity context", {
      type: activity?.type,
      fromId: activity?.from?.id,
      conversationId: activity?.conversation?.id,
      channelId: activity?.channelId,
    });

    // Send a generic error message to the user (if possible)
    // This might fail if the error is related to sending messages
    try {
      await context.sendActivity("Sorry, something went wrong. Please try again.");
    } catch (sendError) {
      log.error(`[onTurnError] Failed to send error message to user: ${sendError}`);
    }

    // In production, you might want to:
    // - Log to telemetry service
    // - Clear conversation state
    // - Notify administrators
  };

  log.info("CloudAdapter created successfully");
  log.debug("createTeamsAdapter exit");
  return adapter;
}

// =============================================================================
// Adapter Singleton
// =============================================================================

let adapterInstance: CloudAdapter | null = null;

/**
 * Get the singleton CloudAdapter instance
 *
 * Creates the adapter on first call, returns cached instance after.
 * Use clearAdapterInstance() to reset if configuration changes.
 *
 * @returns CloudAdapter instance
 */
export function getTeamsAdapter(): CloudAdapter {
  const log = teamsLog.withContext("TeamsAdapter");
  log.debug("getTeamsAdapter entry");
  if (!adapterInstance) {
    adapterInstance = createTeamsAdapter();
  }
  log.debug("getTeamsAdapter exit");
  return adapterInstance;
}

/**
 * Clear the cached adapter instance
 *
 * Useful for testing or when configuration changes.
 */
export function clearAdapterInstance(): void {
  const log = teamsLog.withContext("TeamsAdapter");
  log.info("clearAdapterInstance called");
  log.debug("clearAdapterInstance entry");
  adapterInstance = null;
  log.debug("clearAdapterInstance exit");
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Validate that the adapter can authenticate
 *
 * This is a lightweight check that verifies the configuration is valid.
 * Actual token validation happens on each incoming request.
 *
 * @returns true if configuration appears valid
 */
export function validateAdapterConfig(): boolean {
  const log = teamsLog.withContext("TeamsAdapter");
  log.debug("validateAdapterConfig entry");
  try {
    const config = getTeamsConfig();

    // Check required fields are present
    if (!config.azure.appId || config.azure.appId.length < 10) {
      log.error("AZURE_APP_ID is missing or too short");
      return false;
    }

    if (!config.azure.appPassword || config.azure.appPassword.length < 10) {
      log.error("AZURE_APP_PASSWORD is missing or too short");
      return false;
    }

    if (!config.azure.tenantId || config.azure.tenantId.length < 10) {
      log.error("AZURE_TENANT_ID is missing or too short");
      return false;
    }

    log.info("Adapter configuration validated successfully", {
      appId: config.azure.appId,
      tenantId: config.azure.tenantId,
    });
    log.debug("validateAdapterConfig exit: success");
    return true;
  } catch (error) {
    log.error(`Configuration validation failed: ${error}`);
    log.debug("validateAdapterConfig exit: failure");
    return false;
  }
}
