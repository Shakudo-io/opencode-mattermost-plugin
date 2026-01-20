# Architectural Decisions

## ADR-001: Thread-per-session architecture (v0.3.0)

**Date:** 2026-01-14

**Context:** Originally plugin required manual `!use` commands to switch sessions. Users found this confusing.

**Decision:** Each OpenCode session automatically gets its own Mattermost thread. Thread-session mappings persist to disk.

**Consequences:**
- Cleaner UX - each conversation is isolated
- Parallel session control via separate threads
- Crash recovery - mappings survive restarts

---

## ADR-002: channelId field for group DM support (v0.3.3)

**Date:** 2026-01-20

**Context:** Need to support group DMs where multiple users can interact with the bot.

**Decision:** Add `channelId` field to ThreadSessionMapping to track where thread actually lives (1:1 DM or group DM). Made optional for backward compatibility with existing mappings.

**Trade-offs:**
- Optional field means some code paths need `mapping.channelId || mapping.dmChannelId` fallback
- Simpler than migrating existing data

**Consequences:**
- `!sessions` now filters by current channel
- Group DMs show only group DM threads
- 1:1 DMs show only 1:1 threads
- TUI-originated sessions still default to 1:1 DM

---

## ADR-003: Modular architecture refactor (v0.3.0)

**Date:** 2026-01-14

**Context:** Original plugin was 1,826 lines in a single file, making it hard to maintain.

**Decision:** Split into modular components:
- `src/clients/` - Mattermost HTTP and WebSocket clients
- `src/persistence/` - Thread mapping store
- `src/models/` - TypeScript types and Zod schemas
- Individual managers for threads, sessions, commands, etc.

**Consequences:**
- Easier to test individual components
- Clearer separation of concerns
- Slightly more complex import graph

---
