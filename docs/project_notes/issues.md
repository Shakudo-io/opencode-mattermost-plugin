# Work Log

## 2026-01-20: Group DM support (v0.3.3)

**Description:** Added support for group DMs - bot can now respond in group DMs containing owner + bot + other users. Threads are scoped per-channel.

**Changes:**
- Accept channel type "G" (group DM) in addition to "D" (1:1 DM)
- Add `channelId` to ThreadSessionMapping
- Filter `!sessions` by current channel
- Validate owner is member of group DM before responding

---

## 2026-01-18: mmClient closure timing fix (v0.3.2)

**Description:** Fixed crash on disconnect due to accessing closed mmClient.

---

## 2026-01-14: Thread-per-session architecture (v0.3.0)

**Description:** Major refactor from monolithic 1,826-line file to modular architecture with automatic thread-per-session.

---
