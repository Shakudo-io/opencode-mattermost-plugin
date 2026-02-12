import { TurnContext, MessageFactory, CardFactory } from "botbuilder";
import { teamsLog } from "./teams-logger.js";
import type { TeamsConfig } from "./teams-config.js";

interface CachedAuthResult {
  authorized: boolean;
  checkedAt: number;
}

interface GraphMemberCheckResponse {
  value: Array<{ id: string }>;
}

export interface AuthCheckResult {
  authorized: boolean;
  userId: string;
  reason?: string;
  cached: boolean;
}

export class TeamsAuthHandler {
  private readonly log = teamsLog.withContext("TeamsAuth");
  private readonly config: TeamsConfig;
  private readonly cache = new Map<string, CachedAuthResult>();
  private graphAccessToken: string | null = null;
  private graphTokenExpiresAt = 0;

  constructor(config: TeamsConfig) {
    this.config = config;
    this.log.info("TeamsAuthHandler initialized");
  }

  async checkAuthorization(context: TurnContext): Promise<AuthCheckResult> {
    this.log.debug("checkAuthorization entry");
    const userId = context.activity.from?.aadObjectId ?? context.activity.from?.id;

    if (!userId) {
      this.log.error("Missing required user id for authorization", {
        activityType: context.activity.type,
        conversationId: context.activity.conversation?.id,
      });
      throw new Error("Missing required field: activity.from.id");
    }

    this.log.info("checkAuthorization", { userId });

    if (!this.config.azure.authorizedGroupId) {
      this.log.warn(`No authorized group configured - denying all users (set AZURE_AD_AUTHORIZED_GROUP_ID)`);
      this.log.debug("checkAuthorization exit: no group configured");
      return { authorized: false, userId, reason: "no_group_configured", cached: false };
    }

    const cached = this.cache.get(userId);
    if (cached && Date.now() - cached.checkedAt < this.config.bot.authCacheDurationMs) {
      const cacheAge = Date.now() - cached.checkedAt;
      this.log.info("Auth cache hit", { userId, authorized: cached.authorized, cacheAgeMs: cacheAge });
      this.log.debug("checkAuthorization exit: cache hit");
      return { authorized: cached.authorized, userId, cached: true };
    }

    this.log.info("Auth cache miss", { userId });

    try {
      const isMember = await this.checkGroupMembership(userId);
      this.cache.set(userId, { authorized: isMember, checkedAt: Date.now() });
      this.log.info(`Auth check for ${userId}: authorized=${isMember}`);
      this.log.debug("checkAuthorization exit: success");
      return { authorized: isMember, userId, cached: false };
    } catch (error) {
      this.log.error(`Auth check failed for ${userId}: ${error}`);
      const staleCache = this.cache.get(userId);
      const STALE_GRACE_MS = 5 * 60 * 1000; // 5 minutes grace window
      if (staleCache && (Date.now() - staleCache.checkedAt) < (this.config.bot.authCacheDurationMs + STALE_GRACE_MS)) {
        this.log.warn(`Using stale cache (within grace) for ${userId}: authorized=${staleCache.authorized}`);
        this.log.debug("checkAuthorization exit: stale cache");
        return { authorized: staleCache.authorized, userId, reason: "stale_cache_grace", cached: true };
      }
      this.log.error(`Auth check failed and no valid cache for ${userId} - denying access`);
      this.log.debug("checkAuthorization exit: failure");
      return { authorized: false, userId, reason: "auth_check_failed_no_cache", cached: false };
    }
  }

  async sendAccessDenied(context: TurnContext): Promise<void> {
    const userId = context.activity.from?.id;
    this.log.info("sendAccessDenied", { userId });
    const card = {
      type: "AdaptiveCard",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      version: "1.4",
      body: [
        {
          type: "TextBlock",
          text: "🔒 Access Denied",
          size: "large",
          weight: "bolder",
          color: "attention",
        },
        {
          type: "TextBlock",
          text: "You are not authorized to use this bot. Contact your administrator to request access to the OpenCode Teams Bot Users security group to use Kaji.",
          wrap: true,
          spacing: "medium",
        },
      ],
    };

    await context.sendActivity(
      MessageFactory.attachment(CardFactory.adaptiveCard(card))
    );
    this.log.debug("sendAccessDenied exit");
  }

  private static readonly GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  private async checkGroupMembership(userAadObjectId: string): Promise<boolean> {
    this.log.debug("checkGroupMembership entry", { userAadObjectId });
    if (!TeamsAuthHandler.GUID_RE.test(userAadObjectId)) {
      this.log.warn(`Invalid AAD Object ID format: ${userAadObjectId.substring(0, 8)}...`);
      this.log.debug("checkGroupMembership exit: invalid id");
      return false;
    }

    const token = await this.getGraphAccessToken();
    const groupId = this.config.azure.authorizedGroupId;

    const url = `https://graph.microsoft.com/v1.0/groups/${groupId}/members?$filter=id eq '${userAadObjectId}'&$select=id`;
    const sanitizedUrl = url.replace(userAadObjectId, "[REDACTED]");

    this.log.debug("Graph membership check", { url: sanitizedUrl });

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 404) {
      this.log.warn(`Group ${groupId} not found in Azure AD`);
      this.log.info("Graph membership response", { status: response.status, memberCount: 0 });
      this.log.debug("checkGroupMembership exit: group not found");
      return false;
    }

    if (!response.ok) {
      const errorBody = await response.text();
      this.log.error("Graph membership check failed", {
        url: sanitizedUrl,
        status: response.status,
        errorBody,
      });
      this.log.debug("checkGroupMembership exit: error");
      throw new Error(`Graph API error: ${response.status} ${errorBody}`);
    }

    const data = (await response.json()) as GraphMemberCheckResponse;
    this.log.info("Graph membership response", { status: response.status, memberCount: data.value.length });
    this.log.debug("checkGroupMembership exit: success");
    return data.value.length > 0;
  }

  private async getGraphAccessToken(): Promise<string> {
    this.log.debug("getGraphAccessToken entry");
    if (this.graphAccessToken && Date.now() < this.graphTokenExpiresAt - 60_000) {
      this.log.debug("getGraphAccessToken exit: cached");
      return this.graphAccessToken;
    }

    const tenantId = this.config.azure.tenantId;
    const clientId = this.config.azure.appId;
    const clientSecret = this.config.azure.appPassword;

    const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
    this.log.info("Graph token request", { url: tokenUrl });

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    });

    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      this.log.error("Graph token request failed", { url: tokenUrl, status: response.status, errorBody });
      this.log.debug("getGraphAccessToken exit: error");
      throw new Error(`Token request failed: ${response.status} ${errorBody}`);
    }

    const tokenData = (await response.json()) as { access_token: string; expires_in: number };
    this.graphAccessToken = tokenData.access_token;
    this.graphTokenExpiresAt = Date.now() + tokenData.expires_in * 1000;

    this.log.info("Graph API access token acquired", { expiresAt: this.graphTokenExpiresAt });
    this.log.debug("getGraphAccessToken exit: success");
    return this.graphAccessToken;
  }

  clearCache(userId?: string): void {
    this.log.debug("clearCache entry", { userId });
    if (userId) {
      this.cache.delete(userId);
      this.log.debug(`Cleared auth cache for ${userId}`);
    } else {
      this.cache.clear();
      this.log.debug("Cleared all auth cache");
    }
    this.log.debug("clearCache exit");
  }

  getCacheStats(): { size: number; entries: Array<{ userId: string; authorized: boolean; age: number }> } {
    this.log.debug("getCacheStats entry");
    const entries = Array.from(this.cache.entries()).map(([userId, result]) => ({
      userId,
      authorized: result.authorized,
      age: Date.now() - result.checkedAt,
    }));
    this.log.debug("getCacheStats exit", { size: this.cache.size });
    return { size: this.cache.size, entries };
  }

  destroy(): void {
    const stats = this.getCacheStats();
    this.log.info("destroy", { cacheSize: stats.size, entryCount: stats.entries.length });
    this.cache.clear();
    this.graphAccessToken = null;
    this.log.info("TeamsAuthHandler destroyed");
  }
}

let authInstance: TeamsAuthHandler | null = null;

export function getTeamsAuthHandler(config?: TeamsConfig): TeamsAuthHandler {
  const log = teamsLog.withContext("TeamsAuth");
  log.debug("getTeamsAuthHandler entry");
  if (!authInstance && config) {
    authInstance = new TeamsAuthHandler(config);
  }
  if (!authInstance) {
    throw new Error("TeamsAuthHandler not initialized. Call getTeamsAuthHandler with config first.");
  }
  log.debug("getTeamsAuthHandler exit");
  return authInstance;
}

export function clearTeamsAuthHandler(): void {
  const log = teamsLog.withContext("TeamsAuth");
  log.debug("clearTeamsAuthHandler entry");
  authInstance?.destroy();
  authInstance = null;
  log.debug("clearTeamsAuthHandler exit");
}
