# OpenCode TUI vs Mattermost Plugin Parity Report

**Generated:** 2026-02-07
**Context:** Comparison between `opencode-mattermost-plugin` and `opencode` TUI (React/Ink based).

## Executive Summary

The Mattermost plugin has made significant progress in closing the parity gap with the TUI since the last assessment. Critical features like **diff rendering**, **bash command echoing**, and **thinking/reasoning display** have been implemented using Markdown formatting.

However, a fundamental "richness gap" remains due to the platform differences. The TUI utilizes a highly interactive React-based terminal interface, whereas the Mattermost plugin is constrained to linear chat messages.

## Detailed Analysis of "Faded" & Background Elements

### 1. Faded Messages (Inline Tool History)
*   **TUI Behavior**: Renders every tool execution inline as it happens. When a tool completes, its entry (e.g., `~ ls -la`) is styled with `textMuted` (dim/gray), creating a "faded" audit trail that doesn't distract from the main content.
*   **Mattermost Behavior**: Aggregates tool executions into a single summary line at the top/bottom of the message (e.g., `✅ bash, read, ls`). It does **not** show a linear history of every tool call in the chat stream to avoid clutter.
*   **Gap**: Users lose the temporal context of *when* a tool ran relative to the agent's reasoning or text output.
*   **Recommendation**: Consider an option to show a "verbose" mode where tool calls are logged as small, italicized text lines (e.g., `_Ran: ls -la_`) instead of just the summary.

### 2. Background Processes
*   **TUI Behavior**: Likely displays background tasks (via `[BACKGROUND TASK COMPLETED]` messages) as part of the stream. Since these often come from system events, they might be rendered as standard text or within specific blocks.
*   **Mattermost Behavior**: The plugin actively reformats these messages. It detects the `[TUI] <system-reminder>` pattern and converts it to a cleaner checklist format: `✅ bg_id done (1m 23s)`.
*   **Gap**: The MM approach is actually *cleaner* but might hide details the user is used to seeing (like the "Running..." state if the TUI shows that).
*   **Recommendation**: Ensure the "Running" state of background tasks is reflected in the status indicator (e.g., `🔧 Background task running...`) if possible.

### 3. Reasoning / Thinking
*   **TUI Behavior**: Renders reasoning blocks with `textMuted` (faded) style.
*   **Mattermost Behavior**: Renders reasoning as `_Thinking:_` blocks at the bottom of the message.
*   **Gap**: Functional parity is achieved, though visual style differs.

## Status of Previously Identified "Critical Gaps"

| Feature | Previous Status | Current Status | Notes |
|---------|-----------------|----------------|-------|
| **Diff Rendering** | ❌ Missing | ✅ **Implemented** | Uses markdown ` ```diff ` blocks. |
| **Bash Command Echo** | ❌ Missing | ✅ **Implemented** | Echoes `$ command` before output. |
| **Thinking Display** | ❌ Missing | ✅ **Implemented** | Shows as `_Thinking:_ ...` block. |

## Remaining Feature Gaps

### 1. Interactive & Visual Elements (High Impact)
*   **Collapsible Sections**: TUI collapses long outputs; MM splits them.
*   **Spinners & Progress**: TUI has real-time animations; MM uses static updates.
*   **Modal Dialogs**: TUI uses modals for History, Rename, etc.; MM uses slash commands.

### 2. Code & Diff Capabilities (Medium Impact)
*   **LSP Diagnostics**: TUI shows error underlines; MM does not parse/show these.
*   **In-Code Search**: TUI supports `Ctrl+F` in code blocks.

### 3. Session Management (Medium Impact)
*   **Sidebar**: TUI has a persistent sidebar for session info/todos. MM relies on `!sessions` / `!status`.

## Recommendations for Mattermost Plugin

1.  **"Verbose" Mode**: Add a config option or command to show linear tool history (faded/italicized) for users who want the TUI-like audit trail.
2.  **LSP Visibility**: Parse tool outputs for LSP errors and format them explicitly (e.g., "⚠️ **Error in line 15:** ...").
3.  **Slash Command Discoverability**: Ensure `!help` clearly lists management commands to compensate for the lack of a sidebar.

## Conclusion

The Mattermost plugin has achieved **informational parity** for critical workflows. The "faded messages" difference is a design choice (aggregation vs. linear history) to adapt to the chat medium. Adding a "verbose" mode would bridge this specific gap for users who prefer the linear TUI style.
