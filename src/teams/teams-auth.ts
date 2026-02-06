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
    const userId = context.activity.from?.aadObjectId ?? context.activity.from?.id ?? "";

    if (!userId) {
      return { authorized: false, userId: "", reason: "no_user_id", cached: false };
    }

    if (!this.config.azure.authorizedGroupId) {
      this.log.debug(`No authorized group configured, allowing user ${userId}`);
      return { authorized: true, userId, reason: "no_group_configured", cached: false };
    }

    const cached = this.cache.get(userId);
    if (cached && Date.now() - cached.checkedAt < this.config.bot.authCacheDurationMs) {
      this.log.debug(`Auth cache hit for ${userId}: authorized=${cached.authorized}`);
      return { authorized: cached.authorized, userId, cached: true };
    }

    try {
      const isMember = await this.checkGroupMembership(userId);
      this.cache.set(userId, { authorized: isMember, checkedAt: Date.now() });
      this.log.info(`Auth check for ${userId}: authorized=${isMember}`);
      return { authorized: isMember, userId, cached: false };
    } catch (error) {
      this.log.error(`Auth check failed for ${userId}: ${error}`);
      const staleCache = this.cache.get(userId);
      if (staleCache) {
        this.log.warn(`Using stale cache for ${userId}: authorized=${staleCache.authorized}`);
        return { authorized: staleCache.authorized, userId, reason: "stale_cache", cached: true };
      }
      return { authorized: false, userId, reason: "auth_check_failed", cached: false };
    }
  }

  async sendAccessDenied(context: TurnContext): Promise<void> {
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
          text: "You are not authorized to use this bot. Contact your administrator to request access to the OpenCode Teams Bot Users security group.",
          wrap: true,
          spacing: "medium",
        },
      ],
    };

    await context.sendActivity(
      MessageFactory.attachment(CardFactory.adaptiveCard(card))
    );
  }

  private async checkGroupMembership(userAadObjectId: string): Promise<boolean> {
    const token = await this.getGraphAccessToken();
    const groupId = this.config.azure.authorizedGroupId;

    const url = `https://graph.microsoft.com/v1.0/groups/${groupId}/members?$filter=id eq '${userAadObjectId}'&$select=id`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (response.status === 404) {
      this.log.warn(`Group ${groupId} not found in Azure AD`);
      return false;
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Graph API error: ${response.status} ${errorBody}`);
    }

    const data = (await response.json()) as GraphMemberCheckResponse;
    return data.value.length > 0;
  }

  private async getGraphAccessToken(): Promise<string> {
    if (this.graphAccessToken && Date.now() < this.graphTokenExpiresAt - 60_000) {
      return this.graphAccessToken;
    }

    const tenantId = this.config.azure.tenantId;
    const clientId = this.config.azure.appId;
    const clientSecret = this.config.azure.appPassword;

    const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

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
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Token request failed: ${response.status} ${errorBody}`);
    }

    const tokenData = (await response.json()) as { access_token: string; expires_in: number };
    this.graphAccessToken = tokenData.access_token;
    this.graphTokenExpiresAt = Date.now() + tokenData.expires_in * 1000;

    this.log.info("Graph API access token acquired");
    return this.graphAccessToken;
  }

  clearCache(userId?: string): void {
    if (userId) {
      this.cache.delete(userId);
      this.log.debug(`Cleared auth cache for ${userId}`);
    } else {
      this.cache.clear();
      this.log.debug("Cleared all auth cache");
    }
  }

  getCacheStats(): { size: number; entries: Array<{ userId: string; authorized: boolean; age: number }> } {
    const entries = Array.from(this.cache.entries()).map(([userId, result]) => ({
      userId,
      authorized: result.authorized,
      age: Date.now() - result.checkedAt,
    }));
    return { size: this.cache.size, entries };
  }

  destroy(): void {
    this.cache.clear();
    this.graphAccessToken = null;
    this.log.info("TeamsAuthHandler destroyed");
  }
}

let authInstance: TeamsAuthHandler | null = null;

export function getTeamsAuthHandler(config?: TeamsConfig): TeamsAuthHandler {
  if (!authInstance && config) {
    authInstance = new TeamsAuthHandler(config);
  }
  if (!authInstance) {
    throw new Error("TeamsAuthHandler not initialized. Call getTeamsAuthHandler with config first.");
  }
  return authInstance;
}

export function clearTeamsAuthHandler(): void {
  authInstance?.destroy();
  authInstance = null;
}
