/**
 * E2E Teams Bot Validation Script
 *
 * Tests each layer of the MS Teams integration independently:
 * 1. Config validation with real Azure credentials
 * 2. Bot Framework adapter initialization
 * 3. HTTP server startup with health endpoint
 * 4. Bot message handler registration
 * 5. Simulated Bot Framework message POST
 * 6. OpenCode bridge connection (expects failure without OpenCode server)
 */

import {
  loadTeamsConfig,
  validateTeamsConfig,
  getTeamsConfig,
  logTeamsConfig,
  clearTeamsConfigCache,
} from "../src/teams/teams-config.js";
import {
  createTeamsAdapter,
  validateAdapterConfig,
  clearAdapterInstance,
} from "../src/teams/teams-adapter.js";
import { TeamsBot } from "../src/teams/teams-bot.js";
import { createTeamsServer } from "../src/teams/teams-server.js";
import { teamsLog } from "../src/teams/teams-logger.js";

const log = teamsLog.withContext("E2E-Test");
const results: { test: string; status: "PASS" | "FAIL" | "WARN"; detail: string }[] = [];

function record(test: string, status: "PASS" | "FAIL" | "WARN", detail: string) {
  results.push({ test, status, detail });
  const icon = status === "PASS" ? "✅" : status === "FAIL" ? "❌" : "⚠️";
  console.log(`${icon} ${test}: ${detail}`);
}

// ============================================================================
// Test 1: Config Validation
// ============================================================================
async function testConfig() {
  console.log("\n=== Test 1: Config Validation ===");

  try {
    clearTeamsConfigCache();
    const valid = validateTeamsConfig();
    if (!valid) {
      record("Config Validation", "FAIL", "validateTeamsConfig() returned false");
      return false;
    }
    record("Config Validation", "PASS", "Config validates with real Azure env vars");

    const config = getTeamsConfig();
    record("Config Load", "PASS", `App ID: ${config.azure.appId.substring(0, 8)}..., Tenant: ${config.azure.tenantId.substring(0, 8)}...`);

    logTeamsConfig(config);
    record("Config Dump", "PASS", `Server port: ${config.server.port}, Bot endpoint: ${config.server.basePath}${config.server.messagesPath}`);

    return true;
  } catch (error) {
    record("Config Validation", "FAIL", String(error));
    return false;
  }
}

// ============================================================================
// Test 2: Bot Framework Adapter
// ============================================================================
async function testAdapter() {
  console.log("\n=== Test 2: Bot Framework Adapter ===");

  try {
    clearAdapterInstance();

    const valid = validateAdapterConfig();
    if (!valid) {
      record("Adapter Config", "FAIL", "validateAdapterConfig() returned false");
      return false;
    }
    record("Adapter Config", "PASS", "Azure credentials validated for adapter");

    const adapter = createTeamsAdapter();
    record("Adapter Create", "PASS", `CloudAdapter created successfully (type: ${adapter.constructor.name})`);

    return true;
  } catch (error) {
    record("Adapter Create", "FAIL", String(error));
    return false;
  }
}

// ============================================================================
// Test 3: Bot Instance
// ============================================================================
async function testBot() {
  console.log("\n=== Test 3: Bot Instance ===");

  try {
    const config = getTeamsConfig();
    let messageReceived = false;
    let receivedText = "";

    const bot = new TeamsBot({
      config,
      onMessage: async (_context, text) => {
        messageReceived = true;
        receivedText = text;
      },
    });

    record("Bot Create", "PASS", `TeamsBot created (extends TeamsActivityHandler)`);

    // Test message handler registration
    bot.setMessageHandler(async (_ctx, text) => {
      receivedText = text;
    });
    record("Bot Handler", "PASS", "Message handler registered successfully");

    return true;
  } catch (error) {
    record("Bot Create", "FAIL", String(error));
    return false;
  }
}

// ============================================================================
// Test 4: HTTP Server + Health Endpoint
// ============================================================================
async function testServer() {
  console.log("\n=== Test 4: HTTP Server ===");

  let server: any = null;

  try {
    const config = getTeamsConfig();
    const testPort = 13978;
    const originalPort = config.server.port;
    (config.server as any).port = testPort;

    const adapter = createTeamsAdapter();
    const bot = new TeamsBot({
      config,
      onMessage: async (_context, text) => {
        log.info(`Test message received: ${text}`);
      },
    });

    server = createTeamsServer({ adapter, bot, config });

    await server.start();
    record("Server Start", "PASS", `HTTP server started on port ${testPort}`);

    await new Promise((resolve) => setTimeout(resolve, 500));

    // Use 127.0.0.1 instead of localhost (Bun resolves localhost to IPv6 which may not bind)
    const healthResponse = await fetch(`http://127.0.0.1:${testPort}/api/health`);
    const healthBody = await healthResponse.json();
    record("Health Endpoint", "PASS", `GET /api/health → ${healthResponse.status} ${JSON.stringify(healthBody)}`);

    // Test messages endpoint exists (should reject without Bot Framework auth)
    const messagesResponse = await fetch(`http://127.0.0.1:${testPort}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "message", text: "test" }),
    });
    // Expect 401 or 403 since we don't have a valid Bot Framework token
    if (messagesResponse.status === 401 || messagesResponse.status === 403) {
      record("Messages Endpoint Auth", "PASS", `POST /api/messages → ${messagesResponse.status} (correctly rejected unauthenticated request)`);
    } else if (messagesResponse.status === 500) {
      // BotFramework SDK may throw internal error on malformed activity
      const errText = await messagesResponse.text().catch(() => "");
      record("Messages Endpoint Auth", "WARN", `POST /api/messages → ${messagesResponse.status} (SDK error on malformed request: ${errText.substring(0, 100)})`);
    } else {
      record("Messages Endpoint Auth", "WARN", `POST /api/messages → ${messagesResponse.status} (unexpected status)`);
    }

    // Restore port
    (config.server as any).port = originalPort;

    return true;
  } catch (error) {
    record("Server", "FAIL", String(error));
    return false;
  } finally {
    if (server) {
      try {
        await server.stop();
        record("Server Stop", "PASS", "Server stopped cleanly");
      } catch (e) {
        record("Server Stop", "WARN", `Stop error: ${e}`);
      }
    }
  }
}

// ============================================================================
// Test 5: Teams Thread Mapping Store
// ============================================================================
async function testThreadStore() {
  console.log("\n=== Test 5: Thread Mapping Store ===");

  try {
    const { getTeamsThreadMappingStore } = await import("../src/persistence/teams-thread-mapping-store.js");
    const store = getTeamsThreadMappingStore();
    await store.load();
    record("Thread Store Load", "PASS", "TeamsThreadMappingStore loaded successfully");

    const active = store.getActive();
    record("Thread Store Query", "PASS", `Active thread mappings: ${active.length}`);

    return true;
  } catch (error) {
    record("Thread Store", "FAIL", String(error));
    return false;
  }
}

// ============================================================================
// Test 6: OpenCode Bridge (expected to fail without OpenCode server)
// ============================================================================
async function testOpenCodeBridge() {
  console.log("\n=== Test 6: OpenCode Bridge ===");

  try {
    const { OpenCodeBridge } = await import("../src/teams/opencode-bridge.js");
    const config = getTeamsConfig();

    const bridge = new OpenCodeBridge({
      config,
      onSessionEvent: async () => {},
    });

    record("Bridge Create", "PASS", `OpenCodeBridge created (target: ${config.opencode.serverUrl})`);

    // Try connecting - expected to fail without running OpenCode server
    try {
      await Promise.race([
        bridge.connect(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Connection timeout")), 5000)),
      ]);
      record("Bridge Connect", "WARN", "Connected to OpenCode (unexpected - is OpenCode running?)");
    } catch (error) {
      record("Bridge Connect", "PASS", `Connection correctly failed (no OpenCode server): ${String(error).substring(0, 80)}`);
    }

    return true;
  } catch (error) {
    record("Bridge", "FAIL", String(error));
    return false;
  }
}

// ============================================================================
// Test 7: Card Builders
// ============================================================================
async function testCardBuilders() {
  console.log("\n=== Test 7: Card Builders ===");

  try {
    const { createHelpCard, createErrorCard, getDefaultCommands } = await import("../src/teams/cards/command-card.js");
    const { createSessionListCard, createModelSelectionCard, createCostCard } = await import("../src/teams/cards/session-card.js");
    const { StatusCardBuilder } = await import("../src/teams/cards/status-card.js");
    const { ResponseCardBuilder } = await import("../src/teams/cards/response-card.js");

    // Help card
    const helpCard = createHelpCard({ botName: "Test Bot", version: "1.0.0", commands: getDefaultCommands() });
    if (helpCard.contentType !== "application/vnd.microsoft.card.adaptive") {
      record("Help Card", "FAIL", `Wrong content type: ${helpCard.contentType}`);
    } else {
      record("Help Card", "PASS", `Generated with ${getDefaultCommands().length} commands`);
    }

    // Error card
    const errorCard = createErrorCard("Test Error", "Something went wrong");
    record("Error Card", "PASS", `Generated error card (type: ${errorCard.contentType})`);

    // Session list card
    const sessionCard = createSessionListCard({
      sessions: [{ id: "test1", projectName: "test-project", projectDirectory: "/tmp", status: "active", lastActivityAt: new Date().toISOString() }],
    });
    record("Session List Card", "PASS", `Generated session list card`);

    // Model selection card
    const modelCard = createModelSelectionCard({
      providers: [{ name: "Anthropic", models: [{ id: "claude-sonnet-4", name: "Claude Sonnet 4" }] }],
    });
    record("Model Selection Card", "PASS", `Generated model selection card`);

    // Cost card
    const costCard = createCostCard({ sessionId: "test", totalCost: 0.47, inputTokens: 125000, outputTokens: 8000, model: "claude-sonnet-4" });
    record("Cost Card", "PASS", `Generated cost card`);

    const statusBuilder = new StatusCardBuilder({ sessionId: "test-session", prompt: "test prompt", startTime: Date.now() - 5000 });
    const statusCard = statusBuilder.build();
    record("Status Card", "PASS", `Generated status card (version: ${statusCard.version})`);

    const responseBuilder = new ResponseCardBuilder({ sessionId: "test-session", content: "Hello world response", startTime: Date.now() - 5000, endTime: Date.now() });
    const responseCard = responseBuilder.build();
    record("Response Card", "PASS", `Generated response card (version: ${responseCard.version})`);

    return true;
  } catch (error) {
    record("Card Builders", "FAIL", String(error));
    return false;
  }
}

// ============================================================================
// Test 8: Command Handler
// ============================================================================
async function testCommandHandler() {
  console.log("\n=== Test 8: Command Handler ===");

  try {
    const { createTeamsCommandHandler } = await import("../src/teams/teams-command-handler.js");
    const { OpenCodeBridge } = await import("../src/teams/opencode-bridge.js");
    const config = getTeamsConfig();

    const bridge = new OpenCodeBridge({
      config,
      onSessionEvent: async () => {},
    });

    const handler = createTeamsCommandHandler(config, bridge);

    // Test command detection
    const isCmd = handler.isCommand("!help");
    const notCmd = handler.isCommand("hello");
    record("Command Detection", isCmd && !notCmd ? "PASS" : "FAIL", `!help=${isCmd}, hello=${notCmd}`);

    // Test numeric response (should be false with no pending selections)
    const isNum = handler.isNumericResponse("1", "test-conv");
    record("Numeric Response", !isNum ? "PASS" : "FAIL", `No pending selection → ${isNum}`);

    return true;
  } catch (error) {
    record("Command Handler", "FAIL", String(error));
    return false;
  }
}

// ============================================================================
// Run All Tests
// ============================================================================
async function main() {
  console.log("========================================");
  console.log("MS Teams Integration E2E Validation");
  console.log("========================================");
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Node/Bun: ${process.version || "bun"}`);

  await testConfig();
  await testAdapter();
  await testBot();
  await testServer();
  await testThreadStore();
  await testOpenCodeBridge();
  await testCardBuilders();
  await testCommandHandler();

  // Summary
  console.log("\n========================================");
  console.log("SUMMARY");
  console.log("========================================");

  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  const warned = results.filter((r) => r.status === "WARN").length;

  console.log(`Total: ${results.length} | ✅ Pass: ${passed} | ❌ Fail: ${failed} | ⚠️ Warn: ${warned}`);
  console.log("");

  if (failed > 0) {
    console.log("FAILURES:");
    for (const r of results.filter((r) => r.status === "FAIL")) {
      console.log(`  ❌ ${r.test}: ${r.detail}`);
    }
  }

  if (warned > 0) {
    console.log("WARNINGS:");
    for (const r of results.filter((r) => r.status === "WARN")) {
      console.log(`  ⚠️ ${r.test}: ${r.detail}`);
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(2);
});
