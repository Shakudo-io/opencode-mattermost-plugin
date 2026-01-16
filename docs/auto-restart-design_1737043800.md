# Auto-Restart Design for opencode-shared Script

**Created:** 2025-01-16  
**Status:** Design (Not Implemented)  
**Author:** OpenCode Agent

## Overview

Design an auto-restart mechanism for the `opencode-shared` script that automatically restarts the OpenCode server if it crashes, while ensuring the TUI client reconnects gracefully.

## Current Behavior

The `opencode-shared` script currently:
1. Checks if a server is running (`is_server_running()`)
2. Starts server with `nohup opencode serve --port $PORT` if not running
3. Saves PID to `/tmp/opencode-server.pid`
4. Waits for server to be ready (port listening)
5. Attaches TUI with `exec opencode attach $SERVER_URL "$@"`

**Problem:** Once `exec` replaces the shell, there's no monitoring. If the server crashes, the TUI will disconnect and the user must manually restart.

## Requirements

1. **Crash Detection** - Detect when the server process dies unexpectedly
2. **Auto-Restart** - Automatically restart the server without user intervention
3. **Backoff Strategy** - Prevent rapid crash loops with exponential backoff
4. **TUI Reconnection** - The attached TUI should reconnect after restart
5. **Logging** - Log restart events for debugging
6. **Graceful Exit** - Allow clean shutdown without restart (e.g., user-initiated stop)

## Design Options

### Option A: Background Monitor Process

Run a separate monitor loop that watches the server and restarts if needed.

```bash
# Start monitor in background before attaching TUI
monitor_server &
exec opencode attach ...
```

**Pros:**
- Simple implementation
- Monitor survives TUI exit

**Cons:**
- Monitor process orphaned if script killed
- No coordination with TUI

### Option B: Wrapper Script with TRAP

Use signal traps and a wrapper approach that monitors the server from the TUI's parent process.

**Cons:**
- `exec` replaces the process, so traps won't work after attach

### Option C: Replace `exec` with Background TUI + Wait Loop (Recommended)

Instead of `exec opencode attach`, run the TUI in foreground while a monitor runs in background. Use job control to manage both.

**Architecture:**
```
opencode-shared (main process)
├── opencode serve (background, monitored)
└── opencode attach (foreground, user interactive)
    └── monitor_loop (background, restarts server)
```

## Recommended Design (Option C)

### High-Level Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    opencode-shared                          │
├─────────────────────────────────────────────────────────────┤
│  1. Check if server running                                 │
│  2. Start server if needed                                  │
│  3. Start monitor loop in background                        │
│  4. Run TUI in foreground (NOT exec)                        │
│  5. When TUI exits, cleanup monitor                         │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                    Monitor Loop                              │
├─────────────────────────────────────────────────────────────┤
│  while true:                                                │
│    sleep INTERVAL                                           │
│    if server_dead AND not graceful_shutdown:                │
│      log "Server crashed, restarting..."                    │
│      if crash_count > MAX in TIME_WINDOW:                   │
│        log "Too many crashes, backing off..."               │
│        sleep backoff_time                                   │
│      restart_server()                                       │
│      crash_count++                                          │
└─────────────────────────────────────────────────────────────┘
```

### Configuration

```bash
# New environment variables
OPENCODE_AUTO_RESTART="${OPENCODE_AUTO_RESTART:-true}"         # Enable auto-restart
OPENCODE_RESTART_MAX_ATTEMPTS="${OPENCODE_RESTART_MAX_ATTEMPTS:-5}"  # Max restarts before backoff
OPENCODE_RESTART_WINDOW="${OPENCODE_RESTART_WINDOW:-300}"       # Time window for crash counting (seconds)
OPENCODE_RESTART_BACKOFF_BASE="${OPENCODE_RESTART_BACKOFF_BASE:-10}" # Base backoff time (seconds)
OPENCODE_RESTART_BACKOFF_MAX="${OPENCODE_RESTART_BACKOFF_MAX:-300}"  # Max backoff time (seconds)
OPENCODE_MONITOR_INTERVAL="${OPENCODE_MONITOR_INTERVAL:-5}"     # Health check interval (seconds)
```

### State Files

```bash
# Existing
PIDFILE="/tmp/opencode-server.pid"
LOG_FILE="/tmp/opencode-server.log"

# New
MONITOR_PIDFILE="/tmp/opencode-monitor.pid"
CRASH_LOG="/tmp/opencode-server-crashes.log"
GRACEFUL_SHUTDOWN_FLAG="/tmp/opencode-server-shutdown"
```

### Pseudocode

```bash
#!/usr/bin/env bash

# ... existing configuration ...

# New configuration
AUTO_RESTART="${OPENCODE_AUTO_RESTART:-true}"
MAX_RESTART_ATTEMPTS="${OPENCODE_RESTART_MAX_ATTEMPTS:-5}"
RESTART_WINDOW="${OPENCODE_RESTART_WINDOW:-300}"
BACKOFF_BASE="${OPENCODE_RESTART_BACKOFF_BASE:-10}"
BACKOFF_MAX="${OPENCODE_RESTART_BACKOFF_MAX:-300}"
MONITOR_INTERVAL="${OPENCODE_MONITOR_INTERVAL:-5}"

MONITOR_PIDFILE="/tmp/opencode-monitor.pid"
CRASH_LOG="/tmp/opencode-server-crashes.log"
SHUTDOWN_FLAG="/tmp/opencode-server-shutdown"

# Track restart attempts with timestamps
declare -a CRASH_TIMES=()

# Calculate backoff time based on recent crash count
calculate_backoff() {
    local crash_count=$1
    local backoff=$((BACKOFF_BASE * (2 ** (crash_count - 1))))
    if [ $backoff -gt $BACKOFF_MAX ]; then
        backoff=$BACKOFF_MAX
    fi
    echo $backoff
}

# Count crashes within the time window
count_recent_crashes() {
    local now=$(date +%s)
    local count=0
    local new_times=()
    
    for timestamp in "${CRASH_TIMES[@]}"; do
        if [ $((now - timestamp)) -lt $RESTART_WINDOW ]; then
            new_times+=("$timestamp")
            count=$((count + 1))
        fi
    done
    
    CRASH_TIMES=("${new_times[@]}")
    echo $count
}

# Record a crash event
record_crash() {
    local now=$(date +%s)
    CRASH_TIMES+=("$now")
    echo "$(date -Iseconds) - Server crashed (PID: $(cat $PIDFILE 2>/dev/null || echo 'unknown'))" >> "$CRASH_LOG"
}

# Check if this is a graceful shutdown
is_graceful_shutdown() {
    [ -f "$SHUTDOWN_FLAG" ]
}

# Mark shutdown as graceful
mark_graceful_shutdown() {
    touch "$SHUTDOWN_FLAG"
}

# Clear graceful shutdown flag
clear_shutdown_flag() {
    rm -f "$SHUTDOWN_FLAG"
}

# Monitor loop - runs in background
monitor_server() {
    echo $$ > "$MONITOR_PIDFILE"
    
    while true; do
        sleep "$MONITOR_INTERVAL"
        
        # Check if we should exit
        if [ ! -f "$MONITOR_PIDFILE" ] || [ "$(cat $MONITOR_PIDFILE)" != "$$" ]; then
            exit 0
        fi
        
        # Check server health
        if ! is_server_running; then
            # Server is down
            if is_graceful_shutdown; then
                echo "$(date -Iseconds) - Graceful shutdown detected, not restarting" >> "$LOG_FILE"
                exit 0
            fi
            
            record_crash
            local crash_count=$(count_recent_crashes)
            
            echo "$(date -Iseconds) - Server crash detected ($crash_count in last ${RESTART_WINDOW}s)" >> "$LOG_FILE"
            
            if [ $crash_count -ge $MAX_RESTART_ATTEMPTS ]; then
                local backoff=$(calculate_backoff $crash_count)
                echo "$(date -Iseconds) - Too many crashes, backing off for ${backoff}s" >> "$LOG_FILE"
                sleep $backoff
            fi
            
            echo "$(date -Iseconds) - Restarting server..." >> "$LOG_FILE"
            clear_shutdown_flag
            start_server
        fi
    done
}

# Stop the monitor
stop_monitor() {
    if [ -f "$MONITOR_PIDFILE" ]; then
        local monitor_pid=$(cat "$MONITOR_PIDFILE")
        if kill -0 "$monitor_pid" 2>/dev/null; then
            kill "$monitor_pid" 2>/dev/null || true
        fi
        rm -f "$MONITOR_PIDFILE"
    fi
}

# Cleanup on exit
cleanup() {
    mark_graceful_shutdown
    stop_monitor
}

# Enhanced main function
main() {
    # Setup cleanup trap
    trap cleanup EXIT INT TERM
    
    # Clear any stale shutdown flag
    clear_shutdown_flag
    
    if is_server_running; then
        echo "Connecting to existing OpenCode server at ${SERVER_URL}"
    else
        start_server
    fi
    
    # Start monitor in background if auto-restart enabled
    if [ "$AUTO_RESTART" = "true" ]; then
        echo "Starting server monitor (auto-restart enabled)"
        monitor_server &
    fi
    
    # Run TUI in foreground (NOT exec, so cleanup runs after)
    opencode attach "$SERVER_URL" "$@"
    local exit_code=$?
    
    # Cleanup happens via trap
    exit $exit_code
}

main "$@"
```

### Key Implementation Details

#### 1. Crash Detection

The OpenCode server provides a dedicated health endpoint:

```bash
# Primary health check - GET /global/health
# Returns: { "healthy": true, "version": "x.y.z" }
curl -s http://localhost:4096/global/health

# Additional status endpoints:
# - GET /session/status - Session execution states
# - GET /mcp - MCP server connection status
# - GET /lsp - LSP instance status
```

The server also emits heartbeats every **30 seconds** on SSE streams (`/global/event` and `/event`).

```bash
is_server_running() {
    # Check PID file exists
    # Check process is alive (kill -0)
    # Check health endpoint responds (preferred over port check)
    # All three must pass
}

is_server_healthy() {
    # More thorough check using the health endpoint
    local response
    response=$(curl -s --connect-timeout 2 --max-time 5 "${SERVER_URL}/global/health" 2>/dev/null)
    if [ $? -eq 0 ] && echo "$response" | grep -q '"healthy":true'; then
        return 0
    fi
    return 1
}
```

#### 2. Exponential Backoff

| Crash # | Backoff Time |
|---------|--------------|
| 1       | 0s (immediate restart) |
| 2       | 10s |
| 3       | 20s |
| 4       | 40s |
| 5       | 80s |
| 6+      | 160s → 300s (capped) |

After `RESTART_WINDOW` (300s) with no crashes, the counter resets.

#### 3. Graceful vs. Crash Shutdown

- **Graceful:** User presses Ctrl+C, runs `stop` command, or script exits normally
  - Sets `SHUTDOWN_FLAG` before stopping
  - Monitor sees flag and exits without restart
  
- **Crash:** Server dies unexpectedly
  - No flag set
  - Monitor restarts the server

#### 4. TUI Reconnection

The `opencode attach` command has built-in reconnection logic. When the server restarts:
1. TUI detects connection lost
2. TUI attempts reconnection with backoff
3. Once server is back up, TUI reconnects automatically

No special handling needed in the script - OpenCode handles this natively.

### Logging

All restart events logged to `/tmp/opencode-server.log`:

```
2025-01-16T10:30:45+00:00 - Server crash detected (1 in last 300s)
2025-01-16T10:30:45+00:00 - Restarting server...
2025-01-16T10:30:46+00:00 - Server started (PID: 12345)
```

Crash history in `/tmp/opencode-server-crashes.log`:

```
2025-01-16T10:30:45+00:00 - Server crashed (PID: 12340)
2025-01-16T10:35:22+00:00 - Server crashed (PID: 12345)
```

### Edge Cases

1. **Monitor dies:** TUI continues working, but no auto-restart. User must restart script.

2. **Server hangs (not dead):** Current `is_server_running` checks port responsiveness. If server hangs but port is still bound, it won't restart. Could add HTTP health check with timeout.

3. **Multiple instances:** PID files prevent multiple instances. Only one monitor per server.

4. **Disk full:** If log files can't be written, monitor continues but silently. Could add fallback to stderr.

5. **Server never starts:** `start_server` has 15s timeout. If exceeded, script exits with error. Monitor doesn't retry failed initial starts.

### Future Enhancements

1. **Health endpoint check:** Add HTTP health check to detect hung servers
2. **Notification on crash:** Send alert (e.g., desktop notification) when server crashes
3. **Metrics:** Track crash frequency, uptime statistics
4. **Systemd integration:** Alternative implementation as systemd service with restart policy

## Testing Plan

1. **Normal operation:** Start script, verify TUI connects, exit cleanly
2. **Crash recovery:** Kill server process (`kill -9 $(cat /tmp/opencode-server.pid)`), verify restart
3. **Rapid crashes:** Crash server multiple times, verify backoff kicks in
4. **Graceful shutdown:** Ctrl+C, verify no restart attempt
5. **Monitor death:** Kill monitor, crash server, verify no restart (expected)
6. **TUI reconnection:** Restart server manually, verify TUI reconnects

## Conclusion

The recommended approach (Option C) provides:
- Automatic crash detection and restart
- Exponential backoff to prevent crash loops
- Clean distinction between graceful and crash shutdowns
- Minimal changes to existing script structure
- Leverages OpenCode's built-in TUI reconnection

Implementation effort: ~2 hours
