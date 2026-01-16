# Contract: Persistence Format

**Feature**: 001-thread-per-session  
**Contract ID**: C-003  
**Date**: 2026-01-15

## Overview

Defines the file format and operations for persisting thread-session mappings to disk.

## File Location

```
Primary:   ~/.config/opencode/mattermost-threads.json
Fallback:  ~/.opencode/mattermost-threads.json
```

Resolution order:
1. If `~/.config/opencode/` exists, use primary
2. Else if `~/.opencode/` exists, use fallback
3. Else create `~/.config/opencode/` and use primary

## File Schema

### Version 1

```typescript
interface ThreadMappingFileV1 {
  /** Schema version - always 1 */
  version: 1;
  
  /** Array of thread mappings */
  mappings: ThreadSessionMapping[];
  
  /** ISO timestamp of last modification */
  lastModified: string;
}

interface ThreadSessionMapping {
  sessionId: string;
  threadRootPostId: string;
  shortId: string;
  mattermostUserId: string;
  dmChannelId: string;
  projectName: string;
  directory: string;
  sessionTitle?: string;
  status: "active" | "ended" | "disconnected" | "orphaned";
  createdAt: string;
  lastActivityAt: string;
  endedAt?: string;
}
```

### Zod Schema

```typescript
import { z } from "zod";

const ThreadSessionMappingSchema = z.object({
  sessionId: z.string().min(1),
  threadRootPostId: z.string().min(1),
  shortId: z.string().min(6).max(10),
  mattermostUserId: z.string().min(1),
  dmChannelId: z.string().min(1),
  projectName: z.string().min(1),
  directory: z.string().min(1),
  sessionTitle: z.string().optional(),
  status: z.enum(["active", "ended", "disconnected", "orphaned"]),
  createdAt: z.string().datetime(),
  lastActivityAt: z.string().datetime(),
  endedAt: z.string().datetime().optional(),
});

const ThreadMappingFileSchema = z.object({
  version: z.literal(1),
  mappings: z.array(ThreadSessionMappingSchema),
  lastModified: z.string().datetime(),
});
```

## Operations

### load()

```typescript
/**
 * Load mappings from disk.
 * Creates empty file if not exists.
 * Validates schema and filters invalid entries.
 * 
 * @returns Array of valid mappings
 */
async function load(): Promise<ThreadSessionMapping[]>;
```

**Behavior**:
1. Check file exists
2. If not exists, return empty array
3. Read file contents
4. Parse JSON
5. Validate against schema
6. Filter out invalid mappings (log warnings)
7. Return valid mappings

**Error Handling**:
- File not found → Return empty array
- Invalid JSON → Log error, return empty array
- Schema validation fails → Filter invalid, return valid

### save()

```typescript
/**
 * Save mappings to disk atomically.
 * Uses write-to-temp then rename pattern.
 * 
 * @param mappings - Array of mappings to persist
 */
async function save(mappings: ThreadSessionMapping[]): Promise<void>;
```

**Behavior**:
1. Create file structure with version and timestamp
2. Write to temporary file (same directory)
3. Rename temp file to target (atomic on POSIX)
4. Handle errors gracefully

**Atomic Write Pattern**:
```typescript
const tempPath = `${filePath}.tmp.${Date.now()}`;
await fs.writeFile(tempPath, JSON.stringify(data, null, 2));
await fs.rename(tempPath, filePath);
```

### merge()

```typescript
/**
 * Merge in-memory mappings with disk mappings.
 * Used when multiple OpenCode instances run simultaneously.
 * 
 * @param memoryMappings - Current in-memory mappings
 * @param diskMappings - Mappings loaded from disk
 * @returns Merged mappings with conflicts resolved
 */
function merge(
  memoryMappings: ThreadSessionMapping[],
  diskMappings: ThreadSessionMapping[]
): ThreadSessionMapping[];
```

**Merge Rules**:
1. By sessionId: memory wins (fresher state)
2. New in disk: add to result
3. In memory only: keep
4. Conflict resolution: prefer higher lastActivityAt

## Example File

```json
{
  "version": 1,
  "mappings": [
    {
      "sessionId": "ses_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
      "threadRootPostId": "post_x1y2z3a4b5c6d7e8",
      "shortId": "ses_a1b2",
      "mattermostUserId": "user_abc123def456",
      "dmChannelId": "channel_ghi789jkl012",
      "projectName": "business-automation",
      "directory": "/root/gitrepos/business-automation",
      "sessionTitle": "Thread per session implementation",
      "status": "active",
      "createdAt": "2026-01-15T14:30:00.000Z",
      "lastActivityAt": "2026-01-15T15:45:00.000Z"
    },
    {
      "sessionId": "ses_q9w8e7r6t5y4u3i2o1p0a9s8d7f6g5h4",
      "threadRootPostId": "post_m1n2o3p4q5r6s7t8",
      "shortId": "ses_q9w8",
      "mattermostUserId": "user_abc123def456",
      "dmChannelId": "channel_ghi789jkl012",
      "projectName": "opencode-plugin",
      "directory": "/root/gitrepos/opencode-mattermost-plugin-public",
      "status": "ended",
      "createdAt": "2026-01-15T10:00:00.000Z",
      "lastActivityAt": "2026-01-15T12:30:00.000Z",
      "endedAt": "2026-01-15T12:30:00.000Z"
    }
  ],
  "lastModified": "2026-01-15T15:45:00.000Z"
}
```

## Migration Support

### Future Versions

When schema changes:
1. Increment version number
2. Add migration function: `migrateV1toV2()`
3. On load, check version and migrate if needed
4. Save migrated data

```typescript
async function load(): Promise<ThreadSessionMapping[]> {
  const raw = await readFile();
  
  if (raw.version === 1) {
    // Current version, no migration
    return raw.mappings;
  }
  
  // Future: handle migrations
  // if (raw.version === 2) { ... }
  
  throw new Error(`Unknown schema version: ${raw.version}`);
}
```

## Test Cases

### TC-001: Load from empty/missing file

**Given**: File does not exist  
**When**: load() called  
**Then**: Returns empty array, no error

### TC-002: Load valid file

**Given**: Valid JSON file with 2 mappings  
**When**: load() called  
**Then**: Returns array of 2 ThreadSessionMapping objects

### TC-003: Load file with invalid mapping

**Given**: File with 3 mappings, 1 invalid (missing sessionId)  
**When**: load() called  
**Then**: Returns 2 valid mappings, logs warning for invalid

### TC-004: Save atomically

**Given**: Array of mappings  
**When**: save() called, power cut during write  
**Then**: Either old file intact OR new file complete (no partial)

### TC-005: Merge concurrent updates

**Given**: Memory has mapping A (updated 15:00), disk has A (updated 14:00)  
**When**: merge() called  
**Then**: Result has memory version of A (fresher)

### TC-006: Merge new entries from disk

**Given**: Memory has mapping A, disk has A and B  
**When**: merge() called  
**Then**: Result has both A (from memory) and B (from disk)
