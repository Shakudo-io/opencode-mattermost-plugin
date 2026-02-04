# OpenCode TUI vs Mattermost Plugin UX Comparison

**Generated:** 2026-02-04
**Purpose:** Identify UX feature gaps between the OpenCode TUI and Mattermost plugin

## Executive Summary

The OpenCode TUI has significantly richer output display capabilities due to its React-based terminal UI. The Mattermost plugin is limited to Markdown formatting, emojis, and message splitting. Key gaps include:

- **No diff rendering** in MM (TUI has full syntax-highlighted split/unified diffs)
- **No syntax highlighting** in MM (TUI has Shiki-based highlighting)
- **No expandable/collapsible sections** in MM (TUI has collapsible tool outputs)
- **No visual progress indicators** in MM beyond status emoji (TUI has spinners, progress circles)
- **No image preview** in MM (TUI has modal image preview)
- **Limited bash output display** in MM (TUI shows command + output with expand/collapse)

---

## Detailed Feature Comparison

### 1. Bash/Shell Command Output

| Feature | OpenCode TUI | Mattermost Plugin | Gap |
|---------|-------------|-------------------|-----|
| **Command display** | `$ command` with syntax coloring | Plain text in status | 🔴 No command echo |
| **Output streaming** | Live streaming to terminal | Status shows "tool running" only | 🔴 No live output |
| **Output truncation** | Shows first 10 lines, "Click to expand" | Streams full response to chat | 🟡 Different approach |
| **Exit code display** | Shown in metadata | Not displayed | 🔴 Missing |
| **Working directory** | Shown as "in ~/path" | Not shown | 🔴 Missing |
| **ANSI colors** | Stripped but preserved structure | N/A (plain text) | 🟡 N/A |
| **Long output handling** | Collapsible with 10-line preview | Message splitting at 15K chars | 🟡 Different |

**TUI Implementation:** `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` lines 1624-1687

---

### 2. Diff Display (File Edits)

| Feature | OpenCode TUI | Mattermost Plugin | Gap |
|---------|-------------|-------------------|-----|
| **Diff rendering** | Full unified/split view | ❌ Not displayed | 🔴 **CRITICAL** |
| **Syntax highlighting** | Shiki-based, per-language | ❌ None | 🔴 **CRITICAL** |
| **Line numbers** | Yes, with +/- gutter | ❌ None | 🔴 Missing |
| **Added/removed colors** | Green/red backgrounds | ❌ None | 🔴 Missing |
| **Side-by-side view** | Auto on wide terminals (>120 cols) | ❌ None | 🔴 Missing |
| **Diff wrapping** | Toggle word/none wrap mode | ❌ None | 🔴 Missing |
| **File diff summary** | +X/-Y per file in sidebar | ❌ None | 🔴 Missing |
| **LSP diagnostics** | Shows errors with line:char | ❌ None | 🔴 Missing |

**TUI Implementation:** 
- `packages/ui/src/components/diff.tsx` (613 lines)
- `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` lines 1891-1957 (Edit tool)

**Recommendation:** This is the biggest UX gap. Consider:
1. Generating markdown-formatted diffs (```diff blocks)
2. Attaching diff files for download
3. Using Mattermost's code block formatting with diff language

---

### 3. Code Display & Syntax Highlighting

| Feature | OpenCode TUI | Mattermost Plugin | Gap |
|---------|-------------|-------------------|-----|
| **Syntax highlighting** | Shiki with 100+ languages | Mattermost's built-in (basic) | 🟡 Limited |
| **Line numbers** | Yes, with selection | ❌ None | 🔴 Missing |
| **Find in code** | Ctrl+F with highlight | ❌ None | 🔴 Missing |
| **Copy button** | One-click copy | ❌ None | 🟡 Manual copy |
| **Language detection** | Auto by file extension | Manual in code blocks | 🟡 Different |
| **Line selection** | Click/drag to select ranges | ❌ None | 🔴 Missing |

**TUI Implementation:** `packages/ui/src/components/code.tsx`

---

### 4. File Read Results

| Feature | OpenCode TUI | Mattermost Plugin | Gap |
|---------|-------------|-------------------|-----|
| **Content display** | Syntax-highlighted code block | Plain text in response | 🟡 Basic support |
| **Line numbers** | Yes | ❌ None | 🔴 Missing |
| **Binary detection** | Shows "Binary file" message | Unknown | 🟡 Verify |
| **Image preview** | Inline base64 preview | File attachment | 🟡 Different |
| **PDF handling** | Base64 attachment | File attachment | 🟢 Same |
| **Loaded files tracking** | Shows "↳ Loaded filepath" | ❌ None | 🔴 Missing |

**TUI Implementation:** `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` lines 1745-1770

---

### 5. Search Results (Grep/Glob)

| Feature | OpenCode TUI | Mattermost Plugin | Gap |
|---------|-------------|-------------------|-----|
| **Match count** | "(X matches)" inline | In response text | 🟢 Same |
| **File grouping** | Grouped by file | Grouped by file | 🟢 Same |
| **Line numbers** | Yes, with context | Yes, in output | 🟢 Same |
| **Truncation notice** | Metadata shows truncated | In text | 🟢 Same |
| **Pattern display** | `Grep "pattern"` | In response | 🟢 Same |

---

### 6. Progress & Status Indicators

| Feature | OpenCode TUI | Mattermost Plugin | Gap |
|---------|-------------|-------------------|-----|
| **Spinner animation** | 16-square animated grid | ⏳🔧💻 emoji only | 🔴 Visual gap |
| **Progress circle** | SVG circular progress % | Text percentage | 🔴 Visual gap |
| **Tool name display** | "Running: toolname" | "🔧 Running bash (5s)" | 🟢 Same |
| **Elapsed time** | Seconds counter | Seconds counter | 🟢 Same |
| **Retry status** | Not visible | "🔄 Attempt X/Y - retry in Xs" | 🟢 MM better |
| **Throttled updates** | N/A (live terminal) | 500ms throttle | 🟢 MM has |

**MM Implementation:** `src/status-indicator.ts`

---

### 7. Todo/Task List Display

| Feature | OpenCode TUI | Mattermost Plugin | Gap |
|---------|-------------|-------------------|-----|
| **Progress tracking** | Sidebar shows todos | "📋 Task List (X/Y complete)" | 🟢 Same |
| **Status icons** | Checkbox states | ✅🔄⏳❌ emojis | 🟢 Same |
| **Priority markers** | Not visible | 🔴 high priority only | 🟢 MM has |
| **Collapsible** | Expandable in sidebar | Always visible | 🟡 Different |
| **Strikethrough** | ❌ None | ~~completed items~~ | 🟢 MM better |

**TUI Implementation:** `packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx` lines 205-220

---

### 8. Error Display

| Feature | OpenCode TUI | Mattermost Plugin | Gap |
|---------|-------------|-------------------|-----|
| **Error card** | Red Card component | ❌ Error message text | 🟡 Similar |
| **Title/message split** | Parsed on ": " | In blockquote | 🟡 Similar |
| **LSP diagnostics** | Line:char + severity | ❌ None | 🔴 Missing |
| **Error count limit** | 3 per file max | No limit | 🟡 Different |
| **Retry hint** | ❌ None | "React with 🔁 to retry" | 🟢 MM better |

**TUI Implementation:** `packages/ui/src/components/message-part.tsx` lines 610-626

---

### 9. Thinking/Reasoning Display

| Feature | OpenCode TUI | Mattermost Plugin | Gap |
|---------|-------------|-------------------|-----|
| **Reasoning display** | Dedicated reasoning-part container | ❌ Not displayed | 🔴 **Missing** |
| **Throttled rendering** | 100ms throttle for streaming | N/A | 🔴 N/A |
| **Markdown formatting** | Full markdown support | N/A | 🔴 N/A |

**TUI Implementation:** `packages/ui/src/components/message-part.tsx` lines 710-722

**Note:** The MM plugin does not expose AI reasoning/thinking to users at all.

---

### 10. Cost & Token Display

| Feature | OpenCode TUI | Mattermost Plugin | Gap |
|---------|-------------|-------------------|-----|
| **Token count** | "X tokens" in sidebar | "125K tok" in status | 🟢 Same |
| **Context % used** | "X% used" | ❌ None | 🔴 Missing |
| **Cost display** | "$X.XX spent" | "💰 $0.45 (+$0.03)" | 🟢 Similar |
| **Per-message cost** | Summed from messages | Tracked per session | 🟢 Same |
| **Cost command** | N/A | `!costs` table | 🟢 MM has |

**TUI Implementation:** `packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx` lines 43-61

---

### 11. Question/Prompt Handling

| Feature | OpenCode TUI | Mattermost Plugin | Gap |
|---------|-------------|-------------------|-----|
| **Question display** | Modal overlay | ### ❓ Header formatting | 🟡 Different |
| **Numbered options** | List with numbers | Numbered list | 🟢 Same |
| **Multi-question** | Sequential modals | "Question X/Y" | 🟢 Same |
| **Custom answer** | Text input field | "Type your own answer" option | 🟢 Same |
| **Rejection** | Cancel button | `!reject` command | 🟡 Different |

**MM Implementation:** `src/question-handler.ts`

---

### 12. Permission Requests

| Feature | OpenCode TUI | Mattermost Plugin | Gap |
|---------|-------------|-------------------|-----|
| **Permission overlay** | Full diff + approve/deny UI | Notification DM | 🟡 Different |
| **Diff preview** | Shows exact changes | ❌ None | 🔴 Missing |
| **Approve/deny** | Buttons in UI | ✅❌ reactions | 🟢 Same |
| **Bulk actions** | "Allow all" option | ❌ None | 🔴 Missing |

**TUI Implementation:** `packages/opencode/src/cli/cmd/tui/routes/session/permission.tsx`

---

### 13. Markdown Rendering

| Feature | OpenCode TUI | Mattermost Plugin | Gap |
|---------|-------------|-------------------|-----|
| **Full HTML** | DOMPurify sanitized | Mattermost's parser | 🟢 Same |
| **Math (KaTeX)** | $...$ and $$...$$ | ❌ None | 🔴 Missing |
| **Copy buttons** | Auto on code blocks | ❌ None | 🔴 Missing |
| **Tables** | Full support | Full support | 🟢 Same |
| **Links** | target="_blank" | Native MM handling | 🟢 Same |

---

### 14. Interactive Elements

| Feature | OpenCode TUI | Mattermost Plugin | Gap |
|---------|-------------|-------------------|-----|
| **Collapsible sections** | Accordion/collapsible | ❌ None | 🔴 Missing |
| **Expandable tool output** | Click to expand | ❌ None | 🔴 Missing |
| **Dialogs/modals** | Full dialog support | ❌ None | 🔴 Missing |
| **Tooltips** | Hover tooltips | ❌ None | 🔴 Missing |
| **Keyboard shortcuts** | Full keybind support | ❌ None | 🔴 N/A |

---

### 15. Session Management

| Feature | OpenCode TUI | Mattermost Plugin | Gap |
|---------|-------------|-------------------|-----|
| **Session sidebar** | Full info panel | Thread root post | 🟡 Different |
| **MCP status** | Per-server status dots | ❌ None | 🔴 Missing |
| **LSP status** | Connection indicator | ❌ None | 🔴 Missing |
| **File changes list** | Sidebar diff list | ❌ None | 🔴 Missing |
| **Session sharing** | Share URL in sidebar | ❌ None | 🔴 Missing |

---

## Priority Recommendations

### 🔴 Critical Gaps (High Impact)

1. **Diff rendering** - Users can't see what code changes were made
   - Implement: Markdown diff code blocks (```diff)
   - Consider: File attachments for full diffs

2. **Syntax highlighting for code** - Code blocks lack visual clarity
   - Implement: Use Mattermost's language-tagged code blocks consistently

3. **Reasoning/thinking display** - Users can't see AI thought process
   - Implement: Optional display in collapsible format or separate message

4. **Bash output with command** - Users don't see what command ran
   - Implement: Echo command before output in formatted block

### 🟡 Medium Gaps (Nice to Have)

5. **Context % display** - Users can't gauge conversation length limits
6. **LSP diagnostics** - Errors from edits not surfaced
7. **MCP/LSP status** - Users can't see tool connectivity
8. **Collapsible sections** - Long outputs flood the chat

### 🟢 MM Plugin Advantages

The Mattermost plugin actually has some UX advantages:
- **Retry hints** with reaction emojis
- **Priority markers** on todos
- **Strikethrough** for completed items
- **Cost command** for detailed breakdown
- **Thread-based organization** for conversation context

---

## Implementation Roadmap

### Phase 1: Critical Fixes
1. Add diff display using ```diff code blocks
2. Echo bash commands before output
3. Add syntax language tags to all code blocks

### Phase 2: Enhanced Display
4. Add reasoning/thinking section (opt-in)
5. Surface LSP diagnostics for edit failures
6. Add context % to status display

### Phase 3: Rich Interactions
7. Explore Mattermost plugins/webhooks for richer formatting
8. Consider file attachments for diffs and long outputs
9. Implement collapsible sections if MM supports them

---

## File References

### OpenCode TUI Key Files
- Tool rendering: `/root/gitrepos/opencode-tui/packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`
- Diff component: `/root/gitrepos/opencode-tui/packages/ui/src/components/diff.tsx`
- Code component: `/root/gitrepos/opencode-tui/packages/ui/src/components/code.tsx`
- Sidebar: `/root/gitrepos/opencode-tui/packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx`
- Theme/colors: `/root/gitrepos/opencode-tui/packages/opencode/src/cli/cmd/tui/context/theme.tsx`

### Mattermost Plugin Key Files
- Status indicator: `/root/gitrepos/opencode-mattermost-plugin/src/status-indicator.ts`
- Response streamer: `/root/gitrepos/opencode-mattermost-plugin/src/response-streamer.ts`
- Question handler: `/root/gitrepos/opencode-mattermost-plugin/src/question-handler.ts`
- Todo manager: `/root/gitrepos/opencode-mattermost-plugin/src/todo-manager.ts`
- Command handler: `/root/gitrepos/opencode-mattermost-plugin/src/command-handler.ts`
