import WebSocket from "ws";
import { EventEmitter } from "events";
import type { MattermostConfig } from "../config.js";
import type { WebSocketEvent } from "../models/index.js";
import { log as fileLog } from "../logger.js";

export class MattermostWebSocketClient extends EventEmitter {
  private config: MattermostConfig;
  private ws: WebSocket | null = null;
  private connected = false;
  private reconnectAttempts = 0;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private eventBuffer: WebSocketEvent[] = [];
  private maxBufferSize = 1000;
  private channelSubscriptions: Set<string> = new Set();
  private debug: boolean;
  private seq: number = 0;

  constructor(config: MattermostConfig) {
    super();
    this.config = config;
    this.debug = config.debug || false;
    this.log("WebSocket client initialized");
  }

  private log(...args: unknown[]): void {
    if (this.debug) {
      fileLog.debug(`[WebSocket] ${args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ")}`);
    }
  }

  async connect(): Promise<void> {
    if (this.ws) {
      this.log("WebSocket already connected");
      return;
    }

    if (!this.config.token) {
      throw new Error("Cannot connect WebSocket: No authentication token provided");
    }

    return new Promise((resolve, reject) => {
      try {
        this.log(`Connecting to WebSocket at ${this.config.wsUrl}`);

        const connectionTimeout = setTimeout(() => {
          this.log("WebSocket connection timeout");
          if (this.ws) {
            this.ws.terminate();
            this.ws = null;
          }
          this.connected = false;
          reject(new Error("WebSocket connection timeout after 10 seconds"));
        }, 10000);

        this.ws = new WebSocket(this.config.wsUrl);

        this.ws.on("open", () => {
          this.log("WebSocket connection established");
          clearTimeout(connectionTimeout);
          this.reconnectAttempts = 0;

          if (this.ws) {
            try {
              this.seq++;
              const authMessage = {
                seq: this.seq,
                action: "authentication_challenge",
                data: {
                  token: this.config.token,
                },
              };
              this.log("Sending auth:", JSON.stringify(authMessage));
              this.ws.send(JSON.stringify(authMessage));
              this.log("Sent authentication challenge");
              this.connected = true;
              resolve();
            } catch (sendError) {
              this.log("Error sending authentication challenge:", sendError);
              reject(sendError);
            }
          }
        });

        this.ws.on("message", (data: WebSocket.Data) => {
          try {
            const raw = data.toString();
            this.log("Raw message:", raw.substring(0, 200));
            const event = JSON.parse(raw) as WebSocketEvent;
            this.handleEvent(event);
          } catch (error) {
            this.log("Error parsing WebSocket message:", error);
          }
        });

        this.ws.on("close", (code, reason) => {
          clearTimeout(connectionTimeout);
          this.log(`WebSocket connection closed with code ${code}, reason: ${reason?.toString() || 'none'}`);
          this.connected = false;
          this.ws = null;
          if (code !== 1000) {
            this.scheduleReconnect();
          }
        });

        this.ws.on("error", (error) => {
          clearTimeout(connectionTimeout);
          this.log("WebSocket error:", error);
          this.connected = false;
        });
      } catch (error) {
        this.log("Failed to connect to WebSocket:", error);
        this.scheduleReconnect();
        reject(error);
      }
    });
  }

  private handleEvent(event: WebSocketEvent): void {
    this.log(`Received WebSocket event: ${event.event}`);

    this.eventBuffer.push(event);
    if (this.eventBuffer.length > this.maxBufferSize) {
      this.eventBuffer.shift();
    }

    this.emit(event.event, event);
    this.emit("message", event);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    const maxAttempts = this.config.maxReconnectAttempts || 10;
    if (this.reconnectAttempts >= maxAttempts) {
      this.log(`Maximum reconnection attempts (${maxAttempts}) reached`);
      this.emit("reconnect_failed");
      return;
    }

    const baseInterval = this.config.reconnectInterval || 5000;
    const delay = Math.min(baseInterval * Math.pow(1.5, this.reconnectAttempts), 60000);

    this.log(`Scheduling reconnect in ${delay}ms (attempt ${this.reconnectAttempts + 1})`);

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectAttempts++;
      this.connect().catch(() => {});
    }, delay);
  }

  subscribeToChannel(channelId: string): void {
    this.channelSubscriptions.add(channelId);
    this.log(`Subscribed to channel: ${channelId}`);
  }

  unsubscribeFromChannel(channelId: string): void {
    this.channelSubscriptions.delete(channelId);
    this.log(`Unsubscribed from channel: ${channelId}`);
  }

  getChannelEvents(channelId: string, eventType?: string, limit = 50): WebSocketEvent[] {
    return this.eventBuffer
      .filter(
        (event) =>
          event.broadcast?.channel_id === channelId && (!eventType || event.event === eventType)
      )
      .slice(-limit);
  }

  disconnect(): void {
    this.log("Disconnecting WebSocket");

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.connected = false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  getAllEvents(limit = 100): WebSocketEvent[] {
    return this.eventBuffer.slice(-limit);
  }

  clearEventBuffer(): void {
    this.eventBuffer = [];
  }
}
