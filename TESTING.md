# Testing Guide

This document describes the complete testing strategy for the OpenCode Mattermost plugin, covering unit tests, integration tests, and end-to-end (E2E) tests.

## Testing Philosophy

The plugin uses a **three-tier testing pyramid**:

1. **Unit Tests** (fast, isolated) - Test individual components with mocked dependencies
2. **Integration Tests** (medium, real DB) - Test PostgreSQL persistence with real Supabase
3. **E2E Tests** (slow, full stack) - Test complete message flows with real Mattermost

```
        /\
       /  \     E2E Tests (6-10 tests)
      /----\    - Full message flow
     /      \   - Real Mattermost instance
    /--------\  
   /          \ Integration Tests (16+ tests)
  /            \- Real PostgreSQL/Supabase
 /--------------\
/                \ Unit Tests (79+ tests)
------------------\- Mocked dependencies, fast execution
```

## Quick Start

```bash
# Run all tests
bun test

# Run unit tests only
bun test:unit

# Run integration tests only
bun test:integration

# Run E2E tests (requires test3 cluster access)
bun test:e2e

# Watch mode for development
bun test:watch
```

## Test Structure

```
tests/
├── __mocks__/                      # Shared mock implementations
│   ├── index.ts                    # Mock exports
│   ├── mattermost-client.mock.ts   # Mattermost HTTP client mock
│   └── supabase-client.mock.ts     # Supabase client mock
│
├── unit/                           # Unit tests (mocked dependencies)
│   ├── unified-store.test.ts       # ThreadMappingStore (JSON + PG)
│   ├── message-router.test.ts      # Message routing logic
│   ├── command-handler.test.ts     # Command parsing and execution
│   └── config.test.ts              # Configuration loading
│
├── integration/                    # Integration tests (real Supabase)
│   └── supabase-store.integration.test.ts  # PostgreSQL store with real DB
│
└── e2e/                            # End-to-end tests (real Mattermost)
    ├── k8s/
    │   └── plugin-job.yaml         # K8s Job for plugin under test
    ├── harness/
    │   └── plugin-harness.ts       # Standalone plugin initializer
    ├── e2e.test.ts                 # E2E test suite
    └── run-e2e.sh                  # Orchestration script
```

---

## Unit Tests

Unit tests use mocked dependencies and run entirely in-memory. They are fast (~2s total) and test component logic in isolation.

### Components Tested

| Component | File | Tests | Description |
|-----------|------|-------|-------------|
| ThreadMappingStore | `unified-store.test.ts` | 44 | CRUD, indexes, claiming, persistence |
| MessageRouter | `message-router.test.ts` | 19 | Session lookup, thread routing, context |
| CommandHandler | `command-handler.test.ts` | 16 | Command parsing, validation, execution |
| Config | `config.test.ts` | varies | Environment variable loading |

### Running Unit Tests

```bash
bun test:unit
```

**Expected output:** 79+ tests passing in ~2 seconds

### Mock Architecture

Unit tests use constructor injection for dependencies:

```typescript
// Example: Testing MessageRouter with mocked store
import { MockMattermostClient } from "../__mocks__/mattermost-client.mock";
import { MockSupabaseClient } from "../__mocks__/supabase-client.mock";

const mockClient = new MockMattermostClient();
const mockStore = new ThreadMappingStore({ supabaseClient: MockSupabaseClient });
const router = new MessageRouter(mockClient, mockStore);
```

### Writing Unit Tests

Follow the Arrange-Act-Assert pattern:

```typescript
import { describe, test, expect, beforeEach, mock } from "bun:test";

describe("MyComponent", () => {
  let component: MyComponent;
  
  beforeEach(() => {
    // Arrange: Setup fresh mocks for each test
    component = new MyComponent(mockDependency);
  });

  test("should do something specific", () => {
    // Arrange (additional setup if needed)
    const input = createTestInput();
    
    // Act
    const result = component.doSomething(input);
    
    // Assert
    expect(result).toEqual(expectedOutput);
  });
});
```

---

## Integration Tests

Integration tests run against a real Supabase PostgreSQL instance. They verify database operations work correctly with real SQL queries.

### Database Configuration

| Field | Value |
|-------|-------|
| **Instance** | Supabase Metaflow |
| **Namespace** | `hyperplane-supabase-metaflow` |
| **Host (internal)** | `supabase-metaflow-kong.hyperplane-supabase-metaflow.svc.cluster.local` |
| **Schema** | `public` |
| **Tables** | `thread_mappings`, `instances` |

### Environment Variables

Integration tests auto-configure using hardcoded values (runs in-cluster):

```bash
# Auto-configured in test file - no manual setup needed
OPENCODE_MM_SUPABASE_URL=http://supabase-metaflow-kong.hyperplane-supabase-metaflow.svc.cluster.local
OPENCODE_MM_SUPABASE_ANON_KEY=<anon-key-from-secret>
```

To retrieve the anon key manually:
```bash
kubectl get secret -n hyperplane-supabase-metaflow supabase-metaflow-jwt \
  -o jsonpath='{.data.anon-key}' | base64 -d
```

### Running Integration Tests

```bash
bun test:integration
```

**Expected output:** 16+ tests passing

### Test Data Isolation

Integration tests use unique prefixes to avoid collisions:
- Prefix: `TEST_integ_`
- Format: `ses_TEST_integ_{timestamp}_{random}`

Tests clean up their own data in `afterAll` hooks. For manual cleanup:

```sql
DELETE FROM public.thread_mappings WHERE opencode_session_id LIKE 'ses_TEST_integ_%';
```

### Test Coverage

| Feature | Tests | Description |
|---------|-------|-------------|
| CRUD Operations | 6 | Create, read, update, delete thread mappings |
| Thread Claiming | 6 | Claim, release, contention handling |
| Listing | 2 | listAll, listByUserId |
| Metadata | 2 | Complex JSONB fields, null handling |

### Writing Integration Tests

```typescript
import { describe, test, expect, beforeAll, afterAll } from "bun:test";

const TEST_PREFIX = "TEST_myfeature_";

describe("Integration: MyFeature", () => {
  let store: ThreadMappingStore;
  const createdIds: string[] = [];

  beforeAll(async () => {
    // Initialize with real Supabase
    store = await ThreadMappingStore.create({
      supabaseUrl: process.env.OPENCODE_MM_SUPABASE_URL,
      supabaseAnonKey: process.env.OPENCODE_MM_SUPABASE_ANON_KEY,
    });
  });

  afterAll(async () => {
    // ALWAYS clean up test data
    for (const id of createdIds) {
      await store.deleteBySessionId(id);
    }
  });

  test("should work with real database", async () => {
    const mapping = createTestMapping(TEST_PREFIX);
    createdIds.push(mapping.sessionId);  // Track for cleanup
    
    await store.save(mapping);
    const retrieved = await store.getByThreadId(mapping.threadRootPostId);
    
    expect(retrieved).toEqual(mapping);
  });
});
```

---

## E2E Tests

End-to-end tests verify the complete message flow from Mattermost user to plugin response. They use a dedicated Mattermost instance on the test3 cluster.

### Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Test Runner   │     │  Plugin Under    │     │   Mattermost    │
│   (WebSocket)   │────▶│  Test (K8s Job)  │────▶│   (test3)       │
│                 │     │                  │     │                 │
│  - Posts DMs    │     │  - Processes     │     │  - Stores msgs  │
│  - Waits for    │     │    messages      │     │  - Broadcasts   │
│    responses    │     │  - Creates       │     │    events       │
│  - Verifies     │     │    threads       │     │                 │
│    behavior     │     │  - Writes to DB  │     │                 │
└─────────────────┘     └──────────────────┘     └─────────────────┘
         │                       │                       │
         │                       ▼                       │
         │              ┌──────────────────┐             │
         │              │    Supabase      │             │
         └─────────────▶│   (Metaflow)     │◀────────────┘
                        │                  │
                        │  - Thread state  │
                        │  - Instances     │
                        └──────────────────┘
```

**Key architectural decision:** The test runner and plugin under test are separate processes. The test runner simulates a Mattermost user via WebSocket/REST API, while the plugin runs in a K8s Job connecting to the same Mattermost instance.

### Mattermost Test Instance

| Field | Value |
|-------|-------|
| **Cluster** | test3 (`gke_gcp-cluster-automation_us-central1_test3`) |
| **Namespace** | `mm-test` |
| **External URL** | `https://mattermost.test3.canopyhub.io` |
| **In-Cluster URL** | `http://mattermost-team-edition.mm-test.svc.cluster.local:8065` |
| **API Base** | `/api/v4` |
| **WebSocket** | `wss://mattermost.test3.canopyhub.io/api/v4/websocket` (external) |
| **WebSocket** | `ws://mattermost-team-edition.mm-test.svc.cluster.local:8065/api/v4/websocket` (internal) |
| **Version** | 10.11.2 (Team Edition) |
| **Database** | MySQL |

### Test Accounts

Credentials stored in K8s secret `mattermost-e2e-test-creds` in namespace `mm-test`:

| Account | Username | User ID | Purpose |
|---------|----------|---------|---------|
| **Bot** | `opencode-test-bot` | `k3mriyjajif5pmzuwzhc5ipure` | Plugin bot account |
| **Admin** | `admin` | (in secret) | System admin for setup |
| **Test User** | `e2e-testuser` | `eszmgh4y7pr5ffomh1wex1er7o` | Simulates human user |

#### Retrieving Credentials

```bash
# Switch to test3 cluster
gcloud container clusters get-credentials test3 --region=us-central1 --project=gcp-cluster-automation

# Get bot token
kubectl get secret mattermost-e2e-test-creds -n mm-test \
  -o jsonpath='{.data.bot-token}' | base64 -d

# Get test user password
kubectl get secret mattermost-e2e-test-creds -n mm-test \
  -o jsonpath='{.data.test-user-password}' | base64 -d

# Get all credentials
kubectl get secret mattermost-e2e-test-creds -n mm-test -o yaml
```

### Team Configuration

| Field | Value |
|-------|-------|
| **Team Name** | `test` |
| **Team ID** | `699ogwfxwfb98nkzsxwqjkq8wc` |

### Running E2E Tests

#### Prerequisites

1. Access to test3 GKE cluster
2. `kubectl` configured for test3
3. Supabase Metaflow secret copied to mm-test namespace

```bash
# 1. Switch to test3 cluster
export PATH=/opt/google-cloud-sdk/bin:$PATH
gcloud container clusters get-credentials test3 --region=us-central1 --project=gcp-cluster-automation

# 2. Ensure supabase keys exist in mm-test namespace
kubectl get secret supabase-metaflow-keys -n mm-test || \
  kubectl create secret generic supabase-metaflow-keys -n mm-test \
    --from-literal=anon-key="$(kubectl get secret -n hyperplane-supabase-metaflow supabase-metaflow-jwt -o jsonpath='{.data.anon-key}' | base64 -d)"

# 3. Run E2E tests
bun test:e2e
```

### E2E Test Scenarios

| Scenario | Description | Verifies |
|----------|-------------|----------|
| **Bot Connection** | WebSocket connects and stays alive | Heartbeat, reconnection |
| **DM Processing** | User sends DM, bot responds | Message routing |
| **Thread Creation** | New session creates thread | Thread lifecycle |
| **Thread Mapping** | Thread maps to correct session | DB persistence |
| **Commands** | `!sessions`, `!help` work | Command handler |
| **Reactions** | Emoji reactions trigger actions | Reaction handler |
| **File Upload** | Files attach to threads | File handler |

### K8s Job Configuration

The plugin under test runs as a K8s Job (`tests/e2e/k8s/plugin-job.yaml`):

```yaml
# Key configuration
apiVersion: batch/v1
kind: Job
metadata:
  name: opencode-mm-plugin-e2e
  namespace: mm-test
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 3600
  template:
    spec:
      containers:
        - name: plugin
          image: oven/bun:1.1.42
          env:
            # Mattermost (test3 internal)
            - name: MATTERMOST_URL
              value: "http://mattermost-team-edition.mm-test.svc.cluster.local:8065/api/v4"
            - name: MATTERMOST_WS_URL
              value: "ws://mattermost-team-edition.mm-test.svc.cluster.local:8065/api/v4/websocket"
            - name: MATTERMOST_TOKEN
              valueFrom:
                secretKeyRef:
                  name: mattermost-e2e-test-creds
                  key: bot-token
            # Supabase (Metaflow)
            - name: OPENCODE_MM_SUPABASE_URL
              value: "http://supabase-metaflow-kong.hyperplane-supabase-metaflow.svc.cluster.local"
            - name: OPENCODE_MM_SUPABASE_ANON_KEY
              valueFrom:
                secretKeyRef:
                  name: supabase-metaflow-keys
                  key: anon-key
            # Phase 3 (Postgres-only)
            - name: OPENCODE_MM_MIGRATION_PHASE
              value: "3"
```

### E2E Test Implementation

Tests use the Mattermost WebSocket and REST API to simulate user interactions:

```typescript
// tests/e2e/e2e.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";

describe("E2E: Mattermost Plugin", () => {
  let wsClient: WebSocket;
  let botUserId: string;
  let testUserId: string;
  let dmChannelId: string;

  beforeAll(async () => {
    // Connect as test user via WebSocket
    wsClient = new WebSocket(WS_URL);
    await authenticateAsTestUser();
    
    // Get or create DM channel with bot
    dmChannelId = await getOrCreateDMChannel(testUserId, botUserId);
  });

  afterAll(async () => {
    wsClient.close();
    await cleanupTestData();
  });

  test("bot responds to DM", async () => {
    // Send DM as test user
    const post = await postMessage(dmChannelId, "!help");
    
    // Wait for bot response
    const response = await waitForBotResponse(dmChannelId, 10000);
    
    expect(response.message).toContain("Available commands");
  });
});
```

---

## Database Schema

### thread_mappings

Primary table for thread-to-session mappings:

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

-- Indexes for common queries
CREATE INDEX idx_thread_mappings_session ON public.thread_mappings(opencode_session_id);
CREATE INDEX idx_thread_mappings_user ON public.thread_mappings(mattermost_user_id);
CREATE INDEX idx_thread_mappings_channel ON public.thread_mappings(channel_id);
```

### instances

Instance registry for multi-instance coordination:

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

---

## Known Issues

### PostgREST .or() Filter with .update()

PostgREST's `.or()` filter doesn't work correctly when combined with `.update()`. The `claimThread` function uses a two-step approach (select then update) as a workaround.

**Bug:** When using `.or('claimed_by.is.null,claimed_until.lt.${now}')` with `.update()`, the filter is ignored and ALL rows are updated.

**Solution:** Use two-step approach:
1. SELECT to find eligible rows
2. UPDATE with specific ID

---

## Test Data Cleanup

### Automated Cleanup

All tests clean up their own data in `afterAll` hooks using tracked IDs.

### Manual Cleanup

```bash
# Clean up integration test data
kubectl exec -n hyperplane-supabase-metaflow \
  $(kubectl get pod -n hyperplane-supabase-metaflow -l app.kubernetes.io/name=postgresql -o name | head -1) \
  -- psql -U postgres -d postgres -c "DELETE FROM public.thread_mappings WHERE opencode_session_id LIKE 'ses_TEST_%';"

# Clean up E2E test data
kubectl exec -n hyperplane-supabase-metaflow \
  $(kubectl get pod -n hyperplane-supabase-metaflow -l app.kubernetes.io/name=postgresql -o name | head -1) \
  -- psql -U postgres -d postgres -c "DELETE FROM public.thread_mappings WHERE opencode_session_id LIKE 'ses_E2E_%';"
```

---

## CI/CD Integration

Tests run automatically on:
- **Pre-commit:** Unit tests only (fast feedback)
- **PR Creation:** Unit + Integration tests
- **Main Branch Merge:** All tests including E2E

### GitHub Actions Configuration

```yaml
# .github/workflows/test.yml
name: Tests

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bun test:unit

  integration-tests:
    runs-on: ubuntu-latest
    needs: unit-tests
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
      - uses: google-github-actions/auth@v2
        with:
          credentials_json: ${{ secrets.GCP_CREDENTIALS }}
      - uses: google-github-actions/get-gke-credentials@v2
        with:
          cluster_name: test3
          location: us-central1
          project_id: gcp-cluster-automation
      - run: bun install
      - run: bun test:integration

  e2e-tests:
    runs-on: ubuntu-latest
    needs: integration-tests
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
      - uses: google-github-actions/auth@v2
        with:
          credentials_json: ${{ secrets.GCP_CREDENTIALS }}
      - uses: google-github-actions/get-gke-credentials@v2
        with:
          cluster_name: test3
          location: us-central1
          project_id: gcp-cluster-automation
      - run: bun install
      - run: bun test:e2e
```

---

## Manual Testing

### Testing via Mattermost UI

1. **Login:** https://mattermost.test3.canopyhub.io
   - Username: `e2e-testuser`
   - Password: (from secret `mattermost-e2e-test-creds`)

2. **DM the bot:** Find `@opencode-test-bot` and send messages

3. **Verify in logs:**
   ```bash
   kubectl logs -n mm-test -l app.kubernetes.io/name=mattermost-team-edition -f
   ```

### Testing Plugin Locally

```bash
# Set environment for test3 Mattermost
export MATTERMOST_URL="https://mattermost.test3.canopyhub.io/api/v4"
export MATTERMOST_WS_URL="wss://mattermost.test3.canopyhub.io/api/v4/websocket"
export MATTERMOST_TOKEN="$(kubectl get secret mattermost-e2e-test-creds -n mm-test -o jsonpath='{.data.bot-token}' | base64 -d)"

# Run plugin
bun run src/index.ts
```

---

## Troubleshooting

### Tests failing to connect to Supabase

1. Verify you're in the correct cluster context
2. Check Supabase pods are running:
   ```bash
   kubectl get pods -n hyperplane-supabase-metaflow
   ```
3. Test connectivity:
   ```bash
   curl -s http://supabase-metaflow-kong.hyperplane-supabase-metaflow.svc.cluster.local/rest/v1/ \
     -H "apikey: <anon-key>" | head -20
   ```

### E2E tests failing to connect to Mattermost

1. Verify Mattermost is running:
   ```bash
   kubectl get pods -n mm-test
   ```
2. Test API connectivity:
   ```bash
   curl -s https://mattermost.test3.canopyhub.io/api/v4/system/ping
   ```
3. Verify bot token is valid:
   ```bash
   curl -s https://mattermost.test3.canopyhub.io/api/v4/users/me \
     -H "Authorization: Bearer $(kubectl get secret mattermost-e2e-test-creds -n mm-test -o jsonpath='{.data.bot-token}' | base64 -d)"
   ```

### Orphaned test data

If tests fail mid-execution, clean up manually:
```sql
DELETE FROM public.thread_mappings WHERE opencode_session_id LIKE 'ses_TEST_%';
DELETE FROM public.instances WHERE instance_id LIKE 'TEST_%';
```
