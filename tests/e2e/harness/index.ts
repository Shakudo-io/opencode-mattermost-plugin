/**
 * E2E Test Harness for OpenCode Mattermost Plugin
 * 
 * Standalone service providing bot command responses without OpenCode.
 * Commands: !help, !sessions, !current, !use, !models, !model
 */

import WebSocket from "ws";

const config = {
  mattermostUrl: process.env.MATTERMOST_URL || "https://mattermost.test3.canopyhub.io/api/v4",
  mattermostToken: process.env.MATTERMOST_TOKEN || "",
  botUserId: process.env.BOT_USER_ID || "",
  debug: process.env.DEBUG === "true",
};

function getWsUrl(httpUrl: string): string {
  const url = new URL(httpUrl);
  const wsProtocol = url.protocol === "https:" ? "wss:" : "ws:";
  return `${wsProtocol}//${url.host}/api/v4/websocket`;
}

const log = {
  info: (...args: unknown[]) => console.log(`[${new Date().toISOString()}] INFO:`, ...args),
  debug: (...args: unknown[]) => config.debug && console.log(`[${new Date().toISOString()}] DEBUG:`, ...args),
  error: (...args: unknown[]) => console.error(`[${new Date().toISOString()}] ERROR:`, ...args),
};

class MattermostHttpClient {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
  }

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
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    return response.json() as Promise<T>;
  }

  async getCurrentUser(): Promise<{ id: string; username: string }> {
    return this.request("/users/me");
  }

  async getChannel(channelId: string): Promise<{ id: string; type: string; name: string }> {
    return this.request(`/channels/${channelId}`);
  }

  async createPost(channelId: string, message: string, rootId?: string): Promise<any> {
    const payload: any = {
      channel_id: channelId,
      message,
    };
    if (rootId) payload.root_id = rootId;

    return this.request("/posts", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }
}

class MattermostWebSocketClient {
  private ws: WebSocket | null = null;
  private url: string;
  private token: string;
  private onMessage: (event: any) => void;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;

  constructor(url: string, token: string, onMessage: (event: any) => void) {
    this.url = url;
    this.token = token;
    this.onMessage = onMessage;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      log.info(`Connecting to WebSocket: ${this.url}`);
      
      this.ws = new WebSocket(this.url);

      const timeout = setTimeout(() => {
        if (this.ws) this.ws.terminate();
        reject(new Error("WebSocket connection timeout"));
      }, 10000);

      this.ws.on("open", () => {
        clearTimeout(timeout);
        log.info("WebSocket connected, sending auth...");
        
        this.ws!.send(JSON.stringify({
          seq: 1,
          action: "authentication_challenge",
          data: { token: this.token },
        }));

        this.reconnectAttempts = 0;
        resolve();
      });

      this.ws.on("message", (data: WebSocket.Data) => {
        try {
          const event = JSON.parse(data.toString());
          log.debug("WS event:", event.event);
          this.onMessage(event);
        } catch (e) {
          log.error("Failed to parse WS message:", e);
        }
      });

      this.ws.on("close", (code, reason) => {
        log.info(`WebSocket closed: ${code} ${reason?.toString()}`);
        this.scheduleReconnect();
      });

      this.ws.on("error", (error) => {
        log.error("WebSocket error:", error);
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      log.error("Max reconnect attempts reached");
      return;
    }

    const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 30000);
    log.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts + 1})`);

    setTimeout(() => {
      this.reconnectAttempts++;
      this.connect().catch(e => log.error("Reconnect failed:", e));
    }, delay);
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

class CommandHandler {
  private httpClient: MattermostHttpClient;
  private botUserId: string;

  constructor(httpClient: MattermostHttpClient, botUserId: string) {
    this.httpClient = httpClient;
    this.botUserId = botUserId;
  }

  async handleCommand(
    command: string,
    args: string[],
    channelId: string,
    rootId?: string
  ): Promise<void> {
    log.info(`Handling command: !${command} ${args.join(" ")}`);

    let response: string;

    switch (command.toLowerCase()) {
      case "help":
        response = this.getHelpMessage();
        break;
      case "sessions":
        response = this.getSessionsMessage();
        break;
      case "current":
        response = this.getCurrentMessage();
        break;
      case "use":
        response = this.getUseMessage(args[0]);
        break;
      case "models":
        response = this.getModelsMessage();
        break;
      case "model":
        response = this.getModelMessage();
        break;
      default:
        response = `Unknown command: \`!${command}\`\n\nType \`!help\` for available commands.`;
    }

    await this.httpClient.createPost(channelId, response, rootId);
  }

  async handlePrompt(
    message: string,
    channelId: string,
    rootId?: string
  ): Promise<void> {
    log.info(`Handling prompt: ${message.substring(0, 50)}...`);

    const response = `**[Test Harness Mode]**\n\nReceived your prompt. In production, this would be processed by OpenCode.\n\n> ${message.substring(0, 100)}${message.length > 100 ? "..." : ""}`;

    await this.httpClient.createPost(channelId, response, rootId);
  }

  private getHelpMessage(): string {
    return `### :robot_face: OpenCode Mattermost Bot

**Available Commands:**

| Command | Description |
|---------|-------------|
| \`!sessions\` | List all active OpenCode sessions |
| \`!use <id>\` | Switch to a specific session |
| \`!current\` | Show currently selected session |
| \`!models\` | List available AI models |
| \`!model\` | Show current model selection |
| \`!help\` | Show this help message |

**Thread Workflow:**
- Each OpenCode session has its own dedicated thread
- Send prompts in the session thread to interact with that session
- Use \`!sessions\` to see available sessions and their threads

**Note:** This is the E2E test harness. In production, prompts are processed by OpenCode.`;
  }

  private getSessionsMessage(): string {
    return `:clipboard: **Sessions in this channel** (2):

**1.** \`ses_test1\` :white_check_mark: [:thread: thread](/_redirect/pl/mock_thread_1)
   Test Session 1 - E2E Testing
   _test-project_ • just now

**2.** \`ses_test2\` [:thread: thread](/_redirect/pl/mock_thread_2)
   Test Session 2 - Integration Tests
   _integration-project_ • 5m ago

:white_check_mark: = current target (\`ses_test1\`)
:thread: = click to open session thread

**Commands:** \`!use <id>\` to switch, \`!current\` for details`;
  }

  private getCurrentMessage(): string {
    return `### :dart: Current Session

**Session ID:** \`ses_test1\`
**Project:** test-project
**Directory:** /home/test/projects/test-project
**Status:** Active
**Model:** claude-sonnet-4-20250514 (Anthropic)

_This is a mock session for E2E testing._`;
  }

  private getUseMessage(sessionId?: string): string {
    if (!sessionId) {
      return `:warning: Please specify a session ID.\n\nUsage: \`!use <session-id>\`\n\nUse \`!sessions\` to see available sessions.`;
    }
    return `:white_check_mark: Switched to session \`${sessionId}\`\n\n_Note: This is the E2E test harness. Session switching is simulated._`;
  }

  private getModelsMessage(): string {
    return `### :robot_face: Available Models

**Anthropic**
  1. claude-sonnet-4-20250514
  2. claude-3-5-haiku-20241022

**OpenAI**
  3. gpt-4o
  4. o3

Reply with a number to select a model.

_Note: This is the E2E test harness. Model selection is simulated._`;
  }

  private getModelMessage(): string {
    return `### :gear: Current Model

**Model:** claude-sonnet-4-20250514
**Provider:** Anthropic

Use \`!models\` to see available models and select a different one.`;
  }
}

class E2ETestHarness {
  private httpClient: MattermostHttpClient;
  private wsClient: MattermostWebSocketClient | null = null;
  private commandHandler: CommandHandler;
  private botUserId: string = "";

  constructor() {
    if (!config.mattermostToken) {
      throw new Error("MATTERMOST_TOKEN environment variable is required");
    }

    this.httpClient = new MattermostHttpClient(config.mattermostUrl, config.mattermostToken);
    this.commandHandler = new CommandHandler(this.httpClient, "");
  }

  async start(): Promise<void> {
    log.info("Starting E2E Test Harness...");
    log.info(`Mattermost URL: ${config.mattermostUrl}`);

    const botUser = await this.httpClient.getCurrentUser();
    this.botUserId = botUser.id;
    log.info(`Bot user: @${botUser.username} (${botUser.id})`);

    this.commandHandler = new CommandHandler(this.httpClient, this.botUserId);

    const wsUrl = getWsUrl(config.mattermostUrl);
    this.wsClient = new MattermostWebSocketClient(
      wsUrl,
      config.mattermostToken,
      this.handleWsEvent.bind(this)
    );

    await this.wsClient.connect();
    log.info("E2E Test Harness is ready and listening for messages!");
  }

  private async handleWsEvent(event: any): Promise<void> {
    if (event.event !== "posted") {
      return;
    }

    try {
      const data = event.data;
      const post = JSON.parse(data.post);

      if (post.user_id === this.botUserId) {
        log.debug("Ignoring own message");
        return;
      }

      const channel = await this.httpClient.getChannel(post.channel_id);
      const isDM = channel.type === "D";
      const isGroupDM = channel.type === "G";
      const isBotMentioned = post.message.includes(`@${this.botUserId}`) || 
                            (data.mentions && data.mentions.includes(this.botUserId));

      if (!isDM && !isGroupDM && !isBotMentioned) {
        log.debug("Ignoring message - not DM and bot not mentioned");
        return;
      }

      log.info(`Processing message in channel ${channel.type}: ${post.message.substring(0, 50)}...`);

      const message = post.message.trim();
      const rootId = post.root_id || post.id;

      if (message.startsWith("!")) {
        const parts = message.slice(1).split(/\s+/);
        const command = parts[0];
        const args = parts.slice(1);
        await this.commandHandler.handleCommand(command, args, post.channel_id, rootId);
      } else {
        await this.commandHandler.handlePrompt(message, post.channel_id, rootId);
      }
    } catch (e) {
      log.error("Error handling posted event:", e);
    }
  }

  stop(): void {
    log.info("Stopping E2E Test Harness...");
    if (this.wsClient) {
      this.wsClient.disconnect();
    }
  }
}

async function main(): Promise<void> {
  const harness = new E2ETestHarness();

  process.on("SIGINT", () => {
    harness.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    harness.stop();
    process.exit(0);
  });

  await harness.start();
}

main().catch((e) => {
  log.error("Fatal error:", e);
  process.exit(1);
});
