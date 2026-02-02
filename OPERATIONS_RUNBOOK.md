# Kaji Operations Runbook

**Version**: 0.3.45  
**Last Updated**: 2026-02-02  
**Audience**: Operations, DevOps, On-Call Engineers

Quick reference guide for common operational tasks and incident response.

---

## Quick Reference

### Health Check (30 seconds)

```bash
# 1. Server running?
curl -s http://localhost:4096/ && echo "✓ Server" || echo "✗ Server DOWN"

# 2. Plugin connected?
grep -q "Connected to Mattermost" /tmp/opencode-mattermost-plugin.log && echo "✓ Connected" || echo "✗ Not connected"

# 3. Recent errors?
grep "ERROR" /tmp/opencode-mattermost-plugin.log | tail -3
```

### Common Commands

| Task | Command |
|------|---------|
| View logs | `tail -f /tmp/opencode-mattermost-plugin.log` |
| Check sessions | `grep "Session created" /tmp/opencode-mattermost-plugin.log \| wc -l` |
| Restart | `pkill -f opencode; sleep 2; opencode` |
| Check memory | `ps aux \| grep opencode` |
| Backup mappings | `cp ~/.config/opencode/thread-mappings.json /backups/$(date +%s).json` |

---

## Incident Response

### Incident: Bot Not Responding

**Symptoms**: Bot appears online but doesn't respond to DMs

**Diagnosis** (2 min):
```bash
# 1. Check if server is running
curl -s http://localhost:4096/ || echo "Server down"

# 2. Check plugin connection
grep "Connected to Mattermost" /tmp/opencode-mattermost-plugin.log | tail -1

# 3. Check for auth errors
grep "401\|Unauthorized" /tmp/opencode-mattermost-plugin.log | tail -5

# 4. Check owner filtering
grep "Ignoring 1:1 DM from non-owner" /tmp/opencode-mattermost-plugin.log | tail -3
```

**Resolution** (5 min):
```bash
# If server is down:
pkill -f opencode
sleep 2
opencode &

# If auth error:
# Verify MATTERMOST_TOKEN is correct
echo $MATTERMOST_TOKEN

# If owner filtering issue:
# Check configured owner ID matches user ID
echo $MATTERMOST_OWNER_USER_ID
```

**Escalation**: If still not responding after 5 min, check Mattermost server health

---

### Incident: High Memory Usage

**Symptoms**: OpenCode process consuming >1GB RAM

**Diagnosis** (1 min):
```bash
# Check memory
ps aux | grep opencode | grep -v grep

# Check for memory leaks
grep -i "memory\|leak" /tmp/opencode-mattermost-plugin.log
```

**Resolution** (5 min):
```bash
# Option 1: Restart (quick fix)
pkill -f opencode
sleep 2
opencode &

# Option 2: Reduce session limits
export OPENCODE_MM_MAX_SESSIONS="20"  # was 50
export OPENCODE_MM_SESSION_TIMEOUT="1800000"  # 30 min, was 1 hour

# Option 3: Clear old thread mappings
# Backup first
cp ~/.config/opencode/thread-mappings.json ~/.config/opencode/thread-mappings.json.backup

# Remove old entries (older than 7 days)
# Manual edit of thread-mappings.json to remove old sessions
```

---

### Incident: WebSocket Disconnects

**Symptoms**: Frequent "WebSocket reconnecting..." messages in logs

**Diagnosis** (2 min):
```bash
# Check network connectivity
curl -v "wss://your-mattermost.com/api/v4/websocket" \
  -H "Authorization: Bearer $MATTERMOST_TOKEN" 2>&1 | head -20

# Check firewall
netstat -an | grep 4096

# Check Mattermost server
curl -s https://your-mattermost.com/api/v4/system/ping
```

**Resolution** (5 min):
```bash
# If network issue:
# Contact network team, check firewall rules

# If Mattermost issue:
# Wait for Mattermost to recover, or restart OpenCode

# Increase reconnect interval
export MATTERMOST_RECONNECT_INTERVAL="10000"  # 10 sec, was 5 sec
export MATTERMOST_MAX_RECONNECT_ATTEMPTS="20"  # was 10

# Restart
pkill -f opencode
sleep 2
opencode &
```

---

### Incident: Messages Not Appearing

**Symptoms**: Prompts sent but no response in thread

**Diagnosis** (3 min):
```bash
# Check if session exists
grep "Session created" /tmp/opencode-mattermost-plugin.log | tail -5

# Check if thread was created
grep "Thread created" /tmp/opencode-mattermost-plugin.log | tail -5

# Check message routing
grep "Processing DM" /tmp/opencode-mattermost-plugin.log | tail -5

# Check for post errors
grep "Failed to post" /tmp/opencode-mattermost-plugin.log | tail -5
```

**Resolution** (5 min):
```bash
# If session doesn't exist:
# User needs to send new DM to create session

# If thread not created:
# Check Mattermost permissions
# Verify bot has create_post permission

# If routing issue:
# Check thread-mappings.json is valid
jq . ~/.config/opencode/thread-mappings.json

# If post error:
# Check token validity
curl -X GET "https://your-mattermost.com/api/v4/users/me" \
  -H "Authorization: Bearer $MATTERMOST_TOKEN"

# If token expired, update it and restart
export MATTERMOST_TOKEN="new-token"
pkill -f opencode
sleep 2
opencode &
```

---

### Incident: File Upload Failures

**Symptoms**: `mattermost_send_file` fails with permission error

**Diagnosis** (2 min):
```bash
# Check bot permissions
curl -X GET "https://your-mattermost.com/api/v4/users/me/roles" \
  -H "Authorization: Bearer $MATTERMOST_TOKEN"

# Check file size
ls -lh /path/to/file

# Check logs
grep "upload_file\|permission" /tmp/opencode-mattermost-plugin.log | tail -5
```

**Resolution** (5 min):
```bash
# If permission denied:
# 1. Go to Mattermost System Console
# 2. Verify bot has upload_file permission
# 3. Restart OpenCode

# If file too large:
# Check OPENCODE_MM_MAX_FILE_SIZE
echo $OPENCODE_MM_MAX_FILE_SIZE

# Increase if needed
export OPENCODE_MM_MAX_FILE_SIZE="20971520"  # 20MB, was 10MB
```

---

## Maintenance Tasks

### Daily (5 min)

```bash
#!/bin/bash
# daily-check.sh

echo "=== Daily Health Check ==="

# 1. Server status
if curl -s http://localhost:4096/ > /dev/null; then
  echo "✓ Server running"
else
  echo "✗ Server down - restarting"
  pkill -f opencode
  sleep 2
  opencode &
  sleep 5
fi

# 2. Plugin connection
if grep -q "Connected to Mattermost" /tmp/opencode-mattermost-plugin.log; then
  echo "✓ Plugin connected"
else
  echo "✗ Plugin not connected"
fi

# 3. Recent errors
ERROR_COUNT=$(grep "ERROR" /tmp/opencode-mattermost-plugin.log | wc -l)
echo "✓ Errors in log: $ERROR_COUNT"

# 4. Disk usage
DISK_USAGE=$(du -sh ~/.config/opencode/ 2>/dev/null | cut -f1)
echo "✓ Config size: $DISK_USAGE"
```

Schedule:
```bash
0 9 * * * /path/to/daily-check.sh >> /var/log/kaji-daily.log 2>&1
```

### Weekly (15 min)

```bash
#!/bin/bash
# weekly-maintenance.sh

echo "=== Weekly Maintenance ==="

# 1. Backup thread mappings
BACKUP_DIR="/backups/opencode-kaji"
mkdir -p "$BACKUP_DIR"
cp ~/.config/opencode/thread-mappings.json \
   "$BACKUP_DIR/thread-mappings_$(date +%Y%m%d).json"
echo "✓ Backed up thread mappings"

# 2. Clean old logs (keep 7 days)
find /tmp -name "opencode-mattermost-plugin.log*" -mtime +7 -delete
echo "✓ Cleaned old logs"

# 3. Check for orphaned threads
MAPPING_COUNT=$(jq 'length' ~/.config/opencode/thread-mappings.json 2>/dev/null || echo "0")
echo "✓ Active mappings: $MAPPING_COUNT"

# 4. Verify backup integrity
if [ -f "$BACKUP_DIR/thread-mappings_$(date +%Y%m%d).json" ]; then
  echo "✓ Backup verified"
else
  echo "✗ Backup failed"
fi

# 5. Check for updates
echo "✓ Check for plugin updates manually"
```

Schedule:
```bash
0 2 * * 0 /path/to/weekly-maintenance.sh >> /var/log/kaji-weekly.log 2>&1
```

### Monthly (30 min)

- [ ] Review and clean old logs (>30 days)
- [ ] Test recovery procedures
- [ ] Check for available updates
- [ ] Review security permissions
- [ ] Capacity planning (disk, memory, sessions)
- [ ] Update runbooks if needed

---

## Escalation Procedures

### Level 1: Automatic Recovery (5 min)

```bash
# Restart OpenCode
pkill -f opencode
sleep 2
opencode &

# Monitor logs
sleep 5
tail -f /tmp/opencode-mattermost-plugin.log
```

If recovered: Document in incident log and close.

### Level 2: Manual Investigation (15 min)

```bash
# Detailed diagnostics
echo "=== Detailed Diagnostics ==="

# 1. Check all environment variables
echo "MATTERMOST_TOKEN: ${MATTERMOST_TOKEN:0:10}..."
echo "MATTERMOST_URL: $MATTERMOST_URL"
echo "MATTERMOST_OWNER_USER_ID: $MATTERMOST_OWNER_USER_ID"

# 2. Check Mattermost connectivity
curl -v https://your-mattermost.com/api/v4/system/ping 2>&1 | grep -E "HTTP|Connected"

# 3. Check bot token validity
curl -s -X GET "https://your-mattermost.com/api/v4/users/me" \
  -H "Authorization: Bearer $MATTERMOST_TOKEN" | jq '.username'

# 4. Check thread mappings integrity
jq . ~/.config/opencode/thread-mappings.json | head -20

# 5. Check recent errors
grep "ERROR\|error" /tmp/opencode-mattermost-plugin.log | tail -20
```

If issue identified: Apply fix and restart.

### Level 3: Escalation (30 min)

If Level 1 & 2 don't resolve:

1. **Notify**: Page on-call engineer
2. **Gather**: Collect logs and diagnostics
3. **Escalate**: Contact Mattermost admin or OpenCode support
4. **Document**: Create incident ticket

---

## Monitoring Alerts

### Alert: Server Down

```bash
# Trigger when curl fails
if ! curl -s http://localhost:4096/ > /dev/null; then
  # Send alert
  echo "ALERT: OpenCode server is down" | mail -s "Kaji Alert" ops@company.com
  
  # Auto-restart
  pkill -f opencode
  sleep 2
  opencode &
fi
```

### Alert: High Memory

```bash
# Trigger when memory > 1GB
MEMORY=$(ps aux | grep opencode | grep -v grep | awk '{print $6}')
if [ "$MEMORY" -gt 1000000 ]; then
  echo "ALERT: OpenCode using ${MEMORY}KB" | mail -s "Kaji Alert" ops@company.com
fi
```

### Alert: Disconnected

```bash
# Trigger when not connected for >5 min
if ! grep -q "Connected to Mattermost" /tmp/opencode-mattermost-plugin.log; then
  LAST_CONNECT=$(grep "Connected to Mattermost" /tmp/opencode-mattermost-plugin.log | tail -1)
  echo "ALERT: Not connected. Last: $LAST_CONNECT" | mail -s "Kaji Alert" ops@company.com
fi
```

---

## Rollback Procedures

### Rollback to Previous Version

```bash
# 1. Stop OpenCode
pkill -f opencode

# 2. Downgrade package
bun add -g opencode-mattermost-control@0.3.44

# 3. Clear cache
rm -rf ~/.config/opencode/node_modules/opencode-mattermost-control
rm -f ~/.config/opencode/bun.lock

# 4. Reinstall
cd ~/.config/opencode
bun install

# 5. Restart
opencode &

# 6. Verify
sleep 5
grep "Connected to Mattermost" /tmp/opencode-mattermost-plugin.log
```

### Restore from Backup

```bash
# 1. Stop OpenCode
pkill -f opencode

# 2. Restore thread mappings
cp /backups/opencode-kaji/thread-mappings_20260201.json \
   ~/.config/opencode/thread-mappings.json

# 3. Restart
opencode &

# 4. Verify
sleep 5
jq 'length' ~/.config/opencode/thread-mappings.json
```

---

## Contact & Escalation

| Issue | Contact | Response Time |
|-------|---------|----------------|
| Server down | On-call engineer | 5 min |
| Mattermost issue | Mattermost admin | 15 min |
| Plugin bug | OpenCode support | 1 hour |
| Security issue | Security team | Immediate |

---

## Useful Links

- **Logs**: `/tmp/opencode-mattermost-plugin.log`
- **Config**: `~/.config/opencode/opencode.json`
- **Mappings**: `~/.config/opencode/thread-mappings.json`
- **Backups**: `/backups/opencode-kaji/`
- **Documentation**: `/root/gitrepos/opencode-mattermost-plugin/DEPLOYMENT_GUIDE.md`

