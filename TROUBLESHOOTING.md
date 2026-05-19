# KoolBot Troubleshooting Guide

Common issues and solutions for KoolBot deployment and operation.

> **From v1.0:** Configuration is edited from the **Web UI** (run
> `/config` in Discord to receive a single-use sign-in link). Steps
> below say "Web UI → Settings" when they mean the Settings page in
> that UI. For Web-UI-specific issues, see [WEBUI.md → Troubleshooting](WEBUI.md#troubleshooting).

---

## 📋 Table of Contents

- [Initial Setup Issues](#-initial-setup-issues)
- [Docker Issues](#-docker-issues)
- [Discord Connection Issues](#-discord-connection-issues)
- [Web UI Issues](#-web-ui-issues)
- [Command Issues](#-command-issues)
- [Voice Channel Issues](#-voice-channel-issues)
- [Database Issues](#-database-issues)
- [Configuration Issues](#-configuration-issues)
- [Performance Issues](#-performance-issues)
- [Emergency Procedures](#-emergency-procedures)

---

## 🚀 Initial Setup Issues

### Bot Won't Start

**Symptoms:**

- Container immediately exits
- "Missing required environment variables" error
- Bot doesn't connect to Discord

**Solutions:**

1. **Verify `.env` file exists and is in the correct location:**

   ```bash
   ls -la .env
   ```

2. **Check all required environment variables are set:**

   ```bash
   cat .env
   ```

   Must include:

   ```env
   DISCORD_TOKEN=your_token_here
   CLIENT_ID=your_client_id
   GUILD_ID=your_guild_id
   MONGODB_URI=mongodb://mongodb:27017/koolbot
   ```

   And, when the Web UI is enabled:

   ```env
   WEBUI_ENABLED=true
   WEBUI_BASE_URL=https://bot.example.com
   WEBUI_SESSION_SECRET=...
   ```

3. **Verify Discord token is valid:**
   - Go to [Discord Developer Portal](https://discord.com/developers/applications)
   - Select your application
   - Bot tab → Reset Token if needed
   - Copy the new token to `.env`

4. **Check for extra spaces or quotes:**

   ```env
   # ❌ Wrong
   DISCORD_TOKEN = "your_token_here"

   # ✅ Correct
   DISCORD_TOKEN=your_token_here
   ```

### "Permission Denied" Errors

**Solution:**

```bash
# Fix file permissions
chmod 600 .env

# Fix Docker permissions (Linux)
sudo chmod 666 /var/run/docker.sock
```

---

## 🐳 Docker Issues

### Container Keeps Restarting

**Check logs:**

```bash
docker compose logs -f bot
```

**Common causes:**

1. **Database not ready:**
   - Wait 30 seconds for MongoDB to initialize
   - Check MongoDB status: `docker compose ps`

2. **Invalid configuration:**
   - Review error messages in logs
   - Verify all required env vars are set

3. **Port conflicts:**

   ```bash
   # Check if port 27017 is in use
   netstat -an | grep 27017

   # Or use a different port on the host
   # In docker-compose.yml: "27018:27017"
   # In .env (for bot container): MONGODB_URI=mongodb://mongodb:27017/koolbot
   # Note: The host port (27018) only affects connections from your host machine.
   #       Containers still connect to MongoDB on its internal port 27017.
   ```

### "docker compose: command not found"

**Solutions:**

1. **Install Docker Compose v2:**

   ```bash
   # Linux
   sudo apt-get install docker-compose-plugin

   # macOS (via Homebrew)
   brew install docker

   # Or use Docker Desktop (includes compose v2)
   ```

2. **Use the legacy `docker-compose` (with dash) if you have it:**

   ```bash
   docker-compose up -d
   ```

### MongoDB Container Won't Start

**Check logs:**

```bash
docker compose logs -f mongodb
```

**Solutions:**

1. **Remove corrupted volume:**

   ```bash
   docker compose down -v
   docker compose up -d
   ```

   ⚠️ This deletes all data. Back up first if possible.

2. **Check disk space:**

   ```bash
   df -h
   ```

3. **Verify MongoDB image:**

   ```bash
   docker pull mongo:latest
   docker compose up -d --force-recreate
   ```

---

## 📡 Discord Connection Issues

### Bot Appears Offline

**Verify:**

1. **Check bot is running:**

   ```bash
   docker compose ps
   ```

2. **Check logs for connection errors:**

   ```bash
   docker compose logs -f bot | grep -i "error\|discord"
   ```

3. **Verify Discord token:**
   - Token must be from the "Bot" section, not "OAuth2"

4. **Check Discord API status:**
   - Visit [Discord Status](https://discordstatus.com)

### Invalid Token Error

**Symptoms:**

```text
Error: An invalid token was provided
```

**Solutions:**

1. **Reset your bot token:**
   - Discord Developer Portal → Your App → Bot
   - Reset Token → Copy new token
   - Update `.env` file
   - Restart bot: `docker compose restart bot`

2. **Check for extra characters:**
   - No spaces before/after token
   - No quotes around token
   - No newlines in token

### Bot Has No Permissions

**Symptoms:**

- Commands don't appear
- Bot can't create channels
- Bot can't move users

**Solutions:**

1. **Re-invite bot with correct permissions:**

   ```text
   https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=8&scope=bot%20applications.commands
   ```

   Replace `YOUR_CLIENT_ID` with your actual Client ID.

2. **Check role hierarchy:**
   - Bot's role must be ABOVE roles it needs to manage
   - Move bot's role higher in Server Settings → Roles

3. **Verify required permissions:**
   - Administrator (easiest), or:
   - Manage Channels
   - Manage Roles (for reaction roles, leaderboard role rewards)
   - Move Members
   - Send Messages
   - Use Slash Commands
   - Embed Links

---

## 🌐 Web UI Issues

### `/config` says "the web UI is disabled"

`WEBUI_ENABLED` is not `true` (case-insensitive). Update `.env`:

```env
WEBUI_ENABLED=true
```

Then restart the bot:

```bash
docker compose up -d --force-recreate
```

### `/config` says "missing env vars: WEBUI_BASE_URL, WEBUI_SESSION_SECRET"

Both must be set in `.env` when `WEBUI_ENABLED=true`. Generate the
secret on your host first (dotenv does not run shell substitutions):

```bash
openssl rand -base64 32
```

Then paste the output into `.env`:

```env
WEBUI_BASE_URL=https://bot.example.com   # or http://localhost:3000 for local
WEBUI_SESSION_SECRET=<paste-the-output-here>
```

Restart the bot.

### `/config` ran but I didn't get a DM

The bot tries to DM, then falls back to an **ephemeral reply** in the
channel where you ran `/config` (visible only to you). Check there for
the sign-in link.

If you'd rather receive DMs:

- Discord Settings → Privacy & Safety → Allow direct messages from
  server members (for the server where the bot runs).

The bot logs a warning when it falls back:

```text
Could not DM web sign-in link to <user-id>; falling back to ephemeral reply
```

### Magic link 404s when clicked

One of:

- It was already redeemed (single-use). Run `/config` again.
- It expired (default 10 minutes). Run `/config` again.
- You ran `/config` again later and got a *newer* link, which revoked
  this one. Use the most recent DM.
- `WEBUI_SESSION_SECRET` was changed between issuance and redemption.

### "Sign in required" on every page

Possible causes:

- Cookie expired (idle past `WEBUI_INACTIVITY_TIMEOUT_MINUTES`).
- DB session row passed its hard TTL.
- You ran `/config` again, which server-side-revoked this session.
- Permission re-check failed (Web UI Permissions → `config` was
  configured and your roles no longer match).
- The bot restarted with a new `WEBUI_SESSION_SECRET`.

The cookie is **not** bound to your client IP — switching networks
does not by itself end a session.

Run `/config` again to mint a fresh link.

### Web UI URL loads but won't accept my cookie

Browsers refuse `Secure`-flagged cookies over plain HTTP. The Web UI
flags its session cookie `Secure` whenever `NODE_ENV=production`
(`shouldUseSecureCookies()` in `src/web/csrf.ts`). Pick one:

- Run behind HTTPS via a reverse proxy (recommended) — see
  [WEBUI.md → Reverse-proxy guidance](WEBUI.md#reverse-proxy-guidance).
- Set `NODE_ENV=development` in `.env` and restart. The cookie loses
  the `Secure` flag and plain HTTP works again. **Local testing only.**

Changing `WEBUI_BASE_URL` to `http://...` alone does **not** fix this —
the URL scheme is not what flips the `Secure` flag.

### Behind a reverse proxy, rate limits trigger on the proxy's IP

Set `WEBUI_TRUST_PROXY` to your hop count (usually `1`) and restart:

```env
WEBUI_TRUST_PROXY=1
```

For Caddy / nginx / Traefik recipes, see [WEBUI.md → Docker Compose recipes](WEBUI.md#docker-compose-recipes).

### Want to disable the Web UI entirely

Set `WEBUI_ENABLED=false` (or remove the line) and restart. All
`/admin/*` paths 404 again. The `/health` endpoint is unaffected.

### I locked myself out

The bootstrap path is "if you can run `/config` in Discord, you can
configure the bot." There is no forgotten-password flow because there
is no password.

To recover:

1. Edit `.env` on the host. Set a fresh `WEBUI_SESSION_SECRET`
   (`openssl rand -base64 32`) — this invalidates every existing session
   and outstanding link.
2. Restart the bot.
3. Run `/config` in Discord from an account that holds the Administrator
   permission.

For more, see [WEBUI.md → Troubleshooting](WEBUI.md#troubleshooting).

---

## ⚡ Command Issues

### Commands Don't Appear in Discord

**Most common issue!**

**Solutions:**

1. **Run `/config` → Web UI → Settings**, set `<command>.enabled` to
   `true`, save.
2. Click **Reload commands to Discord** on the Settings page (required
   after enabling/disabling a command).
3. Wait 2-5 minutes for Discord to sync. Try a different channel or
   restart the Discord client if needed.

### "Application did not respond" Error

**Causes:**

- Bot is processing but taking too long
- Bot crashed during command execution
- Network issues

**Solutions:**

1. **Check bot logs:**

   ```bash
   docker compose logs -f bot | tail -50
   ```

2. **Restart bot:**

   ```bash
   docker compose restart bot
   ```

3. **Check MongoDB connection:**

   ```bash
   docker compose logs mongodb | grep -i error
   ```

### `/config` Command Not Working

**Solutions:**

1. **Verify you have Administrator permission** in Discord. `/config`
   is registered with `setDefaultMemberPermissions(Administrator)`, so
   Discord blocks non-admins from even invoking it. If you need to
   allow a non-admin role, an operator must override the command in
   Discord under **Server Settings → Integrations → KoolBot → /config**.
   The Web UI's Permissions page can only narrow access further, it
   cannot grant Discord-level access on its own.
2. **Verify `WEBUI_ENABLED=true`** in `.env` and that you've restarted
   the bot since the change.
3. **Check bot logs for the mount confirmation:**

   ```bash
   docker compose logs -f bot | grep -i webui
   ```

   You should see `WebUI mounted at /admin`.

4. **Verify MongoDB is connected** — the Bootstrap page in the Web UI
   shows this, but if you can't even reach the UI:

   ```bash
   docker compose ps mongodb
   docker compose logs mongodb
   ```

---

## 🎙 Voice Channel Issues

### Lobby Channel Not Creating Users' Rooms

**Check configuration** in the Web UI's Settings page:

- `voicechannels.enabled` = `true`
- `voicechannels.category.name` = the exact category name in Discord

**Solutions:**

1. **Enable voice channels:**
   - Web UI → Settings → set `voicechannels.enabled` = `true`.
   - Save and reload commands.

2. **Run the Setup Wizard:**
   - Web UI → Setup Wizard → Voice Channels.
   - The wizard auto-detects categories.

3. **Verify category exists:**
   - Create the category in Discord with the exact name configured
   - Bot role must have permissions in that category

4. **Check bot permissions:**
   - Manage Channels
   - Move Members
   - Connect
   - View Channel

### Voice Channels Not Being Deleted

**Symptoms:**

- Empty channels remain after everyone leaves
- Channels accumulate over time

**Solutions:**

1. **Manual cleanup** — Web UI → Voice Channels → **Reload empty
   channels**.

2. **Force cleanup** — Web UI → Voice Channels → **Force cleanup**.

   ⚠️ **Warning:** Force cleanup removes ALL unmanaged channels in the
   category, including ones with users in them.

3. **Check bot logs:**

   ```bash
   docker compose logs -f bot | grep -i voice
   ```

### Voice Tracking Not Working

**Check configuration** in the Web UI's Settings page:

- `voicetracking.enabled` = `true`

**Solutions:**

1. **Enable tracking** — Web UI → Settings → set
   `voicetracking.enabled` = `true`, save.

2. **Check excluded channels** — Web UI → Settings →
   `voicetracking.excluded_channels`. If your test channel is in this
   list, sessions there won't be tracked.

3. **Verify users are in voice channels** — stats only update while
   users are active. The bot doesn't backfill data from before tracking
   was enabled.

4. **Check database** — Web UI → Database → see counts and last cleanup
   run.

### `/voicestats top` shows "No data"

**Causes:**

- Tracking recently enabled (no data yet)
- All target channels are excluded
- Users haven't been in voice yet

**Solutions:**

1. **Wait for data to accumulate** — join a voice channel for a few
   minutes, then re-run.

2. **Check excluded channels** — Web UI → Settings →
   `voicetracking.excluded_channels`.

3. **Verify tracking is enabled** — Web UI → Settings → confirm
   `voicetracking.enabled` is `true`.

---

## 💾 Database Issues

### "MongoDB connection timeout"

**Solutions:**

1. **Check MongoDB container:**

   ```bash
   docker compose ps mongodb
   ```

2. **Restart MongoDB:**

   ```bash
   docker compose restart mongodb
   ```

3. **Check MongoDB logs:**

   ```bash
   docker compose logs -f mongodb
   ```

4. **Verify `MONGODB_URI`:**

   ```bash
   grep MONGODB_URI .env
   ```

   Should be: `mongodb://mongodb:27017/koolbot`

### Database Connection Refused

**Solutions:**

1. **Ensure MongoDB container is running:**

   ```bash
   docker compose up -d mongodb
   ```

2. **Check network connectivity:**

   ```bash
   docker compose exec bot ping mongodb
   ```

3. **Recreate containers:**

   ```bash
   docker compose down
   docker compose up -d
   ```

### Data Loss / Cleanup Too Aggressive

**Check retention settings** — Web UI → Settings:

- `voicetracking.cleanup.retention.detailed_sessions_days`
- `voicetracking.cleanup.retention.monthly_summaries_months`
- `voicetracking.cleanup.retention.yearly_summaries_years`

**Adjust retention:**

- Web UI → Settings → bump
  `voicetracking.cleanup.retention.detailed_sessions_days` to `60` or
  `90` (60+ days is required for the 30-day "No-Lifer" accolade).
- Or set `voicetracking.cleanup.enabled` to `false` to pause cleanup
  entirely.

### Database Backup and Restore

**Create a backup:**

```bash
docker compose exec mongodb mongodump \
  --archive=/data/db/backup.archive --db=koolbot

docker cp koolbot-mongodb:/data/db/backup.archive \
  ./koolbot-backup-$(date +%Y%m%d).archive
```

**Restore from backup:**

```bash
docker cp ./koolbot-backup-YYYYMMDD.archive \
  koolbot-mongodb:/data/db/restore.archive

docker compose exec mongodb mongorestore \
  --archive=/data/db/restore.archive --db=koolbot --drop

docker compose restart bot
```

> **Note:** The `--drop` flag removes existing collections before
> restoring to avoid data conflicts.

**Automated backups (recommended):**

```bash
#!/bin/bash
BACKUP_DIR="/path/to/backups"
DATE=$(date +%Y%m%d)
docker compose exec mongodb mongodump \
  --archive=/data/db/backup.archive --db=koolbot
docker cp koolbot-mongodb:/data/db/backup.archive \
  "$BACKUP_DIR/koolbot-backup-$DATE.archive"

# Keep only last 7 days of backups
find "$BACKUP_DIR" -name "koolbot-backup-*.archive" -mtime +7 -delete
```

---

## ⚙ Configuration Issues

### "Invalid key" Error

**Cause:** Typo in configuration key when importing YAML.

**Solution:**

- The Web UI's Settings page lists every valid key. Compare your
  imported YAML against what the Settings page shows.
- The YAML import preview surfaces keys that don't match the schema —
  it will not let you apply an invalid key.

### Settings Not Persisting

**Check MongoDB:**

```bash
# Verify database is running
docker compose ps mongodb

# In the Web UI's Settings page, change a value, save, refresh — does it stick?
```

If the database is corrupted:

```bash
# 1. Back up configuration via Web UI → Settings → Export
#    (download the YAML file the Web UI returns)

# 2. Back up database
docker compose exec mongodb mongodump \
  --archive=/data/db/backup.archive --db=koolbot
docker cp koolbot-mongodb:/data/db/backup.archive \
  ./koolbot-backup-$(date +%Y%m%d).archive

# 3. Reset database
docker compose down -v
docker compose up -d

# 4. After bot is back, re-issue /config in Discord and import the
#    YAML from step 1 via the Web UI's Settings → Import.

# 5. (Optional) Restore raw MongoDB if you'd rather skip YAML import
docker cp ./koolbot-backup-YYYYMMDD.archive \
  koolbot-mongodb:/data/db/restore.archive
docker compose exec mongodb mongorestore \
  --archive=/data/db/restore.archive --db=koolbot --drop
docker compose restart bot
```

### Can't Import YAML Configuration

**Verify YAML format:**

```yaml
# Correct format
ping:
  enabled: true
voicechannels:
  enabled: true
  category:
    name: "Voice Channels"
```

**Common issues:**

- Incorrect indentation (use 2 spaces)
- Missing quotes on strings with special characters
- Invalid YAML syntax
- Attempting to set a protected key (`DISCORD_TOKEN`,
  `WEBUI_SESSION_SECRET`, etc.) — these are bootstrap env vars and the
  Web UI rejects imports that touch them. Remove those keys from the
  YAML and try again.

---

## 🚀 Performance Issues

### Bot Running Slowly

**Check resource usage:**

```bash
# View container stats
docker stats

# Check system resources inside the container
docker compose exec bot top
```

**Solutions:**

1. **Increase Docker resources:**
   - Docker Desktop → Settings → Resources
   - Increase CPU and memory allocation

2. **Check database size** via Web UI → Database. If it's large, click
   **Run cleanup now**.

3. **Optimize retention** via Web UI → Settings:
   - Reduce `voicetracking.cleanup.retention.detailed_sessions_days`
   - Keep it at 60+ if you use consecutive-day accolades

### High Memory Usage

**Normal memory usage:** 200-300 MB

**If exceeding 500 MB:**

1. **Restart bot:**

   ```bash
   docker compose restart bot
   ```

2. **Check for memory leaks in logs:**

   ```bash
   docker compose logs -f bot | grep -i "memory\|heap"
   ```

3. **Update to latest version:**

   ```bash
   docker compose pull
   docker compose up -d
   ```

---

## 🆘 Emergency Procedures

### Complete Reset

If everything is broken:

```bash
# 1. Back up configuration (YAML) from Web UI → Settings → Export

# 2. Back up database
docker compose exec mongodb mongodump \
  --archive=/data/db/backup.archive --db=koolbot
docker cp koolbot-mongodb:/data/db/backup.archive \
  ./koolbot-backup-$(date +%Y%m%d).archive

# 3. Stop everything
docker compose down -v

# 4. Verify .env file
cat .env

# 5. Start fresh
docker compose up -d

# 6. Wait for startup, check logs
docker compose logs -f bot

# 7. In Discord, run /config → open the Web UI → Settings → Import
#    Upload your saved YAML file from step 1.

# 8. (Optional) Restore raw MongoDB if you'd rather skip YAML import
docker cp ./koolbot-backup-YYYYMMDD.archive \
  koolbot-mongodb:/data/db/restore.archive
docker compose exec mongodb mongorestore \
  --archive=/data/db/restore.archive --db=koolbot --drop
docker compose restart bot
```

### Get Support

1. **Check logs first:**

   ```bash
   docker compose logs bot > bot-logs.txt
   ```

2. **Gather information:**
   - KoolBot version: `docker compose exec bot cat package.json | grep version`
   - Docker version: `docker --version`
   - OS: `uname -a`
   - Error messages from logs

3. **Open an issue:**
   - [GitHub Issues](https://github.com/lonix/koolbot/issues)
   - Include logs and configuration (remove sensitive data — `DISCORD_TOKEN`,
     `WEBUI_SESSION_SECRET`, etc.)

---

## 📖 Related Documentation

- **[README.md](README.md)** — Bot overview and quick start
- **[WEBUI.md](WEBUI.md)** — Web UI setup, magic-link flow, troubleshooting
- **[COMMANDS.md](COMMANDS.md)** — Complete command reference
- **[SETTINGS.md](SETTINGS.md)** — Configuration guide

---

<div align="center">

**Still having issues?** [Open an issue on GitHub](https://github.com/lonix/koolbot/issues)

Include logs, configuration (without tokens!), and steps to reproduce.

</div>
