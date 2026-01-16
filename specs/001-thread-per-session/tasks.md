# Tasks: Thread-Per-Session Multi-Session Management

**Input**: Design documents from `/specs/001-thread-per-session/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Not explicitly requested - test tasks omitted.

**Organization**: Tasks grouped by user story from spec.md priorities.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1-US6)
- Include exact file paths in descriptions

## Path Conventions

- **Single project**: `src/` at repository root
- OpenCode plugin entry: `.opencode/plugin/mattermost-control/index.ts`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and core type definitions

- [ ] T001 Add ThreadSessionMapping types to src/models/index.ts
- [ ] T002 [P] Create ThreadMappingFile schema with Zod validation in src/models/thread-mapping.ts
- [ ] T003 [P] Create InboundRouteResult types in src/models/routing.ts

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T004 Create ThreadMappingStore class in src/persistence/thread-mapping-store.ts (load/save/merge operations)
- [ ] T005 [P] Create ThreadManager class shell in src/thread-manager.ts (empty methods for createThread, endThread, reconnectThread)
- [ ] T006 Initialize ThreadMappingStore on plugin load in .opencode/plugin/mattermost-control/index.ts
- [ ] T007 Load persisted mappings on plugin initialization and rebuild indexes

**Checkpoint**: Foundation ready - persistence layer operational, user story implementation can begin

---

## Phase 3: User Story 1 - Automatic Session Thread Creation (Priority: P1) 🎯 MVP

**Goal**: When OpenCode session starts, automatically create a dedicated Mattermost thread

**Independent Test**: Start OpenCode session → Verify thread appears in Mattermost DM with session info

### Implementation for User Story 1

- [ ] T008 [US1] Add session polling to OpenCodeSessionRegistry in src/opencode-session-registry.ts (detect new sessions)
- [ ] T009 [US1] Implement ThreadManager.createThread() in src/thread-manager.ts per contract C-001
- [ ] T010 [US1] Create formatThreadRootPost() helper in src/thread-manager.ts (emoji, project, directory, timestamp)
- [ ] T011 [US1] Add getDmChannelForUser() helper to SessionManager in src/session-manager.ts
- [ ] T012 [US1] Wire auto-thread creation: on new session detected → create thread → persist mapping in index.ts
- [ ] T013 [US1] Add session event emission to OpenCodeSessionRegistry (onNewSession callback)
- [ ] T014 [US1] Handle thread creation errors gracefully (log, continue without thread)

**Checkpoint**: User Story 1 complete - sessions get threads automatically on startup

---

## Phase 4: User Story 2 - Send Prompts to Session via Thread (Priority: P1)

**Goal**: Messages posted in a session thread are forwarded to the correct OpenCode session

**Independent Test**: Post message in session thread → Verify prompt arrives at correct OpenCode session

### Implementation for User Story 2

- [ ] T015 [US2] Extend MessageRouter.route() in src/message-router.ts to check post.root_id
- [ ] T016 [US2] Add ThreadMappingStore.getByThreadRootPostId() lookup method
- [ ] T017 [US2] Implement thread prompt routing: root_id present → lookup mapping → route to session
- [ ] T018 [US2] Update handleUserMessage() in index.ts to use thread-aware routing
- [ ] T019 [US2] Pass threadRootPostId context through to prompt injection
- [ ] T020 [US2] Handle file attachments in thread messages (forward to session)

**Checkpoint**: User Story 2 complete - thread messages route to correct sessions

---

## Phase 5: User Story 3 - Receive Responses in Session Thread (Priority: P1)

**Goal**: OpenCode responses stream back to the correct session's thread

**Independent Test**: Send prompt → Verify response streams to same thread (not main DM)

### Implementation for User Story 3

- [ ] T021 [US3] Extend ResponseStreamer to accept threadRootPostId in src/response-streamer.ts
- [ ] T022 [US3] Modify startStream() to create posts with root_id parameter
- [ ] T023 [US3] Update pendingResponseContext to include threadRootPostId
- [ ] T024 [US3] Modify event handler to lookup thread mapping for response routing
- [ ] T025 [US3] Update tool usage posts to go to correct thread
- [ ] T026 [US3] Update thinking posts to go to correct thread

**Checkpoint**: User Story 3 complete - full bi-directional thread communication works

---

## Phase 6: User Story 4 - Parallel Multi-Session Control (Priority: P2)

**Goal**: Multiple sessions can be controlled independently via separate threads

**Independent Test**: Start 2+ sessions → Send prompts to each thread → Verify no cross-contamination

### Implementation for User Story 4

- [ ] T027 [US4] Remove global pendingResponseContext, use Map<sessionId, ResponseContext>
- [ ] T028 [US4] Update event handler to lookup response context by sessionId
- [ ] T029 [US4] Ensure each session's events route only to its thread
- [ ] T030 [US4] Handle concurrent streaming to multiple threads

**Checkpoint**: User Story 4 complete - parallel session control works

---

## Phase 7: User Story 5 - Session Thread Lifecycle Management (Priority: P2)

**Goal**: Thread status updates when session ends, threads reject prompts to ended sessions

**Independent Test**: Close session → Verify thread shows "ended" message → New prompt rejected

### Implementation for User Story 5

- [ ] T031 [US5] Implement ThreadManager.endThread() in src/thread-manager.ts
- [ ] T032 [US5] Post session-ended message to thread with duration and timestamp
- [ ] T033 [US5] Update mapping status to "ended" and persist
- [ ] T034 [US5] Add EndedSessionRoute handling in message-router.ts
- [ ] T035 [US5] Hook session.idle event with no pending work → mark session ended
- [ ] T036 [US5] Implement "disconnected" status for connection loss (update mapping, reject new prompts with retry guidance)

**Checkpoint**: User Story 5 complete - session lifecycle properly reflected in threads

---

## Phase 8: User Story 6 - Thread Navigation and Session Discovery (Priority: P3)

**Goal**: Users can easily find and navigate between session threads

**Independent Test**: Use !sessions command → See list of threads with project names

### Implementation for User Story 6

- [ ] T037 [US6] Update !sessions command to list threads with their root post links
- [ ] T038 [US6] Modify command output format to include thread info
- [ ] T039 [US6] Add thread link/deep link to session info where possible

**Checkpoint**: User Story 6 complete - session discovery via commands works

---

## Phase 9: Main DM Command-Only Mode (Cross-Cutting)

**Purpose**: Enforce main DM accepts only commands, rejects prompts (FR-014)

- [ ] T040 Modify MessageRouter to detect prompts in main DM (no root_id, not a command)
- [ ] T041 Implement MainDmPromptRoute error response per contract C-002
- [ ] T042 Return guidance message directing user to session threads
- [ ] T043 Update !help command to explain thread-based workflow

---

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [ ] T044 [P] Add cleanup of orphaned mappings (sessions that no longer exist)
- [ ] T045 [P] Add periodic persistence save (debounced, not on every change)
- [ ] T046 Verify thread reconnection on plugin reload (load mappings → verify sessions exist)
- [ ] T047 Add logging for thread operations in src/logger.ts
- [ ] T048 Run manual validation of all user story acceptance criteria
- [ ] T049 Update README.md with thread-per-session documentation
- [ ] T050 [P] Verify emoji reactions (approve/deny/cancel) work on thread messages in src/reaction-handler.ts
- [ ] T051 [P] Update ReactionHandler to use threadRootPostId context for reactions

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3-8)**: All depend on Foundational phase completion
- **Main DM Mode (Phase 9)**: Depends on Phase 4 (routing infrastructure)
- **Polish (Phase 10)**: Depends on core user stories (3-5) being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational - No dependencies on other stories
- **User Story 2 (P1)**: Can start after Foundational - No dependencies on US1
- **User Story 3 (P1)**: Depends on US2 (needs routing in place to know where to respond)
- **User Story 4 (P2)**: Depends on US3 (needs response streaming working)
- **User Story 5 (P2)**: Depends on US1 (needs thread creation working)
- **User Story 6 (P3)**: Depends on US1 (needs threads to exist)

### Critical Path

```
Setup → Foundational → US1 (thread creation) → US2 (routing) → US3 (responses) → US4 (parallel)
                    ↘ US5 (lifecycle) can parallel after US1
                    ↘ US6 (discovery) can parallel after US1
```

### Parallel Opportunities

**Within Phase 1 (Setup)**:
```
T002 (ThreadMappingFile schema) || T003 (InboundRouteResult types)
```

**Within Phase 2 (Foundational)**:
```
T004 (ThreadMappingStore) → T006, T007 (depends on store)
T005 (ThreadManager shell) can parallel with T004
```

**Across User Stories** (after Foundational complete):
```
US1 (thread creation) + US5 (lifecycle) + US6 (discovery) can start together
US2 creates routing infrastructure, depends only on ThreadMappingStore from Foundational
```

---

## Parallel Example: Phase 1 Setup

```bash
# Launch all parallel setup tasks:
Task T002: "Create ThreadMappingFile schema with Zod validation in src/models/thread-mapping.ts"
Task T003: "Create InboundRouteResult types in src/models/routing.ts"
```

---

## Implementation Strategy

### MVP First (User Stories 1-3 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL - blocks all stories)
3. Complete Phase 3: User Story 1 (auto thread creation)
4. Complete Phase 4: User Story 2 (send prompts via thread)
5. Complete Phase 5: User Story 3 (receive responses in thread)
6. **STOP and VALIDATE**: Test end-to-end thread workflow
7. Deploy/demo if ready - single session thread works

### Incremental Delivery

1. **MVP**: Setup + Foundational + US1 + US2 + US3 → Single session works via thread
2. **Multi-Session**: Add US4 → Parallel sessions work
3. **Lifecycle**: Add US5 → Sessions show ended state
4. **Polish**: Add US6 + Phase 9 + Phase 10 → Full feature complete

### Recommended Sequence

```
Day 1: T001-T007 (Setup + Foundational)
Day 2: T008-T014 (US1: Thread Creation)
Day 3: T015-T020 (US2: Routing) + T021-T026 (US3: Responses)
Day 4: T027-T030 (US4: Parallel) + T031-T036 (US5: Lifecycle)
Day 5: T037-T049 (US6 + Polish)
```

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- US1, US2, US3 are all P1 priority - complete all for MVP
- Persistence must be robust - crash recovery is a requirement
- Main DM command-only mode (Phase 9) is critical for clean UX
- Total: 49 tasks across 10 phases
