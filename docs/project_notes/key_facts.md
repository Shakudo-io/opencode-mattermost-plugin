# Key Facts

## Restarting OpenCode with Plugin Updates

After publishing a new plugin version and updating `~/.config/opencode/package.json`:

**Preferred method - use helper script:**
```bash
opencode-shared-restart
```

Or with specific version:
```bash
opencode-shared-restart -v 0.3.3
```

After reconnecting, verify restart succeeded:
```bash
opencode-shared-restart --status
```

**Important:** `mattermost_disconnect` / `mattermost_connect` does NOT reload plugin code. You must fully restart OpenCode.

## Plugin Update Workflow

1. Bump version in `package.json`
2. Publish: `npm publish --registry http://verdaccio.hyperplane-verdaccio.svc.cluster.local:4873`
3. Update `~/.config/opencode/package.json` with new version
4. Clear cache: `rm -rf ~/.config/opencode/node_modules/opencode-mattermost-control ~/.config/opencode/bun.lock`
5. Install: `cd ~/.config/opencode && bun install --registry http://verdaccio.hyperplane-verdaccio.svc.cluster.local:4873`
6. Restart OpenCode: `opencode-shared-restart`

## Registry

- Verdaccio: `http://verdaccio.hyperplane-verdaccio.svc.cluster.local:4873`

## Key Directories

- Plugin source: `/root/gitrepos/opencode-mattermost-plugin/` (main) or worktree
- OpenCode config: `~/.config/opencode/`
- Plugin cache: `~/.config/opencode/node_modules/opencode-mattermost-control/`
- Plugin logs: `/tmp/opencode-mattermost-plugin.log`
- Thread mappings: `~/.local/share/opencode/thread-mappings.json`

## Environment Variables

Required:
- `MATTERMOST_TOKEN` - Bot access token
- `MATTERMOST_URL` - API URL (e.g., `https://mattermost.example.com/api/v4`)

Optional:
- `MATTERMOST_OWNER_USER_ID` - Filter to only respond to specific user's DMs
- `OPENCODE_MM_AUTO_CREATE_SESSION` - Auto-create session from main DM (default: true)
