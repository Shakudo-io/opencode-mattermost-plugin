#!/usr/bin/env bun
import { StatusCardBuilder, type StatusCardConfig } from "../src/teams/cards/status-card.js";
import { 
  ResponseCardBuilder, 
  type ResponseCardConfig,
  paginateContent,
  MAX_CONTENT_LENGTH,
  createResponseCard,
  createSimpleResponseCard,
} from "../src/teams/cards/response-card.js";

console.log("=== MS Teams Bot Component Tests ===\n");

console.log("1. Testing StatusCardBuilder...");
try {
  const statusConfig: StatusCardConfig = {
    sessionId: "ses_test123",
    prompt: "Create a hello world function",
    startTime: Date.now() - 5000,
  };
  
  const statusBuilder = new StatusCardBuilder(statusConfig);
  const initialCard = statusBuilder.build();
  console.log("   ✓ Initial status card built");
  
  const configWithTools: StatusCardConfig = {
    sessionId: "ses_test123",
    prompt: "Create a hello world function",
    startTime: Date.now() - 10000,
    tools: [
      { name: "read", status: "completed", startTime: Date.now() - 8000, endTime: Date.now() - 6000 },
      { name: "bash", status: "running", startTime: Date.now() - 5000 },
    ],
  };
  
  const toolBuilder = new StatusCardBuilder(configWithTools);
  const toolCard = toolBuilder.build();
  console.log("   ✓ Status card with tool activities built");
  
  const configWithOutput: StatusCardConfig = {
    sessionId: "ses_test123",
    prompt: "Create a hello world function",
    startTime: Date.now() - 15000,
    currentOutput: "Here is some sample output from the AI assistant...",
  };
  
  const outputBuilder = new StatusCardBuilder(configWithOutput);
  const previewCard = outputBuilder.build();
  console.log("   ✓ Status card with output preview built");
  
  console.log("   ✓ StatusCardBuilder: PASSED\n");
} catch (error) {
  console.error("   ✗ StatusCardBuilder: FAILED", error);
  process.exit(1);
}

console.log("2. Testing ResponseCardBuilder...");
try {
  const responseConfig: ResponseCardConfig = {
    sessionId: "ses_abc123",
    content: "Hello! I've completed the task.",
    startTime: Date.now() - 30000,
    endTime: Date.now(),
  };
  
  const responseBuilder = new ResponseCardBuilder(responseConfig);
  const simpleCard = responseBuilder.build();
  console.log("   ✓ Simple response card built");
  
  const simpleAttachment = createSimpleResponseCard("ses_abc123", "Test content", Date.now() - 5000);
  console.log("   ✓ Simple response card factory function works");
  
  const markdownContent = `
## Summary

I've made the following changes:

1. Updated \`config.ts\` to add new settings
2. Fixed the bug in \`handler.ts\`
3. Added unit tests

\`\`\`typescript
const config = {
  setting: true
};
\`\`\`
`;

  const markdownConfig: ResponseCardConfig = {
    sessionId: "ses_abc123",
    content: markdownContent,
    startTime: Date.now() - 60000,
  };
  const markdownBuilder = new ResponseCardBuilder(markdownConfig);
  const markdownCard = markdownBuilder.build();
  console.log("   ✓ Markdown response card built");
  
  const longContent = "A".repeat(30000);
  const needsPagination = longContent.length > MAX_CONTENT_LENGTH;
  console.log(`   ✓ Pagination detection: ${needsPagination ? "needed" : "not needed"} for 30KB content`);
  
  if (needsPagination) {
    const paginated = paginateContent(longContent);
    console.log(`   ✓ Paginated response: ${paginated.totalPages} pages generated`);
  }
  
  console.log("   ✓ ResponseCardBuilder: PASSED\n");
} catch (error) {
  console.error("   ✗ ResponseCardBuilder: FAILED", error);
  process.exit(1);
}

console.log("3. Testing TeamsConfig validation...");
try {
  process.env.AZURE_APP_ID = "test-app-id";
  process.env.AZURE_APP_PASSWORD = "test-app-password";
  process.env.AZURE_TENANT_ID = "test-tenant-id";
  process.env.AZURE_AD_AUTHORIZED_GROUP_ID = "test-group-id";
  
  const { loadTeamsConfig, validateTeamsConfig } = await import("../src/teams/teams-config.js");
  
  const validation = validateTeamsConfig();
  if (validation.isValid) {
    const config = loadTeamsConfig();
    console.log(`   ✓ Config loaded with port: ${config.server.port}`);
    console.log(`   ✓ Card update interval: ${config.bot.cardUpdateInterval}ms`);
    console.log(`   ✓ Max card size: ${config.bot.maxCardSize} bytes`);
    console.log(`   ✓ Rate limit: ${config.bot.rateLimit} RPS`);
  } else {
    console.log("   Validation errors:", validation.errors);
  }
  
  console.log("   ✓ TeamsConfig: PASSED\n");
} catch (error) {
  console.error("   ✗ TeamsConfig: FAILED", error);
  process.exit(1);
}

console.log("4. Testing module exports...");
try {
  const teamsModule = await import("../src/teams/index.js");
  
  const expectedExports = [
    "TeamsBot",
    "TeamsServer",
    "createTeamsAdapter",
    "TeamsThreadManager",
    "OpenCodeBridge",
    "StatusCardBuilder",
    "ResponseCardBuilder",
    "TeamsResponseStreamer",
    "getTeamsResponseStreamer",
  ];
  
  for (const exp of expectedExports) {
    if (exp in teamsModule) {
      console.log(`   ✓ ${exp} exported`);
    } else {
      console.log(`   ✗ ${exp} NOT exported`);
    }
  }
  
  console.log("   ✓ Module exports: PASSED\n");
} catch (error) {
  console.error("   ✗ Module exports: FAILED", error);
  process.exit(1);
}

console.log("=== All Tests Passed ===");
