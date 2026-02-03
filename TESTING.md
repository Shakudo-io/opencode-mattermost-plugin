# Testing Guide

This document describes the testing setup for the OpenCode Mattermost plugin.

## Quick Start

```bash
# Run all tests
bun test

# Run unit tests only
bun test:unit

# Run integration tests only
bun test:integration

# Watch mode
bun test:watch
```

## Test Structure

```
tests/
├── unit/                           # Unit tests (mocked dependencies)
│   ├── thread-mapping-store.test.ts    # JSON persistence layer
│   ├── thread-mapping-pg.test.ts       # PostgreSQL persistence layer
│   ├── message-router.test.ts          # Message routing logic
│   └── command-handler.test.ts         # Command parsing and execution
│
└── integration/                    # Integration tests (real Supabase)
    └── supabase-store.integration.test.ts  # PostgreSQL store with real DB
```

## Unit Tests

Unit tests use mocked dependencies and run entirely in-memory. They test:

- **Thread mapping store (JSON)**: CRUD operations, file persistence simulation
- **Thread mapping store (PostgreSQL)**: CRUD with mocked Supabase client
- **Message router**: Session lookup, thread routing, context injection
- **Command handler**: Command parsing, session management commands

### Running Unit Tests

```bash
bun test:unit
```

Expected output: **79 tests passing**

## Integration Tests

Integration tests run against a real Supabase PostgreSQL instance. They verify:

- Database connectivity
- CRUD operations with real SQL
- Thread claiming/releasing (multi-instance coordination)
- Concurrent access patterns

### Prerequisites

The integration tests require a running Supabase instance with the schema set up.

**Database**: Supabase Metaflow  
**Schema**: `public`  
**Tables**: `thread_mappings`, `instances`

### Environment Variables

Integration tests auto-configure to use Supabase Metaflow:

```bash
# These are set automatically in the test file
OPENCODE_MM_SUPABASE_URL=http://supabase-metaflow-kong.hyperplane-supabase-metaflow.svc.cluster.local
OPENCODE_MM_SUPABASE_ANON_KEY=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9...
```

### Running Integration Tests

```bash
bun test:integration
```

Expected output: **16 tests passing**

### Test Data Cleanup

Integration tests use a unique prefix (`TEST_integ_`) and timestamp to avoid collisions. Tests clean up their own data in `afterAll` hooks, but if tests fail mid-execution, orphaned records may remain.

To clean up manually:

```sql
DELETE FROM public.thread_mappings WHERE session_id LIKE 'ses_TEST_integ_%';
```

## Database Schema

### thread_mappings

```sql
CREATE TABLE public.thread_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_root_post_id TEXT UNIQUE NOT NULL,
  channel_id TEXT NOT NULL,
  opencode_session_id TEXT NOT NULL,
  mattermost_user_id TEXT NOT NULL,
  mode TEXT DEFAULT 'normal',
  metadata JSONB DEFAULT '{}',
  claimed_by TEXT,
  claimed_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_thread_mappings_session ON public.thread_mappings(opencode_session_id);
CREATE INDEX idx_thread_mappings_user ON public.thread_mappings(mattermost_user_id);
CREATE INDEX idx_thread_mappings_channel ON public.thread_mappings(channel_id);
```

### instances

```sql
CREATE TABLE public.instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id TEXT UNIQUE NOT NULL,
  last_heartbeat TIMESTAMPTZ NOT NULL,
  is_leader BOOLEAN DEFAULT FALSE,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_instances_heartbeat ON public.instances(last_heartbeat);
CREATE INDEX idx_instances_leader ON public.instances(is_leader) WHERE is_leader = true;
```

## Test Coverage

### Unit Test Coverage

| Component | Tests | Coverage |
|-----------|-------|----------|
| ThreadMappingStore (JSON) | 22 | CRUD, indexes, persistence |
| ThreadMappingPgStore | 22 | CRUD, claiming, health checks |
| MessageRouter | 19 | Routing, context, permission |
| CommandHandler | 16 | Commands, args, validation |

### Integration Test Coverage

| Feature | Tests | Description |
|---------|-------|-------------|
| CRUD Operations | 6 | Create, read, update, delete |
| Thread Claiming | 6 | Claim, release, contention |
| Listing | 2 | listAll, listActive |
| Metadata | 2 | Complex fields, null handling |

## Known Issues

### PostgREST .or() Filter with .update()

PostgREST's `.or()` filter doesn't work correctly when combined with `.update()`. The `claimThread` function uses a two-step approach (select then update) as a workaround.

## Adding New Tests

### Unit Test Template

```typescript
import { describe, test, expect, beforeEach, mock } from "bun:test";

describe("MyComponent", () => {
  beforeEach(() => {
    // Setup mocks
  });

  test("should do something", () => {
    // Arrange
    // Act
    // Assert
  });
});
```

### Integration Test Template

```typescript
import { describe, test, expect, beforeAll, afterAll } from "bun:test";

const TEST_PREFIX = "TEST_mytest_";

describe("Integration: MyFeature", () => {
  let store: ThreadMappingStore;
  const createdIds: string[] = [];

  beforeAll(async () => {
    // Initialize store with real Supabase
  });

  afterAll(async () => {
    // Clean up test data
    for (const id of createdIds) {
      await store.deleteBySessionId(id);
    }
  });

  test("should work with real database", async () => {
    const mapping = createTestMapping();
    createdIds.push(mapping.sessionId);
    // Test real operations
  });
});
```

## CI/CD Integration

Tests run automatically on:
- Pre-commit (unit tests)
- PR creation (all tests)
- Main branch merge (all tests)

Configure in `.github/workflows/test.yml` or equivalent.
