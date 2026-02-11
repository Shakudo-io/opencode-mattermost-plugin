/**
 * OpenCode Bridge for MS Teams
 *
 * Connects the Teams bot to OpenCode local server (localhost:4096).
 * Handles:
 * - Session discovery and management
 * - Prompt forwarding to correct sessions
 * - Response chunk aggregation
 * - Bi-directional TUI sync
 * - Connection recovery on OpenCode restarts
 */

import { teamsLog } from "./teams-logger.js";
import type { TeamsConfig, OpenCodeConnectionConfig } from "./teams-config.js";
import {
  OpenCodeSessionRegistry,
  type OpenCodeSessionInfo,
  type OpenCodeSession,
  type OpenCodeClientSession,
} from "../opencode-session-registry.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Response chunk from OpenCode streaming
 */
export interface ResponseChunk {
  type: "text" | "tool_start" | "tool_end" | "error" | "complete";
  content?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  error?: string;
  sessionId: string;
}

/**
 * Callback for streaming response chunks
 */
export type ResponseChunkCallback = (chunk: ResponseChunk) => void | Promise<void>;

/**
 * Callback for session events
 */
export type SessionEventCallback = (event: SessionEvent) => void | Promise<void>;

/**
 * Session event types
 */
export interface SessionEvent {
  type: "session_created" | "session_deleted" | "session_idle" | "question_asked" | "permission_requested";
  sessionId: string;
  session?: OpenCodeSessionInfo;
  data?: Record<string, unknown>;
}

/**
 * Connection state
 */
export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting" | "error";

/**
 * OpenCode Bridge options
 */
export interface OpenCodeBridgeOptions {
  config: TeamsConfig;
  onResponseChunk?: ResponseChunkCallback;
  onSessionEvent?: SessionEventCallback;
  onConnectionStateChange?: (state: ConnectionState) => void;
}

// =============================================================================
// OpenCode Bridge Implementation
// =============================================================================

export class OpenCodeBridge {
  private readonly log = teamsLog.withContext("OpenCodeBridge");
  private readonly config: OpenCodeConnectionConfig;
  private readonly sessionRegistry: OpenCodeSessionRegistry;

  private connectionState: ConnectionState = "disconnected";
  private stateTransitionReason: string | undefined;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

  private responseChunkCallback?: ResponseChunkCallback;
  private sessionEventCallback?: SessionEventCallback;
  private connectionStateCallback?: (state: ConnectionState) => void;

  // Track active prompts for response aggregation
  private activePrompts: Map<string, {
    sessionId: string;
    chunks: string[];
    startTime: number;
  }> = new Map();

  constructor(options: OpenCodeBridgeOptions) {
    this.config = options.config.opencode;
    this.responseChunkCallback = options.onResponseChunk;
    this.sessionEventCallback = options.onSessionEvent;
    this.connectionStateCallback = options.onConnectionStateChange;

    // Initialize session registry with 60s refresh interval
    this.sessionRegistry = new OpenCodeSessionRegistry(60000);

    // Register session event callbacks
    this.sessionRegistry.onNewSession((session) => {
      this.log.info(`New session discovered: ${session.shortId} (${session.projectName})`);
      this.emitSessionEvent({
        type: "session_created",
        sessionId: session.id,
        session,
      });
    });

    this.sessionRegistry.onSessionDeleted((sessionId, session) => {
      this.log.info(`Session deleted: ${session.shortId} (${session.projectName})`);
      this.emitSessionEvent({
        type: "session_deleted",
        sessionId,
        session,
      });
    });

    this.log.info("OpenCodeBridge initialized");
  }

  // ===========================================================================
  // Connection Management
  // ===========================================================================

  /**
   * Connect to OpenCode server
   */
  async connect(): Promise<boolean> {
    if (this.connectionState === "connected") {
      this.log.debug("Already connected to OpenCode");
      return true;
    }

    this.log.info(
      `Connect entry serverUrl=${this.config.serverUrl} currentState=${this.connectionState}`
    );
    this.markStateTransitionReason("connect_called");
    this.setConnectionState("connecting");
    this.log.info(`Connecting to OpenCode server at ${this.config.serverUrl}`);

    try {
      // Test connection with health check
      const isHealthy = await this.checkHealth();
      if (!isHealthy) {
        throw new Error("OpenCode server health check failed");
      }

      // Create client session interface for the registry
      const clientSession: OpenCodeClientSession = {
        list: async () => this.listSessionsFromServer(),
      };

      // Initialize and start session registry
      this.sessionRegistry.initialize(clientSession);
      await this.sessionRegistry.refresh();
      this.sessionRegistry.startAutoRefresh();

      // Start health check timer (every 30s)
      this.startHealthCheckTimer();

      this.reconnectAttempts = 0;
      this.markStateTransitionReason("connect_success");
      this.setConnectionState("connected");
      this.log.info(`Connected to OpenCode server. Found ${this.sessionRegistry.countAvailable()} sessions.`);

      return true;
    } catch (error) {
      this.log.error(`Failed to connect to OpenCode: ${error}`);
      this.markStateTransitionReason("connect_failed");
      this.setConnectionState("error");
      this.scheduleReconnect();
      return false;
    }
  }

  /**
   * Disconnect from OpenCode server
   */
  async disconnect(): Promise<void> {
    this.log.info("Disconnecting from OpenCode server");

    // Clear timers
    this.stopHealthCheckTimer();
    this.cancelReconnect();

    // Stop session registry
    this.sessionRegistry.stopAutoRefresh();
    this.sessionRegistry.clear();

    // Clear active prompts
    this.activePrompts.clear();

    this.markStateTransitionReason("disconnect_called");
    this.setConnectionState("disconnected");
    this.log.info("Disconnected from OpenCode server");
  }

  /**
   * Check connection health
   */
  private async checkHealth(): Promise<boolean> {
    const startTime = Date.now();
    const url = `${this.config.serverUrl}/`;
    this.log.debug(`Health check request url=${url}`);
    try {
      const response = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(this.config.connectionTimeout),
      });
      const elapsedMs = Date.now() - startTime;
      this.log.debug(
        `Health check response url=${url} status=${response.status} ok=${response.ok} latencyMs=${elapsedMs}`
      );
      return response.ok;
    } catch (error) {
      const elapsedMs = Date.now() - startTime;
      this.log.warn(`Health check failed url=${url} latencyMs=${elapsedMs} error=${error}`);
      return false;
    }
  }

  /**
   * List sessions from the OpenCode server
   */
  private async listSessionsFromServer(): Promise<{ data: OpenCodeSession[] | undefined }> {
    const startTime = Date.now();
    const url = `${this.config.serverUrl}/session`;
    this.log.debug(`List sessions request url=${url}`);
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(this.config.connectionTimeout),
      });

      if (!response.ok) {
        const elapsedMs = Date.now() - startTime;
        this.log.warn(
          `List sessions failed url=${url} status=${response.status} latencyMs=${elapsedMs}`
        );
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as OpenCodeSession[];
      const elapsedMs = Date.now() - startTime;
      this.log.debug(
        `List sessions response url=${url} status=${response.status} count=${data.length} latencyMs=${elapsedMs}`
      );
      return { data };
    } catch (error) {
      const elapsedMs = Date.now() - startTime;
      this.log.error(`Failed to list sessions: ${error}`);
      this.log.debug(`List sessions error url=${url} latencyMs=${elapsedMs}`);
      return { data: undefined };
    }
  }

  /**
   * Start health check timer
   */
  private startHealthCheckTimer(): void {
    if (this.healthCheckTimer) return;

    this.healthCheckTimer = setInterval(async () => {
      const isHealthy = await this.checkHealth();
      if (!isHealthy && this.connectionState === "connected") {
        this.log.warn("OpenCode server health check failed, attempting reconnect");
        this.markStateTransitionReason("health_check_failed");
        this.setConnectionState("reconnecting");
        this.scheduleReconnect();
      }
    }, 30000);
    this.log.info("Health check timer started intervalMs=30000");
  }

  /**
   * Stop health check timer
   */
  private stopHealthCheckTimer(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
      this.log.info("Health check timer stopped");
    }
  }

  /**
   * Schedule reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      this.log.error(`Max reconnect attempts (${this.config.maxReconnectAttempts}) reached`);
      this.markStateTransitionReason("max_reconnect_attempts_reached");
      this.setConnectionState("error");
      return;
    }

    const delay = this.config.reconnectInterval * Math.pow(2, Math.min(this.reconnectAttempts, 5));
    this.reconnectAttempts++;

    this.log.info(`Scheduling reconnect attempt ${this.reconnectAttempts} in ${delay}ms`);
    this.log.debug(`Reconnect timer started delayMs=${delay} attempt=${this.reconnectAttempts}`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      await this.connect();
    }, delay);
  }

  /**
   * Cancel pending reconnection
   */
  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.log.debug("Reconnect timer stopped");
    }
  }

  /**
   * Update connection state and notify callback
   */
  private setConnectionState(state: ConnectionState): void {
    if (this.connectionState === state) return;
    const previousState = this.connectionState;
    const reason = this.stateTransitionReason ?? "unspecified";
    this.connectionState = state;
    this.stateTransitionReason = undefined;
    this.log.info(
      `Connection state changed from=${previousState} to=${state} reason=${reason}`
    );
    this.connectionStateCallback?.(state);
  }

  private markStateTransitionReason(reason: string): void {
    this.stateTransitionReason = reason;
  }

  // ===========================================================================
  // Session Management
  // ===========================================================================

  /**
   * Get all available sessions
   */
  getSessions(): OpenCodeSessionInfo[] {
    return this.sessionRegistry.listAvailable();
  }

  /**
   * Get session by ID or short ID
   */
  getSession(idOrShortId: string): OpenCodeSessionInfo | null {
    return this.sessionRegistry.get(idOrShortId);
  }

  /**
   * Get the default session (most recently updated)
   */
  getDefaultSession(): OpenCodeSessionInfo | null {
    return this.sessionRegistry.getDefault();
  }

  /**
   * Set the default session
   */
  setDefaultSession(sessionId: string): boolean {
    return this.sessionRegistry.setDefault(sessionId);
  }

  /**
   * Refresh sessions from server
   */
  async refreshSessions(): Promise<void> {
    await this.sessionRegistry.refresh();
  }

  // ===========================================================================
  // Prompt Handling
  // ===========================================================================

  /**
   * Send a prompt to an OpenCode session
   *
   * @param sessionId - Session ID to send prompt to
   * @param prompt - The prompt text
   * @param onChunk - Optional callback for streaming chunks
   * @returns Aggregated response text, or null if failed
   */
  async sendPrompt(
    sessionId: string,
    prompt: string,
    onChunk?: ResponseChunkCallback
  ): Promise<string | null> {
    if (this.connectionState !== "connected") {
      this.log.error("Cannot send prompt: not connected to OpenCode");
      return null;
    }

    const session = this.sessionRegistry.get(sessionId);
    if (!session) {
      this.log.error(`Session not found: ${sessionId}`);
      return null;
    }

    const promptUrl = `${this.config.serverUrl}/session/${sessionId}/prompt`;
    this.log.info(
      `Send prompt entry sessionId=${sessionId} shortId=${session.shortId} promptLength=${prompt.length} url=${promptUrl}`
    );

    // Track active prompt for aggregation
    const promptId = `${sessionId}-${Date.now()}`;
    this.activePrompts.set(promptId, {
      sessionId,
      chunks: [],
      startTime: Date.now(),
    });

    try {
      const startTime = Date.now();
      const response = await fetch(promptUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "text/event-stream",
        },
        body: JSON.stringify({ prompt }),
      });
      const elapsedMs = Date.now() - startTime;
      this.log.info(
        `Send prompt response sessionId=${sessionId} status=${response.status} latencyMs=${elapsedMs}`
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Handle streaming response
      const aggregatedResponse = await this.handleStreamingResponse(
        promptId,
        sessionId,
        response,
        onChunk
      );

      return aggregatedResponse;
    } catch (error) {
      this.log.error(`Failed to send prompt sessionId=${sessionId} error=${error}`);

      // Emit error chunk
      const errorChunk: ResponseChunk = {
        type: "error",
        error: String(error),
        sessionId,
      };
      onChunk?.(errorChunk);
      this.responseChunkCallback?.(errorChunk);

      return null;
    } finally {
      this.activePrompts.delete(promptId);
    }
  }

  /**
   * Handle streaming response from OpenCode
   */
  private async handleStreamingResponse(
    promptId: string,
    sessionId: string,
    response: Response,
    onChunk?: ResponseChunkCallback
  ): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("No response body reader available");
    }

    const decoder = new TextDecoder();
    const promptState = this.activePrompts.get(promptId);
    if (!promptState) {
      throw new Error("Prompt state not found");
    }

    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE events
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") {
              this.log.debug(`SSE event received type=done dataLength=${data.length}`);
              // Stream complete
              const completeChunk: ResponseChunk = {
                type: "complete",
                sessionId,
              };
              onChunk?.(completeChunk);
              this.responseChunkCallback?.(completeChunk);
              continue;
            }

            try {
              const event = JSON.parse(data) as Record<string, unknown>;
              const eventType = String(event.type ?? "unknown");
              this.log.debug(
                `SSE event received type=${eventType} dataLength=${data.length}`
              );
              const chunk = this.parseSSEEvent(event, sessionId);
              if (chunk) {
                // Aggregate text chunks
                if (chunk.type === "text" && chunk.content) {
                  promptState.chunks.push(chunk.content);
                }

                // Emit chunk
                onChunk?.(chunk);
                this.responseChunkCallback?.(chunk);
              }
            } catch (error) {
              this.log.warn(
                `SSE event parse failed dataLength=${data.length} error=${error}`
              );
              this.log.debug(`SSE event received type=text dataLength=${data.length}`);
              // Not JSON, treat as plain text
              const textChunk: ResponseChunk = {
                type: "text",
                content: data,
                sessionId,
              };
              promptState.chunks.push(data);
              onChunk?.(textChunk);
              this.responseChunkCallback?.(textChunk);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return promptState.chunks.join("");
  }

  /**
   * Parse SSE event into ResponseChunk
   */
  private parseSSEEvent(event: Record<string, unknown>, sessionId: string): ResponseChunk | null {
    const eventType = event.type as string;

    this.log.debug(`Parsed SSE event type=${eventType}`);

    switch (eventType) {
      case "text":
      case "content":
      case "assistant":
        return {
          type: "text",
          content: (event.content || event.text || event.message) as string,
          sessionId,
        };

      case "tool_use":
      case "tool_start":
        return {
          type: "tool_start",
          toolName: event.name as string,
          toolArgs: event.args as Record<string, unknown>,
          sessionId,
        };

      case "tool_result":
      case "tool_end":
        return {
          type: "tool_end",
          toolName: event.name as string,
          toolResult: event.result as string,
          sessionId,
        };

      case "error":
        return {
          type: "error",
          error: (event.error || event.message) as string,
          sessionId,
        };

      default:
        // Handle unknown event types that contain content
        if (event.content || event.text) {
          return {
            type: "text",
            content: (event.content || event.text) as string,
            sessionId,
          };
        }
        return null;
    }
  }

  // ===========================================================================
  // Session Event Handling
  // ===========================================================================

  /**
   * Emit a session event to registered callback
   */
  private emitSessionEvent(event: SessionEvent): void {
    this.sessionEventCallback?.(event);
  }

  /**
   * Handle session created event from OpenCode
   */
  handleSessionCreated(session: OpenCodeSession): void {
    this.log.info(`Handle session created sessionId=${session.id} directory=${session.directory}`);
    this.sessionRegistry.handleSessionCreated(session);
  }

  /**
   * Handle session deleted event from OpenCode
   */
  handleSessionDeleted(sessionId: string): void {
    this.log.info(`Handle session deleted sessionId=${sessionId}`);
    this.sessionRegistry.handleSessionDeleted(sessionId);
  }

  // ===========================================================================
  // Bi-directional TUI Sync
  // ===========================================================================

  /**
   * Subscribe to TUI events for a session
   * Used for bi-directional sync (TUI messages appearing in Teams)
   *
   * @param sessionId - Session to subscribe to
   * @param onTUIMessage - Callback when a message is entered in the TUI
   */
  subscribeTUIEvents(
    sessionId: string,
    onTUIMessage: (message: string, isUser: boolean) => Promise<void>
  ): () => void {
    // TODO: Implement WebSocket subscription to OpenCode server
    // for real-time TUI event streaming
    // The OpenCode server needs to emit events when:
    // - User types in TUI
    // - Assistant responds
    // For now, return a no-op unsubscribe function
    this.log.debug(`TUI event subscription requested for session ${sessionId}`);

    return () => {
      this.log.debug(`TUI event subscription cancelled for session ${sessionId}`);
    };
  }

  // ===========================================================================
  // Status
  // ===========================================================================

  /**
   * Get current connection state
   */
  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connectionState === "connected";
  }

  /**
   * Get session count
   */
  getSessionCount(): number {
    return this.sessionRegistry.countAvailable();
  }

  /**
   * Get server URL
   */
  getServerUrl(): string {
    return this.config.serverUrl;
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let bridgeInstance: OpenCodeBridge | null = null;

/**
 * Get or create the OpenCode bridge singleton
 */
export function getOpenCodeBridge(options?: OpenCodeBridgeOptions): OpenCodeBridge {
  if (!bridgeInstance && options) {
    bridgeInstance = new OpenCodeBridge(options);
  }
  if (!bridgeInstance) {
    throw new Error("OpenCodeBridge not initialized. Call getOpenCodeBridge with options first.");
  }
  return bridgeInstance;
}

/**
 * Clear the bridge singleton (for testing)
 */
export function clearOpenCodeBridge(): void {
  if (bridgeInstance) {
    bridgeInstance.disconnect();
    bridgeInstance = null;
  }
}
