# Feature Specification: Thread-Per-Session Multi-Session Management

**Feature Branch**: `001-thread-per-session`  
**Created**: 2026-01-15  
**Status**: Draft  
**Input**: User description: "Enhance opencode-mattermost-plugin to automatically connect every OpenCode session as it starts, managing each session's communication in its own dedicated Mattermost thread within the DM channel. Users can control multiple active sessions in parallel via separate threads."

## Clarifications

### Session 2026-01-15

- Q: Should thread-session mappings persist across OpenCode restarts? → A: Yes, persist mappings so threads reconnect after crash/restart.
- Q: How should the system handle messages posted to the main DM channel (not in any thread)? → A: Commands only - main DM accepts only commands (`!sessions`, `!help`), rejects prompts with guidance to use a session thread.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Automatic Session Thread Creation (Priority: P1)

As a user, when I start a new OpenCode session, the system automatically creates a dedicated thread in my Mattermost DM with the bot. This thread displays the session name, project directory, and start timestamp, becoming my control channel for that specific session.

**Why this priority**: This is the foundation of the entire feature. Without automatic thread creation, no other functionality can work. It eliminates the manual `/mattermost-connect` step and enables the thread-per-session architecture.

**Independent Test**: Can be fully tested by starting an OpenCode session and verifying a new thread appears in Mattermost DM with correct session information. Delivers immediate value by providing visibility into all active sessions.

**Acceptance Scenarios**:

1. **Given** user has Mattermost credentials configured and starts OpenCode, **When** the OpenCode session initializes, **Then** a new thread is created in the user's DM with the bot containing:
   - Session name/title (or auto-generated identifier)
   - Project directory path
   - Session start timestamp
   - Session short ID for reference

2. **Given** user starts multiple OpenCode sessions in different project directories, **When** each session initializes, **Then** each session gets its own distinct thread with accurate session-specific information.

3. **Given** user has an existing DM conversation with the bot, **When** a new session starts, **Then** the new thread is created as a reply to a root post without disrupting existing threads or conversations.

---

### User Story 2 - Send Prompts to Session via Thread (Priority: P1)

As a user, when I post a message in a session's thread, that message is forwarded as a prompt to the specific OpenCode session associated with that thread.

**Why this priority**: This is the core interaction model. Users must be able to send prompts to specific sessions. Without this, threads are informational only and provide no control capability.

**Independent Test**: Can be tested by posting a message in a session thread and verifying the corresponding OpenCode session receives and processes it. Delivers the core value of remote session control.

**Acceptance Scenarios**:

1. **Given** a session thread exists for OpenCode session A, **When** user posts "list all files in src/", **Then** that prompt is sent to session A and not to any other session.

2. **Given** two session threads exist (Session A thread and Session B thread), **When** user posts a message in Session B's thread, **Then** only Session B receives the prompt.

3. **Given** a session thread exists, **When** user posts a message with file attachments, **Then** the attachments are processed and forwarded to the session along with the text prompt.

---

### User Story 3 - Receive Responses in Session Thread (Priority: P1)

As a user, when an OpenCode session generates a response (text, thinking, tool calls, completions), those responses are posted back to that session's specific thread, maintaining conversation context.

**Why this priority**: Responses must appear in the correct thread to maintain the 1:1 session-to-thread mapping. Without this, users cannot distinguish which session produced which output.

**Independent Test**: Can be tested by sending a prompt to a session and verifying all response components appear in the correct thread. Delivers complete bi-directional communication.

**Acceptance Scenarios**:

1. **Given** user sends a prompt in Session A's thread, **When** Session A generates a text response, **Then** the response appears as a reply in Session A's thread with real-time streaming.

2. **Given** Session A is processing a request that involves AI thinking, **When** thinking content is generated, **Then** the thinking is displayed in Session A's thread (collapsed or summarized format).

3. **Given** Session A executes tools during processing, **When** tool calls complete, **Then** tool usage summary is posted to Session A's thread.

4. **Given** Session A completes processing, **When** the session becomes idle, **Then** a completion notification is posted to Session A's thread.

---

### User Story 4 - Parallel Multi-Session Control (Priority: P2)

As a user with multiple active OpenCode sessions, I can interact with each session independently and simultaneously through their respective threads without cross-contamination of prompts or responses.

**Why this priority**: While users can technically use P1 stories sequentially, parallel control is the key value proposition that justifies this architecture over the current single-session model.

**Independent Test**: Can be tested by having two active sessions, sending prompts to both threads, and verifying each session receives and responds correctly in its own thread.

**Acceptance Scenarios**:

1. **Given** three OpenCode sessions are running (A, B, C) with their threads, **When** user sends different prompts to all three threads in quick succession, **Then** each session processes its own prompt independently and responses appear in correct threads.

2. **Given** Session A is processing a long-running task, **When** user sends a prompt to Session B's thread, **Then** Session B begins processing immediately without waiting for Session A.

3. **Given** multiple sessions are generating responses simultaneously, **When** responses stream in, **Then** each response streams to its correct thread without mixing content.

---

### User Story 5 - Session Thread Lifecycle Management (Priority: P2)

As a user, when an OpenCode session ends (user closes it, session times out, or connection lost), the system updates the session's thread to reflect the session status, and the thread becomes read-only for new prompts.

**Why this priority**: Important for maintaining accurate state visibility, but not blocking for core functionality. Users can still operate effectively without explicit end-of-session markers.

**Independent Test**: Can be tested by closing an OpenCode session and verifying the thread updates with a closure message and no longer accepts new prompts.

**Acceptance Scenarios**:

1. **Given** a session thread exists for an active session, **When** the OpenCode session is closed normally, **Then** a final message is posted to the thread indicating session ended, and attempting to send new messages to that thread results in an error message.

2. **Given** a session thread exists, **When** the session connection is lost unexpectedly, **Then** the thread is updated with a disconnection notice and prompts are queued or rejected with appropriate messaging.

3. **Given** an ended session thread, **When** user starts a new session in the same project directory, **Then** a new thread is created (not reusing the old thread) to maintain clear session boundaries.

---

### User Story 6 - Thread Navigation and Session Discovery (Priority: P3)

As a user with many session threads (current and historical), I can easily identify which thread corresponds to which session and navigate between them.

**Why this priority**: Enhances usability when dealing with many sessions but not required for basic functionality. Users can manually scan threads without this.

**Independent Test**: Can be tested by having multiple session threads and verifying the root post content and thread organization enables easy identification.

**Acceptance Scenarios**:

1. **Given** multiple session threads exist, **When** user views the DM channel, **Then** each thread's root post clearly identifies the session by project name, directory, and timestamp.

2. **Given** a user wants to find a specific session's thread, **When** user searches for the project name in Mattermost, **Then** the relevant session thread(s) are discoverable.

---

### Edge Cases

- **What happens when Mattermost credentials are not configured?** The plugin logs a warning but does not block OpenCode startup. Sessions operate without Mattermost integration until credentials are provided.

- **What happens when Mattermost connection fails during session startup?** The session continues operating locally. A retry mechanism attempts to establish the thread. If connection is restored later, the thread is created at that point.

- **What happens when a user posts to a thread for a session that no longer exists?** User receives an error message indicating the session is no longer active and suggesting they start a new session.

- **What happens when the same user starts many sessions simultaneously?** Each session gets its own thread. System handles concurrent thread creation without race conditions.

- **What happens when network connectivity is lost mid-conversation?** Responses are buffered and delivered when connectivity is restored, or user is notified of delivery failure.

- **How does the system handle messages posted to the main DM channel (not in any thread)?** The main DM channel accepts only system commands (`!sessions`, `!help`, etc.). Prompt-like messages are rejected with an error message guiding the user to post in a session thread instead.

- **What happens if OpenCode crashes and restarts?** Thread-session mappings are persisted, so when the session resumes, it reconnects to its existing thread and continues the conversation.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST automatically create a Mattermost thread when an OpenCode session starts, without requiring manual user action.

- **FR-002**: System MUST post a thread root message containing session identifier, project name, working directory, and start timestamp.

- **FR-003**: System MUST route messages posted in a session thread exclusively to the OpenCode session associated with that thread.

- **FR-004**: System MUST post all session outputs (text responses, thinking, tool calls, notifications) to the correct session thread.

- **FR-005**: System MUST support real-time streaming of responses to the session thread with appropriate buffering.

- **FR-006**: System MUST persist thread-to-session mappings so that sessions can reconnect to their existing threads after OpenCode process restart or crash.

- **FR-007**: System MUST support multiple concurrent session threads with independent message routing.

- **FR-008**: System MUST post a session-ended notification to the thread when the OpenCode session terminates.

- **FR-009**: System MUST reject or provide error feedback for messages sent to threads of ended sessions.

- **FR-010**: System MUST handle Mattermost connection failures gracefully without crashing the OpenCode session.

- **FR-011**: System MUST support emoji reactions on thread messages for session control (approve/deny permissions, cancel operations).

- **FR-012**: System MUST handle file attachments in thread messages, forwarding them to the associated session.

- **FR-013**: System MUST provide a way to list all active session threads (via command in main DM or status tool).

- **FR-014**: System MUST accept only system commands (e.g., `!sessions`, `!help`) in the main DM channel and reject prompt-like messages with guidance to use a session thread.

### Key Entities

- **Session Thread**: A Mattermost thread dedicated to a single OpenCode session. Contains a root post with session metadata and all subsequent communication for that session.

- **Thread-Session Mapping**: The persistent association between a Mattermost thread ID and an OpenCode session ID. Used to route messages bidirectionally and survives process restarts.

- **Thread Root Post**: The initial post that creates the thread. Contains session name, directory, timestamp, and serves as the thread anchor.

- **Session State**: The lifecycle state of a session (active, idle, ended, disconnected) which determines how thread messages are handled.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can control an OpenCode session via Mattermost within 10 seconds of session startup without any manual connection step.

- **SC-002**: System correctly routes 100% of thread messages to their associated sessions with zero cross-contamination.

- **SC-003**: Users can operate 5+ concurrent OpenCode sessions via separate threads simultaneously.

- **SC-004**: Response latency from OpenCode to Mattermost thread is comparable to current implementation (within 500ms of session output).

- **SC-005**: Session thread creation succeeds on first attempt in 99%+ of cases when Mattermost is reachable.

- **SC-006**: Users can identify the correct session thread within 5 seconds when viewing the DM channel with multiple threads.

- **SC-007**: Zero orphaned threads (threads without session association) or orphaned sessions (sessions without threads) under normal operation.

## Assumptions

- User has already configured valid Mattermost credentials (MATTERMOST_TOKEN, MATTERMOST_URL environment variables).
- Mattermost instance supports threaded messaging in direct message channels.
- OpenCode plugin system provides session lifecycle events (session start, session end) that can trigger thread creation.
- The bot user has permission to create posts and threads in DM channels.
- Users interact with the bot via direct messages (not channels), consistent with current architecture.

## Out of Scope

- Channel-based (non-DM) thread management
- Thread archiving or cleanup of old session threads
- Cross-user session sharing (one user controlling another user's session)
- Migration of existing single-session conversations to thread format
- Mobile-specific Mattermost UI optimizations
