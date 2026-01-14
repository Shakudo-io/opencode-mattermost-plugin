---
description: Monitor an OpenCode session for events (permission requests, idle, questions). Sends a one-time DM alert when the session needs attention.
---

Use the mattermost_monitor tool to monitor an OpenCode session. When the session triggers a permission request, goes idle, or asks a question, a one-time DM alert will be sent to the specified user.

Arguments (optional):
- sessionId: Session ID to monitor (defaults to current session)
- targetUser: Mattermost username to notify (defaults to command invoker)
