<!--
==========================================================================
SYNC IMPACT REPORT
==========================================================================
Version change: 1.0.0 -> 1.1.0
Modified principles:
  - I. TUI Development & Testing: Added tmux interactive testing section
Added sections:
  - tmux Interactive Testing (under TUI Development & Testing)
  - Reference: ANSI Escape Sequences for Keyboard Input
Removed sections: None
Templates requiring updates:
  - .specify/templates/plan-template.md - no changes needed
  - .specify/templates/spec-template.md - no changes needed
  - .specify/templates/tasks-template.md - no changes needed
  - .specify/templates/checklist-template.md - no changes needed
Follow-up TODOs: None
==========================================================================
-->

# Business-Automation Constitution

## Core Principles

### I. TUI Development & Testing (NON-NEGOTIABLE)

All Terminal User Interface (TUI) development MUST follow these rules:

1. **Technology Stack**
   - TUI development MUST use the [Ink](https://github.com/vadimdemedes/ink) library for
     building React-based terminal interfaces
   - TUI testing MUST use [ink-testing-library](https://github.com/vadimdemedes/ink-testing-library)
     for component and interaction testing

2. **E2E Test Requirement**
   - All TUI user flows MUST have working end-to-end tests before being considered done
   - A TUI feature is NOT complete until its E2E tests pass
   - Tests MUST verify actual user interactions, not just rendered output

3. **Test Coverage Expectations**
   - Every distinct user journey through the TUI MUST have at least one E2E test
   - Error states and edge cases in TUI flows MUST be tested
   - Keyboard navigation and input handling MUST be tested where applicable

4. **tmux Interactive Testing**
   - For manual verification or integration testing of Ink TUI applications, use tmux
     with ANSI escape sequences for keyboard input
   - Arrow keys and special keys MUST be sent using escape sequences, not key names
   - Send one key at a time with small delays between inputs for reliable behavior

**Rationale**: TUI applications have complex interaction patterns that are difficult to
manually verify. Automated E2E tests ensure user flows work correctly and prevent
regressions as the interface evolves.

## tmux TUI Testing Guide

### Overview

When testing Ink-based TUI applications interactively via tmux, standard key names
(like `Down`, `Up`) do NOT work. You MUST use ANSI escape sequences.

### Setup

```bash
# Create a tmux session for TUI testing
tmux new-session -d -s tui-test -x 120 -y 30

# Start the TUI application
tmux send-keys -t tui-test "npm start" Enter

# Wait for application to load (adjust as needed)
sleep 3

# Capture current screen
tmux capture-pane -t tui-test -p
```

### Keyboard Input Reference

| Key | Escape Sequence | tmux Command |
|-----|-----------------|--------------|
| Down Arrow | `\x1b[B` | `tmux send-keys -t session $'\x1b[B'` |
| Up Arrow | `\x1b[A` | `tmux send-keys -t session $'\x1b[A'` |
| Right Arrow | `\x1b[C` | `tmux send-keys -t session $'\x1b[C'` |
| Left Arrow | `\x1b[D` | `tmux send-keys -t session $'\x1b[D'` |
| Enter | N/A | `tmux send-keys -t session Enter` |
| Escape | `\x1b` | `tmux send-keys -t session $'\x1b'` |
| Tab | N/A | `tmux send-keys -t session Tab` |
| Space | N/A | `tmux send-keys -t session Space` |
| Backspace | N/A | `tmux send-keys -t session BSpace` |

### Example: Navigate Menu and Select Option

```bash
# Start TUI session
tmux kill-session -t tui-test 2>/dev/null
tmux new-session -d -s tui-test -x 120 -y 30
tmux send-keys -t tui-test "cd /path/to/tui && npm start" Enter
sleep 4

# Verify TUI loaded
tmux capture-pane -t tui-test -p | head -20

# Navigate down in menu (send one key at a time with delays)
tmux send-keys -t tui-test $'\x1b[B'  # Down
sleep 0.3
tmux send-keys -t tui-test $'\x1b[B'  # Down again
sleep 0.3

# Verify cursor position changed
tmux capture-pane -t tui-test -p | grep ">"

# Select current option
tmux send-keys -t tui-test Enter
sleep 0.5

# Verify screen changed
tmux capture-pane -t tui-test -p

# Clean up
tmux kill-session -t tui-test
```

### Best Practices

1. **One key at a time**: Do NOT chain multiple escape sequences in a single command.
   Send each key separately with small delays.

   ```bash
   # CORRECT: Separate commands with delays
   tmux send-keys -t session $'\x1b[B'
   sleep 0.2
   tmux send-keys -t session $'\x1b[B'
   sleep 0.2
   tmux send-keys -t session Enter

   # INCORRECT: Multiple keys in one command (unreliable)
   tmux send-keys -t session $'\x1b[B' $'\x1b[B' Enter
   ```

2. **Wait for rendering**: After sending input, wait for the TUI to re-render before
   capturing the screen or sending more input.

3. **Use capture-pane for verification**: Always verify state changes with
   `tmux capture-pane -t session -p`.

4. **Clean up sessions**: Kill tmux sessions after testing to avoid resource leaks.

### Debugging Tips

- If navigation doesn't work, verify the TUI is focused and ready
- Check that the session dimensions (-x, -y) are large enough for the TUI
- Use `tmux capture-pane -t session -p` frequently to see current state
- For text input, use `tmux send-keys -t session "your text"` (quotes included)

## Technology Stack

| Component | Technology | Notes |
|-----------|------------|-------|
| TUI Framework | Ink (React for CLI) | Required for all terminal interfaces |
| TUI Testing | ink-testing-library | Required for all TUI tests |
| TUI Manual Testing | tmux + ANSI escape sequences | For interactive verification |
| Runtime | Bun | Preferred over npm/pnpm |
| Package Manager | Bun | Use bunx for executing packages |

## Development Workflow

### Definition of Done (TUI Features)

A TUI feature is considered **done** when:

1. Implementation complete and functional
2. All user flows have passing E2E tests using ink-testing-library
3. Tests verify actual user interactions (keyboard input, selections, navigation)
4. Code passes linting and type checks
5. Code review complete (if applicable)

### Test-First Approach

For TUI development:

1. Define user flows to be supported
2. Write E2E tests for those flows (tests should fail initially)
3. Implement the TUI components
4. Verify all tests pass
5. Refactor if needed while keeping tests green

## Governance

This constitution supersedes all other development practices for this repository.

### Amendment Process

1. Amendments MUST be documented with rationale
2. Amendments MUST include migration plan for existing code (if breaking)
3. All team members MUST be notified of constitution changes
4. Version number MUST be updated according to semantic versioning:
   - MAJOR: Backward incompatible principle removals or redefinitions
   - MINOR: New principles added or material guidance expansion
   - PATCH: Clarifications, wording fixes, non-semantic refinements

### Compliance

- All PRs/code reviews MUST verify compliance with these principles
- TUI features without E2E tests MUST NOT be merged
- Exceptions require explicit documentation and approval

**Version**: 1.1.0 | **Ratified**: 2026-01-08 | **Last Amended**: 2026-01-08
