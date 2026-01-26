# Team System Design Document

**Date:** 2026-01-26  
**Status:** Draft  
**Author:** AI-assisted design  

---

## 1. Overview

### Problem Statement

Currently, the opencode-mattermost-plugin uses an **Owner-Centric** permission model where:
- A single `MATTERMOST_OWNER_USER_ID` controls who can interact with the bot
- In shared channels, non-owners must request approval for each interaction
- The owner must manually approve each guest user (options: once, permanently, or all users)

This creates friction for teams where multiple trusted users need regular access.

### Proposed Solution

Introduce a **Team System** that allows the owner to define a persistent list of trusted users ("team members") who:
- Can @mention the bot without approval
- Can create new sessions in any channel
- Bypass the guest approval flow entirely
- Have equivalent permissions to the owner (except team management)

---

## 2. Data Model

### 2.1 Team Configuration Schema

```typescript
interface TeamConfig {
  // Team identity
  id: string;                    // Auto-generated UUID
  name: string;                  // Human-readable name (e.g., "Engineering Team")
  createdAt: string;             // ISO timestamp
  updatedAt: string;             // ISO timestamp
  
  // Membership
  ownerId: string;               // Mattermost user ID of the owner
  members: TeamMember[];         // Array of team members
  
  // Settings
  settings: TeamSettings;
}

interface TeamMember {
  userId: string;                // Mattermost user ID
  username: string;              // Mattermost username (for display)
  addedAt: string;               // ISO timestamp
  addedBy: string;               // User ID who added this member
  role: "member" | "admin";      // Future: admin can also manage team
}

interface TeamSettings {
  allowMembersToCreateSessions: boolean;  // Default: true
  allowMembersToApproveGuests: boolean;   // Default: false (owner only)
  syncWithMattermostTeam: boolean;        // Default: false
  mattermostTeamId?: string;              // If syncing with MM team
}
```

### 2.2 Integration with Existing Models

**ThreadSessionMapping** - Add team context:

```typescript
interface ThreadSessionMapping {
  // ... existing fields ...
  
  // NEW: Team-related fields
  teamId?: string;               // Which team this session belongs to (if any)
  createdByTeamMember?: boolean; // Was this created by a team member (not owner)?
}
```

**No changes to `approvedUsers`** - The per-thread approval system remains for non-team guests.

### 2.3 Hierarchy

```
┌─────────────────────────────────────────────────────────┐
│                      OWNER                               │
│  - Full control over everything                          │
│  - Manages team membership                               │
│  - Can revoke any access                                 │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                   TEAM MEMBERS                           │
│  - Bypass guest approval                                 │
│  - Create sessions                                       │
│  - @mention bot freely                                   │
│  - Cannot manage team (unless admin role)                │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                     GUESTS                               │
│  - Require per-thread approval                           │
│  - Existing behavior unchanged                           │
└─────────────────────────────────────────────────────────┘
```

---

## 3. Configuration

### 3.1 New Environment Variables

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `OPENCODE_MM_TEAM_FILE` | string | `~/.config/opencode/mattermost-team.json` | Path to team config file |
| `OPENCODE_MM_TEAM_SYNC_MM` | boolean | `false` | Sync team with a Mattermost team |
| `OPENCODE_MM_TEAM_MM_ID` | string | - | Mattermost team ID to sync with |
| `OPENCODE_MM_TEAM_CACHE_TTL` | number | `300000` | Cache TTL in ms (5 min default) |

### 3.2 Config Schema Additions

```typescript
// In src/config.ts
const teamSchema = z.object({
  enabled: z.boolean().default(true),
  filePath: z.string().default("~/.config/opencode/mattermost-team.json"),
  syncWithMattermost: z.boolean().default(false),
  mattermostTeamId: z.string().optional(),
  cacheTtlMs: z.number().default(300000),
});

// Add to main config
team: teamSchema.default({}),
```

### 3.3 Backward Compatibility

- If no team file exists → behave exactly as before (owner-only + guest approval)
- If team file exists but is empty → same as above
- Existing `MATTERMOST_OWNER_USER_ID` remains the source of truth for ownership
- Existing `approvedUsers` per-thread continues to work for non-team guests

---

## 4. Commands

### 4.1 Team Management Commands

| Command | Permission | Description |
|---------|------------|-------------|
| `!team` | Owner only | Show team status and member list |
| `!team add @user` | Owner only | Add user to team |
| `!team add @user1 @user2` | Owner only | Add multiple users |
| `!team remove @user` | Owner only | Remove user from team |
| `!team clear` | Owner only | Remove all team members |
| `!team sync` | Owner only | Sync with Mattermost team (if configured) |

### 4.2 Command Output Examples

**`!team`**
```
👥 **Team: Engineering Team**

**Owner:** @yevgeniy
**Members (3):**
  • @alice (added 2026-01-20)
  • @bob (added 2026-01-22)
  • @charlie (added 2026-01-25)

**Settings:**
  • Members can create sessions: ✅
  • Members can approve guests: ❌
  • Mattermost sync: ❌
```

**`!team add @alice`**
```
✅ Added @alice to the team.

They can now:
  • @mention the bot without approval
  • Create new sessions
  • Interact in any thread you own
```

**`!team remove @bob`**
```
✅ Removed @bob from the team.

Note: They can still interact in threads where they were individually approved.
```

### 4.3 Permission Checks

```
┌──────────────────────────────────────────────────────────┐
│                  Command: !team add @user                 │
└──────────────────────────────────────────────────────────┘
                          │
                          ▼
                ┌─────────────────┐
                │ Is sender the   │──── No ───▶ "Only the owner can
                │ configured      │             manage the team."
                │ owner?          │
                └────────┬────────┘
                         │ Yes
                         ▼
                ┌─────────────────┐
                │ Does @user      │──── No ───▶ "User @user not found."
                │ exist in MM?    │
                └────────┬────────┘
                         │ Yes
                         ▼
                ┌─────────────────┐
                │ Is @user        │──── Yes ──▶ "@user is already
                │ already in      │             a team member."
                │ team?           │
                └────────┬────────┘
                         │ No
                         ▼
                   Add to team
                   Save config
                   Confirm to user
```

---

## 5. Behavior Changes

### 5.1 Message Flow with Team System

```
┌──────────────────────────────────────────────────────────┐
│              User @mentions bot in channel                │
└──────────────────────────────────────────────────────────┘
                          │
                          ▼
                ┌─────────────────┐
                │ Is user the     │──── Yes ──▶ Process normally
                │ owner?          │             (existing behavior)
                └────────┬────────┘
                         │ No
                         ▼
          ┌──────────────────────────────┐
          │ Is user a TEAM MEMBER?       │──── Yes ──▶ Process normally
          │ (check teamConfig.members)   │             (bypass approval)
          └──────────────┬───────────────┘
                         │ No
                         ▼
                ┌─────────────────┐
                │ Is user in      │──── Yes ──▶ Process normally
                │ thread's        │             (existing behavior)
                │ approvedUsers?  │
                └────────┬────────┘
                         │ No
                         ▼
              Request guest approval
              (existing behavior)
```

### 5.2 Session Creation by Team Members

Team members CAN create new sessions:

```
┌──────────────────────────────────────────────────────────┐
│        Team member @mentions bot in unmapped thread       │
└──────────────────────────────────────────────────────────┘
                          │
                          ▼
                ┌─────────────────┐
                │ Is user a       │──── No ───▶ Existing flow
                │ team member?    │             (ownership confirmation
                └────────┬────────┘              or guest approval)
                         │ Yes
                         ▼
                ┌─────────────────┐
                │ settings.allow  │──── No ───▶ "Team members cannot
                │ MembersToCreate │             create sessions.
                │ Sessions?       │             Ask @owner to start one."
                └────────┬────────┘
                         │ Yes
                         ▼
              Create session directly
              (no ownership confirmation needed)
              Mark: createdByTeamMember = true
```

### 5.3 Interaction with Existing approvedUsers

The two systems are **additive**:

| User Type | In Team? | In approvedUsers? | Result |
|-----------|----------|-------------------|--------|
| Owner | N/A | N/A | Full access |
| Team member | ✅ | ❌ | Full access (team trumps) |
| Team member | ✅ | ✅ | Full access |
| Guest | ❌ | ✅ | Access to that thread only |
| Guest | ❌ | ❌ | Must request approval |

**Key principle:** Team membership is GLOBAL (across all threads), while `approvedUsers` is LOCAL (per-thread).

---

## 6. Persistence

### 6.1 File Storage

**Location:** `~/.config/opencode/mattermost-team.json`

**Format:**
```json
{
  "version": 1,
  "team": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "My Team",
    "createdAt": "2026-01-26T12:00:00.000Z",
    "updatedAt": "2026-01-26T15:30:00.000Z",
    "ownerId": "ibzbp75tzbdc7r8ctnw91j7c6e",
    "members": [
      {
        "userId": "abc123",
        "username": "alice",
        "addedAt": "2026-01-26T12:30:00.000Z",
        "addedBy": "ibzbp75tzbdc7r8ctnw91j7c6e",
        "role": "member"
      }
    ],
    "settings": {
      "allowMembersToCreateSessions": true,
      "allowMembersToApproveGuests": false,
      "syncWithMattermostTeam": false
    }
  }
}
```

### 6.2 New Store Class

```
src/persistence/team-store.ts

TeamStore
├── load(): TeamConfig | null
├── save(config: TeamConfig): void
├── addMember(userId: string, username: string): void
├── removeMember(userId: string): void
├── isMember(userId: string): boolean
├── getMembers(): TeamMember[]
└── updateSettings(settings: Partial<TeamSettings>): void
```

### 6.3 Caching Strategy

**In-Memory Cache:**
```typescript
class TeamStore {
  private cache: {
    members: Set<string>;      // Set of user IDs for O(1) lookup
    lastLoaded: number;        // Timestamp
    ttl: number;               // From config
  };
  
  isMember(userId: string): boolean {
    if (Date.now() - this.cache.lastLoaded > this.cache.ttl) {
      this.reloadFromDisk();
    }
    return this.cache.members.has(userId);
  }
}
```

**Cache invalidation:**
- On any `!team` command that modifies membership
- On file change (if watching is implemented)
- On TTL expiry (default 5 minutes)

---

## 7. Mattermost Team Sync (Optional Feature)

### 7.1 Concept

Instead of manually managing members, sync with an existing Mattermost team:

```
OPENCODE_MM_TEAM_SYNC_MM=true
OPENCODE_MM_TEAM_MM_ID=abc123xyz
```

When enabled:
- `!team` shows members from Mattermost team
- `!team add/remove` disabled ("Team is synced with Mattermost")
- Members auto-update based on MM team membership

### 7.2 Sync Flow

```
┌──────────────────────────────────────────────────────────┐
│                    On Plugin Startup                      │
└──────────────────────────────────────────────────────────┘
                          │
                          ▼
                ┌─────────────────┐
                │ Is MM sync      │──── No ───▶ Load from local file
                │ enabled?        │
                └────────┬────────┘
                         │ Yes
                         ▼
              GET /api/v4/teams/{id}/members
              (paginated, fetch all)
                         │
                         ▼
              Populate in-memory cache
              Subscribe to WebSocket events
```

### 7.3 WebSocket Events

Listen for membership changes:

```typescript
// In websocket handler
case 'added_to_team':
  if (event.data.team_id === config.team.mattermostTeamId) {
    teamStore.addMemberFromSync(event.data.user_id);
  }
  break;

case 'leave_team':
  if (event.data.team_id === config.team.mattermostTeamId) {
    teamStore.removeMemberFromSync(event.data.user_id);
  }
  break;
```

### 7.4 Sync vs Manual Mode

| Aspect | Manual Mode | Sync Mode |
|--------|-------------|-----------|
| Member source | Local JSON file | Mattermost team |
| Add/remove commands | ✅ Enabled | ❌ Disabled |
| Real-time updates | No | Yes (WebSocket) |
| Offline support | Full | Limited (cache) |
| Setup complexity | Low | Medium |

---

## 8. Edge Cases

### 8.1 Owner Changes

**Scenario:** `MATTERMOST_OWNER_USER_ID` is changed in environment.

**Behavior:**
- New owner inherits the existing team
- Old owner becomes a regular user (not even team member)
- Team file's `ownerId` is updated on next `!team` command by new owner

**Alternative:** Require explicit team transfer command (more complex, not recommended for v1).

### 8.2 Team Member Removal Mid-Session

**Scenario:** Owner runs `!team remove @alice` while Alice has an active session thread.

**Behavior:**
- Alice's existing thread mappings remain valid
- Alice can continue in threads where she's the session creator
- Alice cannot start NEW sessions
- Alice cannot interact in threads created by others (unless individually approved)

**Rationale:** Don't disrupt active work, but prevent new access.

### 8.3 Multiple OpenCode Instances

**Scenario:** Multiple owners each running OpenCode with the same bot account.

**Behavior:**
- Each instance has its OWN team file (tied to `MATTERMOST_OWNER_USER_ID`)
- Team membership is per-instance, not global
- If using MM sync, all instances see the same team (recommended for multi-owner setups)

```
Instance A (Owner: @alice)     Instance B (Owner: @bob)
├── team-alice.json            ├── team-bob.json
├── members: [@carol]          ├── members: [@david]
└── @carol can use A           └── @david can use B
    but NOT B                      but NOT A
```

### 8.4 Bot Account in Team

**Scenario:** The bot's own user ID is added to the team.

**Behavior:**
- Silently ignore (bot cannot @mention itself meaningfully)
- `!team add @bot` → "Cannot add the bot to its own team."

### 8.5 Owner Adds Themselves

**Scenario:** Owner runs `!team add @owner`.

**Behavior:**
- Silently ignore (owner already has full access)
- `!team add @yevgeniy` → "You're the owner - you already have full access!"

---

## 9. Migration Path

### 9.1 Upgrade from Pre-Team Version

**Existing deployments:**
1. No team file exists → plugin works exactly as before
2. First `!team add @user` creates the team file
3. No breaking changes

**New deployments:**
1. Same as above
2. Optionally pre-create team file with members

### 9.2 Default Behavior

| Team File State | Behavior |
|-----------------|----------|
| Not exists | Owner-only mode (current behavior) |
| Exists, empty members | Owner-only mode |
| Exists, has members | Team mode (members bypass approval) |

### 9.3 Version Migration

Team file includes `"version": 1` for future schema changes:

```json
{
  "version": 1,
  "team": { ... }
}
```

Future versions can include migration logic:
```typescript
function migrateTeamConfig(data: any): TeamConfig {
  if (data.version === 1) {
    return data.team;
  }
  // Future: migrate from v1 to v2
  throw new Error(`Unknown team config version: ${data.version}`);
}
```

---

## 10. Security Considerations

### 10.1 Trust Model

- Team members are FULLY TRUSTED for bot interactions
- They can see session responses, run commands, access files via bot
- Only add users you trust with your OpenCode instance

### 10.2 Audit Trail

Consider logging team changes:
```
[2026-01-26T12:00:00Z] [TEAM] @yevgeniy added @alice to team
[2026-01-26T14:30:00Z] [TEAM] @yevgeniy removed @bob from team
```

### 10.3 File Permissions

Team file should be readable only by the owner:
```bash
chmod 600 ~/.config/opencode/mattermost-team.json
```

### 10.4 No Elevation Path

Team members CANNOT:
- Add other team members
- Remove team members
- Change team settings
- Transfer ownership

Only the configured `MATTERMOST_OWNER_USER_ID` can manage the team.

---

## 11. Future Enhancements (Out of Scope for v1)

1. **Admin Role**: Team members with `role: "admin"` can also manage team
2. **Per-Thread Permissions**: Fine-grained control over which threads team members can access
3. **Expiring Memberships**: `expiresAt` field for temporary access
4. **Notification Preferences**: Team members can opt-in/out of notifications
5. **Activity Dashboard**: See which team members are active
6. **Slack/Discord Sync**: Support for other chat platforms

---

## 12. Implementation Checklist

When implementing, follow this order:

- [ ] **Phase 1: Core Infrastructure**
  - [ ] Create `src/persistence/team-store.ts`
  - [ ] Add team schema to `src/config.ts`
  - [ ] Add environment variable handling

- [ ] **Phase 2: Permission Integration**
  - [ ] Modify `connect.ts` to check team membership
  - [ ] Update `guest-approval-handler.ts` to bypass for team members
  - [ ] Update `session-ownership-handler.ts` for team member session creation

- [ ] **Phase 3: Commands**
  - [ ] Add `!team` command to `command-handler.ts`
  - [ ] Implement add/remove/list subcommands
  - [ ] Add permission checks

- [ ] **Phase 4: Testing & Documentation**
  - [ ] Unit tests for TeamStore
  - [ ] Integration tests for permission flow
  - [ ] Update README.md with team feature docs

- [ ] **Phase 5 (Optional): Mattermost Sync**
  - [ ] Implement MM team member fetching
  - [ ] Add WebSocket event handlers
  - [ ] Add sync command

---

## 13. Summary

The Team System introduces a middle layer between "owner-only" and "public approval" access:

```
BEFORE:                          AFTER:
┌─────────┐                      ┌─────────┐
│  Owner  │                      │  Owner  │
└────┬────┘                      └────┬────┘
     │                                │
     ▼                                ▼
┌─────────┐                      ┌─────────┐
│ Guests  │ ◄── approval ──►     │  Team   │ ◄── no approval
└─────────┘                      └────┬────┘
                                      │
                                      ▼
                                 ┌─────────┐
                                 │ Guests  │ ◄── approval
                                 └─────────┘
```

**Key benefits:**
- Trusted users work without friction
- Owner retains full control
- Backward compatible
- Simple to configure
- Optional MM team sync for larger organizations
