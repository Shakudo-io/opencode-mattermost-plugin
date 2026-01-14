---
description: Monitor an OpenCode session for events (permission requests, idle, questions). Sends DM alerts when the session needs attention.
---

Use the mattermost_monitor tool to monitor an OpenCode session. When the session triggers a permission request, goes idle, or asks a question, a DM alert will be sent to the specified user.

Arguments (optional):
- sessionId: Session ID to monitor (defaults to current session)
- targetUser: Mattermost username to notify (defaults to command invoker)
- persistent: Keep monitoring after each alert (default: true). Set to false for one-time alerts.

Use mattermost_unmonitor to stop monitoring.
