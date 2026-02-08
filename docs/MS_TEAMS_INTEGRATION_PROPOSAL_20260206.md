# MS Teams OpenCode Integration Proposal

**Date:** 2026-02-06  
**Status:** Research Complete - Architecture Proposal  
**Author:** AI Agent (Sisyphus)

---

## Executive Summary

This document proposes replicating the `opencode-mattermost-plugin` functionality as an MS Teams bot. The analysis covers:
1. Current Mattermost plugin architecture
2. MS Teams bot capabilities and limitations
3. Component-by-component mapping
4. Recommended technology stack
5. Implementation approach

**Verdict:** Full feature parity is achievable with some architectural adaptations for Teams' different event model.

---

## 1. Mattermost Plugin Architecture Summary

### Core Components

| Component | Purpose | Key File |
|-----------|---------|----------|
| **MattermostClient** | HTTP REST API for posts, channels, files, reactions | `src/clients/mattermost-client.ts` |
| **WebSocketClient** | Real-time event streaming (instant message detection) | `src/clients/websocket-client.ts` |
| **SessionManager** | Per-user session tracking with timeout | `src/session-manager.ts` |
| **ThreadManager** | Thread lifecycle (create, end, reconnect) | `src/thread-manager.ts` |
| **MessageRouter** | Routes messages to correct sessions by thread | `src/message-router.ts` |
| **ResponseStreamer** | Chunked message delivery with buffering | `src/response-streamer.ts` |
| **CommandHandler** | `!command` processing (13 commands) | `src/command-handler.ts` |
| **QuestionHandler** | AI question tool responses | `src/question-handler.ts` |
| **ReactionHandler** | Emoji commands (✅/❌/🛑/🔁/🗑️) | `src/reaction-handler.ts` |
| **FileHandler** | Attachment uploads/downloads | `src/file-handler.ts` |
| **SchedulerService** | Cron-based scheduled tasks | `src/scheduler/scheduler-service.ts` |
| **OpenCodeSessionRegistry** | Discovers active OpenCode sessions | `src/opencode-session-registry.ts` |

### Connection Model

```
┌─────────────────┐     WebSocket      ┌─────────────────┐
│   Mattermost    │◄──────────────────►│  Plugin Server  │
│    Server       │                    │                 │
│                 │◄──────────────────►│                 │
└─────────────────┘    HTTP REST API   └─────────────────┘
                                              │
                                              ▼
                                       ┌─────────────────┐
                                       │  OpenCode SDK   │
                                       │  (local server) │
                                       └─────────────────┘
```

**Key Characteristics:**
- **WebSocket**: Bidirectional, real-time - receives `posted`, `post_edited`, `reaction_added` events
- **HTTP API**: Creates/updates posts, uploads files, adds reactions
- **Thread-per-Session**: Each OpenCode session gets a dedicated MM thread
- **Streaming**: Intelligent buffering (50 chars OR 500ms) before flushing to MM

### Commands Supported

| Command | Description |
|---------|-------------|
| `!sessions` | List all available OpenCode sessions |
| `!use <id>` | Switch to a specific session |
| `!current` | Show currently targeted session |
| `!models` | List available AI models |
| `!model` | Show current model for session |
| `!costs` | Show LLM token usage and costs |
| `!stop` | Cancel current operation |
| `!merge <url>` | Merge another thread's conversation |
| `!reject` / `!cancel` | Skip pending AI question |
| `!team` | Manage team members (owner only) |
| `!migrate` | Migrate data to PostgreSQL |
| `!export` | Export data to JSON backup |
| `!help` | Show available commands |

### Emoji Commands

| Emoji | Action |
|-------|--------|
| ✅ | Approve pending permission |
| ❌ | Deny pending permission |
| 🛑 | Cancel current operation |
| 🔁 | Retry last prompt |
| 🗑️ | Clear session files |

---

## 2. MS Teams Bot Capabilities

### Teams Bot Framework Overview

**SDK:** `botbuilder` (Bot Framework SDK v4)  
**Handler:** `TeamsActivityHandler` (extends base handler for Teams-specific events)

### Event Reception Model

**Critical Difference:** Teams uses **webhooks** instead of WebSocket.

```
┌─────────────────┐     HTTPS POST     ┌─────────────────┐
│   MS Teams      │───────────────────►│   Bot Server    │
│   Service       │                    │   /api/messages │
│                 │◄───────────────────│                 │
└─────────────────┘     JSON Response  └─────────────────┘
```

**Events Received:**
- `message` - User sends a message
- `messageReaction` - User adds/removes reaction
- `conversationUpdate` - Members added/removed
- `invoke` - Card action submissions, task module requests

### Proactive Messaging

To send messages without user trigger (e.g., streaming responses):

```typescript
await adapter.continueConversation(
    conversationReference,
    async (context) => {
        await context.sendActivity('Proactive message');
    }
);
```

**Requirement:** Must store `ConversationReference` from initial interaction.

### Conversation Threading

Teams supports threading via `replyToId`:

```typescript
const reply = MessageFactory.text('Threaded reply');
reply.replyToId = parentMessageId;
await context.sendActivity(reply);
```

### Rate Limits

| Operation | Limit |
|-----------|-------|
| Messages per conversation | 7/sec, 60/30sec, 1800/hour |
| Create conversation | 7/sec |
| Global per tenant | 50 RPS |
| Message size | 28 KB (text/card) |
| Attachment | 20 MB |

### Adaptive Cards vs Markdown

| Feature | Mattermost | Teams |
|---------|------------|-------|
| Markdown | Full support | Limited (basic formatting) |
| Tables | Supported | **Not in messages** (use Adaptive Cards) |
| Rich UI | Limited | **Adaptive Cards** (recommended) |
| Interactive buttons | Reactions | **Card Actions** |

---

## 3. Component Mapping: Mattermost → Teams

### Connection Layer

| Mattermost Component | Teams Equivalent | Notes |
|---------------------|------------------|-------|
| `WebSocketClient` | `TeamsActivityHandler` webhooks | Teams pushes events via HTTP POST |
| `MattermostClient` | Bot Framework `TurnContext` | Send messages, reactions via context |
| Token auth (`Bearer`) | `ConfigurationBotFrameworkAuthentication` | Azure AD app registration |
| Auto-reconnect logic | Not needed | Webhook = stateless |

### Message Handling

| Mattermost | Teams | Adaptation |
|------------|-------|------------|
| `posted` event | `onMessage` handler | Direct mapping |
| `reaction_added` event | `onReactionsAdded` handler | Direct mapping |
| `post_edited` event | No equivalent | Must use card updates |
| Thread via `root_id` | Thread via `replyToId` | Direct mapping |
| Edit post (`updatePost`) | Update card (`updateActivity`) | Works for cards, not text |

### Response Streaming

**Challenge:** Teams doesn't support real-time message editing like Mattermost.

**Solution Options:**

1. **Single-Shot Response** (Simplest)
   - Wait for OpenCode to complete
   - Send full response once
   - Pro: Simple; Con: No streaming feel

2. **Progress Card Updates** (Recommended)
   - Send Adaptive Card with status indicator
   - Update card periodically with `updateActivity`
   - Show final response when complete
   
   ```typescript
   // Initial card
   const card = createStatusCard('Processing...', 0);
   const response = await context.sendActivity({ attachments: [card] });
   
   // Update card
   const updatedCard = createStatusCard('Processing...', 50);
   await context.updateActivity({
       id: response.id,
       attachments: [updatedCard]
   });
   ```

3. **Multiple Sequential Messages** (Alternative)
   - Send chunks as separate messages
   - Pro: Real-time feel; Con: Spammy, can't edit

**Recommendation:** Use **Progress Card Updates** for status, then replace with final response card.

### Command Handling

| Mattermost | Teams | Notes |
|------------|-------|-------|
| `!command` prefix | Same or card actions | Can use same prefix |
| Model selection (numbers) | Adaptive Card dropdown | Better UX with cards |
| `!help` text table | Adaptive Card with buttons | Better UX |

### Reaction Handling

| Mattermost | Teams | Adaptation |
|------------|-------|------------|
| React with emoji | React with emoji | Same concept |
| Custom emojis | Standard emoji set | Limited to Teams emoji |
| React triggers action | `onReactionsAdded` | Direct mapping |

**Teams reaction limitation:** Limited to standard emoji set (👍, ❤️, 😂, 😮, 😢, 😡).

**Workaround:** Use Adaptive Card buttons instead:
```json
{
  "type": "Action.Submit",
  "title": "✅ Approve",
  "data": { "action": "approve" }
}
```

### State Persistence

| Mattermost | Teams | Notes |
|------------|-------|-------|
| `ThreadMappingStore` (JSON/Postgres) | Same pattern | Store `ConversationReference` |
| `ScheduleStore` | Same pattern | Portable |
| `TeamStore` | Same pattern | Portable |

**Key Difference:** Must store `ConversationReference` objects for proactive messaging:

```typescript
const reference = TurnContext.getConversationReference(context.activity);
await store.save(sessionId, reference);
```

---

## 4. Recommended Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      MS Teams Service                        │
└─────────────────────────────┬───────────────────────────────┘
                              │ HTTPS POST
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    OpenCode Teams Bot                        │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                 Express.js Server                     │   │
│  │  POST /api/messages                                   │   │
│  └───────────────────────────┬─────────────────────────┘   │
│                              │                               │
│  ┌───────────────────────────▼─────────────────────────┐   │
│  │              TeamsActivityHandler                     │   │
│  │  - onMessage()                                        │   │
│  │  - onReactionsAdded()                                │   │
│  │  - onConversationUpdate()                            │   │
│  └───────────────────────────┬─────────────────────────┘   │
│                              │                               │
│  ┌───────────────────────────▼─────────────────────────┐   │
│  │              Message Router                           │   │
│  │  - Route by conversation thread                       │   │
│  │  - Detect commands vs prompts                        │   │
│  └───────────────────────────┬─────────────────────────┘   │
│                              │                               │
│  ┌───────────┬───────────────┼───────────────┬──────────┐   │
│  │           │               │               │          │   │
│  ▼           ▼               ▼               ▼          ▼   │
│ Command   Question      Response       Session     Card     │
│ Handler   Handler       Streamer       Manager    Builder   │
│                              │                               │
│  ┌───────────────────────────▼─────────────────────────┐   │
│  │           OpenCode Session Registry                   │   │
│  └───────────────────────────┬─────────────────────────┘   │
└──────────────────────────────┼──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                    OpenCode Local Server                     │
│                    (localhost:4096)                          │
└─────────────────────────────────────────────────────────────┘
```

### Technology Stack

| Layer | Technology |
|-------|------------|
| **Runtime** | Node.js 20+ / Bun |
| **Framework** | Express.js + Bot Framework SDK |
| **SDK** | `botbuilder` ^4.22.0 |
| **Cards** | Adaptive Cards 1.5 |
| **State** | Same stores (JSON/Postgres) |
| **Validation** | Zod (same as current) |
| **Logging** | Same logger |

### Key Dependencies

```json
{
  "dependencies": {
    "botbuilder": "^4.22.0",
    "@microsoft/adaptivecards": "^3.0.0",
    "express": "^4.18.0",
    "zod": "^3.22.0"
  }
}
```

---

## 5. Implementation Phases

### Phase 1: Core Bot Setup (Week 1)

**Goal:** Basic Teams bot that can receive and respond to messages.

**Tasks:**
- [ ] Azure AD app registration
- [ ] Express server with `/api/messages` endpoint
- [ ] `TeamsActivityHandler` with `onMessage`
- [ ] Basic configuration (env vars, Zod validation)
- [ ] Local development with ngrok

**Deliverable:** Bot responds to direct messages.

### Phase 2: Thread & Session Management (Week 2)

**Goal:** Thread-per-session model working.

**Tasks:**
- [ ] Port `ThreadMappingStore` (works as-is)
- [ ] Port `SessionManager` (works as-is)
- [ ] Adapt `ThreadManager` for Teams threading
- [ ] Port `OpenCodeSessionRegistry` (works as-is)
- [ ] Store `ConversationReference` for proactive messaging

**Deliverable:** Each OpenCode session gets a Teams thread.

### Phase 3: Response Streaming (Week 2-3)

**Goal:** Real-time response updates using Adaptive Cards.

**Tasks:**
- [ ] Create `AdaptiveCardBuilder` for status/response cards
- [ ] Port `ResponseStreamer` with card updates
- [ ] Implement progress indicator card
- [ ] Handle long responses (card pagination)

**Deliverable:** Responses stream via card updates.

### Phase 4: Commands & Interactions (Week 3)

**Goal:** Full command support.

**Tasks:**
- [ ] Port `CommandHandler` (mostly works)
- [ ] Convert `!models` to Adaptive Card dropdown
- [ ] Port `QuestionHandler` with card-based questions
- [ ] Implement card action handlers for button clicks

**Deliverable:** All 13 commands working.

### Phase 5: Reactions & Permissions (Week 4)

**Goal:** Permission handling via reactions or card buttons.

**Tasks:**
- [ ] Implement `onReactionsAdded` handler
- [ ] Fall back to card buttons for complex actions
- [ ] Port permission approval flow
- [ ] Port `GuestApprovalHandler`

**Deliverable:** Permission requests work via reactions/cards.

### Phase 6: Advanced Features (Week 4-5)

**Goal:** Full feature parity.

**Tasks:**
- [ ] Port `SchedulerService`
- [ ] Port `MergeHandler`
- [ ] Port `FileHandler` (Teams file uploads)
- [ ] Port `MonitorService`
- [ ] Multi-user support (owner filtering)

**Deliverable:** Feature parity with Mattermost plugin.

### Phase 7: Testing & Documentation (Week 5-6)

**Goal:** Production-ready release.

**Tasks:**
- [ ] Unit tests for all components
- [ ] Integration tests with Teams
- [ ] App manifest finalization
- [ ] Documentation (README, setup guide)
- [ ] Teams app package for deployment

---

## 6. Feature Parity Matrix

| Feature | Mattermost | Teams | Notes |
|---------|:----------:|:-----:|-------|
| Real-time message streaming | ✅ | ⚠️ | Card updates, not text edits |
| Thread-per-session | ✅ | ✅ | Direct mapping |
| Commands (`!help`, etc.) | ✅ | ✅ | Same pattern |
| Model selection | ✅ | ✅ | Use Adaptive Card dropdown |
| Cost tracking | ✅ | ✅ | Display in cards |
| AI questions | ✅ | ✅ | Card-based UI |
| Permission approval | ✅ | ⚠️ | Limited reactions, use card buttons |
| File attachments | ✅ | ✅ | Teams file API |
| Scheduled tasks | ✅ | ✅ | Portable |
| Thread merging | ✅ | ✅ | Portable |
| Multi-user/team | ✅ | ✅ | Portable |
| Bi-directional TUI sync | ✅ | ✅ | Via proactive messaging |
| Guest approval | ✅ | ✅ | Card-based |
| Emoji commands | ✅ | ⚠️ | Limited emoji set |

**Legend:** ✅ Full support | ⚠️ Partial/adapted | ❌ Not supported

---

## 7. Deployment Options

### Option A: Self-Hosted (Recommended)

**Requirements:**
- Public HTTPS endpoint (reverse proxy with SSL)
- Azure AD app registration (free)
- No Azure Bot Service needed

**Architecture:**
```
Internet → nginx/Caddy (SSL) → Node.js Bot → OpenCode
```

**Pros:**
- Full control
- No Azure Bot Service costs
- Same infrastructure as current setup

### Option B: Azure Bot Service

**Requirements:**
- Azure subscription
- Azure Bot resource
- Azure App Service or Functions

**Pros:**
- Managed scaling
- Built-in monitoring
- Microsoft support

**Cons:**
- Azure dependency
- Additional cost
- More complex deployment

### Option C: Hybrid

Use Azure AD app registration (required) but self-host the bot:
- Register app in Azure AD
- Deploy bot to Kubernetes/Docker
- Point Teams to your endpoint

---

## 8. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| No real-time text editing | Medium | Use Adaptive Card updates |
| Limited emoji reactions | Low | Use card buttons as fallback |
| Rate limits (50 RPS) | Medium | Implement retry with backoff |
| Card size limit (28 KB) | Low | Pagination for long responses |
| Teams webhook latency | Low | Acceptable for most use cases |

---

## 9. Estimated Effort

| Phase | Effort | Dependencies |
|-------|--------|--------------|
| Phase 1: Core Setup | 3-4 days | Azure AD registration |
| Phase 2: Thread/Session | 3-4 days | Phase 1 |
| Phase 3: Streaming | 4-5 days | Phase 2 |
| Phase 4: Commands | 3-4 days | Phase 3 |
| Phase 5: Reactions | 2-3 days | Phase 4 |
| Phase 6: Advanced | 4-5 days | Phase 5 |
| Phase 7: Testing/Docs | 3-4 days | Phase 6 |

**Total:** ~4-6 weeks for full feature parity

---

## 10. Next Steps

1. **Approve proposal** - Review and get stakeholder sign-off
2. **Azure AD setup** - Create app registration
3. **Local development** - Set up dev environment with ngrok
4. **Scaffold project** - Create TypeScript project with Bot Framework
5. **Begin Phase 1** - Implement core bot

---

## Appendix A: Key Files to Port

These files can be largely reused with minimal changes:

| File | Changes Needed |
|------|----------------|
| `src/config.ts` | Add Teams-specific config |
| `src/session-manager.ts` | None (portable) |
| `src/opencode-session-registry.ts` | None (portable) |
| `src/command-handler.ts` | Adapt response formatting |
| `src/question-handler.ts` | Use Adaptive Cards |
| `src/thread-manager.ts` | Adapt for Teams threading |
| `src/response-streamer.ts` | Major rewrite for card updates |
| `src/message-router.ts` | Adapt for Teams activity types |
| `src/persistence/*` | None (portable) |
| `src/scheduler/*` | None (portable) |
| `src/models/*` | None (portable) |

## Appendix B: Sample Adaptive Cards

### Status Card

```json
{
  "type": "AdaptiveCard",
  "version": "1.5",
  "body": [
    {
      "type": "TextBlock",
      "text": "Processing...",
      "size": "medium",
      "weight": "bolder"
    },
    {
      "type": "TextBlock",
      "text": "Executing bash command...",
      "isSubtle": true
    },
    {
      "type": "ProgressBar",
      "value": 45
    },
    {
      "type": "TextBlock",
      "text": "Elapsed: 12s | Cost: $0.03",
      "isSubtle": true,
      "size": "small"
    }
  ]
}
```

### Question Card

```json
{
  "type": "AdaptiveCard",
  "version": "1.5",
  "body": [
    {
      "type": "TextBlock",
      "text": "Which language would you like to use?",
      "size": "medium",
      "weight": "bolder"
    },
    {
      "type": "Input.ChoiceSet",
      "id": "selection",
      "style": "expanded",
      "choices": [
        { "title": "TypeScript - Modern JavaScript with types", "value": "typescript" },
        { "title": "Python - Great for data science", "value": "python" }
      ]
    },
    {
      "type": "Input.Text",
      "id": "customAnswer",
      "placeholder": "Or type your own answer..."
    }
  ],
  "actions": [
    {
      "type": "Action.Submit",
      "title": "Submit",
      "data": { "action": "answerQuestion" }
    },
    {
      "type": "Action.Submit",
      "title": "Skip",
      "data": { "action": "skipQuestion" }
    }
  ]
}
```

### Permission Request Card

```json
{
  "type": "AdaptiveCard",
  "version": "1.5",
  "body": [
    {
      "type": "TextBlock",
      "text": "Permission Request",
      "size": "large",
      "weight": "bolder",
      "color": "warning"
    },
    {
      "type": "TextBlock",
      "text": "The AI wants to execute: rm -rf node_modules",
      "wrap": true
    }
  ],
  "actions": [
    {
      "type": "Action.Submit",
      "title": "✅ Approve",
      "style": "positive",
      "data": { "action": "approve", "permissionId": "perm_123" }
    },
    {
      "type": "Action.Submit",
      "title": "❌ Deny",
      "style": "destructive",
      "data": { "action": "deny", "permissionId": "perm_123" }
    }
  ]
}
```

---

**Document Version:** 1.0  
**Last Updated:** 2026-02-06
