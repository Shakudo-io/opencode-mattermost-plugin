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
  ConfigurationBotFrameworkAuthentication,
  ConfigurationBotFrameworkAuthenticationOptions,
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
  const teamsConfig = config ?? getTeamsConfig();

  const log = teamsLog.withContext("TeamsAdapter");
  log.info("Creating CloudAdapter for MS Teams bot");

  // Build authentication configuration for single-tenant (Shakudo corporate)
  const authConfig: ConfigurationBotFrameworkAuthenticationOptions = {
    MicrosoftAppId: teamsConfig.azure.appId,
    MicrosoftAppPassword: teamsConfig.azure.appPassword,
    MicrosoftAppTenantId: teamsConfig.azure.tenantId,
    MicrosoftAppType: "SingleTenant",
  };

  log.debug(`Configuring adapter for tenant: ${teamsConfig.azure.tenantId.substring(0, 8)}...`);

  // Create authentication instance
  const botFrameworkAuth = new ConfigurationBotFrameworkAuthentication(authConfig);

  // Create adapter with authentication
  // The CloudAdapter automatically validates tokens on incoming requests
  const adapter = new CloudAdapter(botFrameworkAuth);

  // Configure error handler
  adapter.onTurnError = async (context, error) => {
    log.error(`[onTurnError] Unhandled error: ${error.message}`);
    log.error(`[onTurnError] Stack: ${error.stack}`);

    // Log activity details for debugging
    if (context.activity) {
      log.error(`[onTurnError] Activity type: ${context.activity.type}`);
      log.error(`[onTurnError] Activity channel: ${context.activity.channelId}`);
      log.error(`[onTurnError] Conversation ID: ${context.activity.conversation?.id}`);
    }

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
  if (!adapterInstance) {
    adapterInstance = createTeamsAdapter();
  }
  return adapterInstance;
}

/**
 * Clear the cached adapter instance
 *
 * Useful for testing or when configuration changes.
 */
export function clearAdapterInstance(): void {
  adapterInstance = null;
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

    log.debug("Adapter configuration validated successfully");
    return true;
  } catch (error) {
    log.error(`Configuration validation failed: ${error}`);
    return false;
  }
}
