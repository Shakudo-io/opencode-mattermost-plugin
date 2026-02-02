# Kaji Operations Documentation Summary

**Created**: 2026-02-02  
**Version**: 0.3.45  
**Status**: Complete

## Overview

This directory now contains comprehensive operational documentation for deploying and managing the OpenCode Mattermost Control Plugin (Kaji) in production environments.

## Documentation Files

### 1. **KAJI_INTEGRATION_ANALYSIS.md** (28KB)
Comprehensive technical analysis of the plugin architecture.

**Contents**:
- Executive summary
- 14-component architecture breakdown
- Integration points (OpenCode ↔ Mattermost)
- 14 remote control tools + user commands + emoji commands
- Session management with thread-per-session model
- Notification and alerting system
- Advanced features (file completion, merging, context injection, scheduled tasks)
- Configuration reference
- Security and performance considerations
- Troubleshooting guide

**Audience**: Architects, developers, technical leads

**Use Case**: Understanding how Kaji works, designing integrations, debugging complex issues

---

### 2. **DEPLOYMENT_GUIDE.md** (520 lines)
Step-by-step guide for deploying Kaji in production.

**Contents**:
- Pre-deployment checklist
- Mattermost bot setup (4 steps)
- Installation methods (global, per-project, Docker, Kubernetes)
- Configuration and environment variables
- 5 deployment scenarios:
  - Single developer (local machine)
  - Team shared server
  - Multi-user with owner filtering
  - Docker container
  - Kubernetes deployment
- Multi-user setup with owner filtering
- Monitoring and observability
- Backup and recovery procedures
- Troubleshooting common issues
- Upgrade procedures with rollback

**Audience**: DevOps engineers, system administrators, platform engineers

**Use Case**: Setting up Kaji for the first time, scaling to production, managing multiple environments

---

### 3. **OPERATIONS_RUNBOOK.md** (300+ lines)
Quick reference for operational tasks and incident response.

**Contents**:
- 30-second health check
- Common commands reference
- 5 incident response procedures:
  - Bot not responding
  - High memory usage
  - WebSocket disconnects
  - Messages not appearing
  - File upload failures
- Daily/weekly/monthly maintenance tasks
- Escalation procedures (3 levels)
- Monitoring alerts with scripts
- Rollback procedures
- Contact and escalation matrix

**Audience**: On-call engineers, operations team, support staff

**Use Case**: Responding to incidents, daily operations, quick troubleshooting

---

## Quick Navigation

### I need to...

| Task | Document | Section |
|------|----------|---------|
| Understand how Kaji works | KAJI_INTEGRATION_ANALYSIS.md | Architecture |
| Deploy Kaji for the first time | DEPLOYMENT_GUIDE.md | Installation Methods |
| Set up multi-user environment | DEPLOYMENT_GUIDE.md | Multi-User Setup |
| Respond to an incident | OPERATIONS_RUNBOOK.md | Incident Response |
| Check system health | OPERATIONS_RUNBOOK.md | Quick Reference |
| Upgrade to new version | DEPLOYMENT_GUIDE.md | Upgrade Procedures |
| Backup and restore | DEPLOYMENT_GUIDE.md | Backup & Recovery |
| Monitor in production | DEPLOYMENT_GUIDE.md | Monitoring & Observability |
| Debug a specific issue | KAJI_INTEGRATION_ANALYSIS.md | Troubleshooting |

---

## Key Operational Metrics

### Health Check (30 seconds)
```bash
curl -s http://localhost:4096/ && echo "✓ Server" || echo "✗ Server DOWN"
grep -q "Connected to Mattermost" /tmp/opencode-mattermost-plugin.log && echo "✓ Connected" || echo "✗ Not connected"
grep "ERROR" /tmp/opencode-mattermost-plugin.log | tail -3
```

### Critical Files
- **Logs**: `/tmp/opencode-mattermost-plugin.log`
- **Config**: `~/.config/opencode/opencode.json`
- **Mappings**: `~/.config/opencode/thread-mappings.json` (CRITICAL - backup daily)
- **Backups**: `/backups/opencode-kaji/`

### Resource Requirements
- **Memory**: 256MB minimum, 512MB recommended
- **Disk**: 100MB for plugin + logs
- **Network**: Outbound HTTPS to Mattermost
- **Processes**: 1 OpenCode process per instance

---

## Deployment Scenarios at a Glance

| Scenario | Setup | Best For | Complexity |
|----------|-------|----------|-----------|
| Single Developer | Global install, local machine | Individual developers | Low |
| Team Shared Server | Shared OpenCode server, single bot | Small teams (2-5 people) | Medium |
| Multi-User | Owner filtering, shared bot | Multiple independent users | Medium |
| Docker | Containerized deployment | Isolated environments | Medium |
| Kubernetes | Production-grade HA setup | Enterprise deployments | High |

---

## Incident Response Quick Links

| Incident | Response Time | Runbook Section |
|----------|---------------|-----------------|
| Bot not responding | 5 min | Incident Response → Bot Not Responding |
| High memory usage | 5 min | Incident Response → High Memory Usage |
| WebSocket disconnects | 5 min | Incident Response → WebSocket Disconnects |
| Messages not appearing | 5 min | Incident Response → Messages Not Appearing |
| File upload failures | 5 min | Incident Response → File Upload Failures |

---

## Maintenance Schedule

### Daily (5 min)
- Health check (server, plugin connection, errors)
- Monitor logs for issues

### Weekly (15 min)
- Backup thread mappings
- Clean old logs
- Check for orphaned threads
- Verify backup integrity

### Monthly (30 min)
- Review and clean logs >30 days
- Test recovery procedures
- Check for available updates
- Review security permissions
- Capacity planning

---

## Configuration Hierarchy

1. **Command-line flags** (highest priority)
2. **Environment variables**
3. **Config file** (`opencode.json`)
4. **Defaults** (lowest priority)

### Essential Environment Variables

```bash
# Required
export MATTERMOST_TOKEN="your-bot-token"
export MATTERMOST_URL="https://your-mattermost.com/api/v4"

# Recommended
export MATTERMOST_OWNER_USER_ID="user_id"  # For multi-user
export OPENCODE_MM_SESSION_TIMEOUT="3600000"  # 1 hour
export OPENCODE_MM_MAX_SESSIONS="50"
export MM_PLUGIN_LOG_LEVEL="info"
```

---

## Backup & Recovery

### What to Backup
- **CRITICAL**: `~/.config/opencode/thread-mappings.json` (session-to-thread mappings)
- **Important**: `~/.config/opencode/opencode.json` (configuration)
- **Optional**: `/tmp/opencode-mattermost-plugin.log` (logs)

### Backup Strategy
```bash
# Daily backup
cp ~/.config/opencode/thread-mappings.json \
   /backups/opencode-kaji/thread-mappings_$(date +%Y%m%d).json

# Keep 30 days
find /backups/opencode-kaji -mtime +30 -delete
```

### Recovery
```bash
# Restore from backup
pkill -f opencode
cp /backups/opencode-kaji/thread-mappings_20260201.json \
   ~/.config/opencode/thread-mappings.json
opencode &
```

---

## Monitoring & Alerts

### Key Metrics to Monitor
- **Server availability**: HTTP 200 on port 4096
- **Plugin connection**: "Connected to Mattermost" in logs
- **Memory usage**: Should stay <512MB
- **Error rate**: Monitor ERROR lines in logs
- **Session count**: Track active sessions
- **Disk usage**: Monitor log file size

### Alert Thresholds
- Server down: Immediate alert
- Memory >1GB: Alert and investigate
- Disconnected >5 min: Alert
- Error rate >10/hour: Alert
- Disk usage >500MB: Alert

---

## Upgrade Path

### Version Compatibility
- Current: 0.3.45
- Minimum OpenCode: 1.1.28
- Node.js: 18+
- Bun: 1.0+

### Upgrade Steps
1. Backup thread mappings
2. Update package version
3. Clear cache
4. Reinstall dependencies
5. Restart OpenCode completely
6. Verify connection

### Rollback
```bash
bun add -g opencode-mattermost-control@0.3.44
rm -rf ~/.config/opencode/node_modules/opencode-mattermost-control
cd ~/.config/opencode && bun install
pkill -f opencode && sleep 2 && opencode &
```

---

## Support & Escalation

### Internal Escalation
1. **Level 1**: Automatic recovery (restart)
2. **Level 2**: Manual investigation (diagnostics)
3. **Level 3**: Escalation (page on-call, contact support)

### External Contacts
- **Mattermost Issues**: Mattermost admin
- **OpenCode Issues**: OpenCode support
- **Security Issues**: Security team (immediate)

---

## Document Maintenance

These documents should be updated:
- **After each major version upgrade**: Update version numbers, new features
- **After incidents**: Add to troubleshooting section
- **Quarterly**: Review and update procedures
- **When configuration changes**: Update environment variables section

---

## Related Documentation

- **README.md**: User-facing documentation
- **KAJI_INTEGRATION_ANALYSIS.md**: Technical deep dive
- **DEPLOYMENT_GUIDE.md**: Deployment procedures
- **OPERATIONS_RUNBOOK.md**: Incident response
- **GitHub Issues**: Known issues and feature requests

---

## Document Statistics

| Document | Lines | Size | Purpose |
|----------|-------|------|---------|
| KAJI_INTEGRATION_ANALYSIS.md | 1000+ | 28KB | Technical reference |
| DEPLOYMENT_GUIDE.md | 520 | 18KB | Deployment procedures |
| OPERATIONS_RUNBOOK.md | 300+ | 12KB | Incident response |
| OPERATIONS_SUMMARY.md | 300+ | 10KB | Navigation guide |

**Total**: 2000+ lines of operational documentation

---

## Next Steps

1. **Review**: Have team review all documents
2. **Customize**: Update with your specific Mattermost URLs, contacts
3. **Test**: Run through deployment and incident response procedures
4. **Train**: Conduct training for operations team
5. **Monitor**: Set up monitoring and alerts
6. **Maintain**: Schedule quarterly reviews

---

**Last Updated**: 2026-02-02  
**Maintained By**: Operations Team  
**Next Review**: 2026-05-02
