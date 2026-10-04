# KoolBot Troubleshooting Guide

Common issues and solutions for KoolBot deployment and operation.

> **Configuration lives in the Web UI.** Administrators run `/config` in
> Discord to receive a single-use sign-in link; `/config` is
> Administrator-only. Members run `/me` to open their own settings
> (notifications, timezone and so on). Steps below say "Web UI → Settings"
> when they mean the Settings page in that UI. The old admin slash commands
> (`/permissions`, `/setup`, `/announce`, `/poll`, `/reactrole`, `/notice`,
> `/dbtrunk`, `/vc`, `/botstats`) were retired in favour of Web UI pages.
> For Web-UI-specific issues, see [WEBUI.md → Troubleshooting](WEBUI.md#troubleshooting).

---

## 📋 Table of Contents

- [Initial Setup Issues](#-initial-setup-issues)
- [Docker Issues](#-docker-issues)
- [Discord Connection Issues](#-discord-connection-issues)
- [Web UI Issues](#-web-ui-issues)
- [Command Issues](#-command-issues)
- [Voice Channel Issues](#-voice-channel-issues)
- [Feature Issues (2.0)](#-feature-issues-20)
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
   WEBUI_SESSION_SECRET=...   # at least 32 bytes: openssl rand -base64 32
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
```

If `docker` itself is denied on Linux, add your user to the `docker` group
(`sudo usermod -aG docker $USER`, then log in again) rather than loosening
permissions on `/var/run/docker.sock`.

The image runs as the non-root numeric user `1000:1000`. If you bind-mount a
host directory into the container and the bot cannot write to it, make that
directory writable by UID 1000 (`sudo chown -R 1000:1000 <dir>`).

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
   - With `WEBUI_ENABLED=true`, a missing `WEBUI_BASE_URL` or a
     `WEBUI_SESSION_SECRET` shorter than 32 bytes is reported by `/config`
     (see [Web UI Issues](#-web-ui-issues))

3. **Port conflicts:**

   The production `docker-compose.yml` does not publish MongoDB's port
   27017 to the host (the bot reaches it on the internal Docker
   network), so port-27017 conflicts only apply if you've added a
   publish yourself or you're using `docker-compose.dev.yml`.

   ```bash
   # Check if port 27017 is in use on the host
   netstat -an | grep 27017

   # If you've added a host publish for debugging, bind it to localhost
   # only and pick a free host port — never bind 0.0.0.0:
   # In docker-compose.yml (or the dev file):
   #   ports:
   #     - "127.0.0.1:27018:27017"
   # In .env (the bot container always connects internally):
   #   MONGODB_URI=mongodb://mongodb:27017/koolbot
   # The host port only affects connections from your host machine;
   # containers still talk to MongoDB on its internal port 27017.
   # Exposing 27017 to 0.0.0.0 with the default mongo image (no auth)
   # makes the database publicly accessible for both reads and writes
   # — don't do it.
   ```

### Container shows "unhealthy"

The image health check (exec-form, `wget --spider http://localhost:3000/ready`)
only passes once the bot has finished starting up, Discord is connected and
MongoDB is reachable. While any of those is down, `/ready` (and its alias
`/health`) returns 503. Check `docker compose logs -f bot` for the cause, which
is usually a bad `DISCORD_TOKEN` or an unreachable `MONGODB_URI`. `/live`
only reports that the process is up. If you override the health check or change
the port, keep it pointed at the health server's port (3000 by default).

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
   docker pull mongo:8
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

   Replace `YOUR_CLIENT_ID` with your actual Client ID. `permissions=8`
   (Administrator) is the quickest way to rule permissions out; once things
   work, prefer granting only the specific permissions listed below.

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
   - View Audit Log, Moderate Members and Ban Members for
     the moderation features (see
     [Moderation log is missing native kicks, bans or timeouts](#moderation-log-is-missing-native-kicks-bans-or-timeouts))

### Bot logs in but "Used disallowed intents" / login fails

KoolBot always requests Guilds, GuildMessages, GuildVoiceStates,
MessageContent, GuildMessageReactions, GuildModeration and
GuildMessagePolls. **Message Content** is a privileged intent: enable it
under Developer Portal → Your App → Bot → Privileged Gateway Intents, or
login is rejected.

The **Server Members** intent is optional and only requested when you set
`GUILD_MEMBERS_INTENT=true` in `.env`. Enable it in the portal *first*,
because requesting an intent the portal has not enabled makes login fail.
Without it the bot still works; the only visible loss is server-nickname
history (`namehistory.enabled`), and the bot logs a warning at startup:

```text
namehistory.enabled is on but GUILD_MEMBERS_INTENT is not set: server nickname changes are not recorded ...
```

### Commands reply "Permissions can't be verified right now"

**Symptom:** every non-admin command is refused with a "please try again
in a moment" message.

The bot could not load its command-permissions cache from MongoDB, so it
cannot tell which commands are role-gated. It refuses commands rather
than running them ungated; administrators are unaffected, because their
bypass reads live Discord data rather than the cache.

**Solutions:**

1. Check the bot log for `Error initializing permissions cache` and fix
   the underlying MongoDB connectivity problem (see
   [Database Issues](#-database-issues)).
2. Once Mongo is reachable the cache is loaded again on the next command;
   no manual reload is needed.

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

### `/config` says "Web UI is enabled but its configuration is invalid"

The message lists what is wrong, for example `WEBUI_BASE_URL is missing`,
`WEBUI_SESSION_SECRET is missing`, or a secret shorter than 32 bytes. Both
variables must be set in `.env` when `WEBUI_ENABLED=true`. Generate the
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

### `/config` says "is for administrators"

`/config` is Administrator-only. Members should run `/me` to open their own
settings page (it is only registered while the Web UI is enabled). See
[`/config` Command Not Working](#config-command-not-working).

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
- DB session row passed its hard TTL (`WEBUI_SESSION_LIFETIME_HOURS`).
- You ran `/config` (or `/me`) again, which server-side-revoked this session.
- The live permission re-check failed: admin sessions need the Administrator
  permission in Discord, and `/me` sessions must still pass the `me`
  command's role gating. Losing either revokes the session.
- The bot restarted with a new `WEBUI_SESSION_SECRET`.

The cookie is **not** bound to your client IP — switching networks
does not by itself end a session.

Run `/config` again to mint a fresh link.

### "Security check failed (CSRF token ...)"

State-changing requests use a double-submit CSRF cookie (`koolbot_csrf`)
plus a matching token in the form or `x-csrf-token` header. "token missing"
means the cookie or the token was absent (cookies blocked or cleared, or a
stale page); "token mismatch" means they differ (for example the page was
loaded before the cookie was reissued). Reload the page and submit again.

### Web UI URL loads but won't accept my cookie

Browsers refuse `Secure`-flagged cookies over plain HTTP. The Web UI sets
`Secure` on its session cookie based on the scheme of `WEBUI_BASE_URL`
(`shouldUseSecureCookies()` in `src/web/csrf.ts`): `https://` means
`Secure`, `http://` means not `Secure`. Only if `WEBUI_BASE_URL` is missing
or malformed does it fall back to `NODE_ENV=production`. So:

- If you serve the UI over HTTPS (recommended, see
  [WEBUI.md → Reverse-proxy guidance](WEBUI.md#reverse-proxy-guidance)),
  set `WEBUI_BASE_URL` to the `https://` URL you actually browse to.
- If you browse over plain HTTP (local testing), set `WEBUI_BASE_URL` to the
  `http://` URL.
- A `WEBUI_BASE_URL` that does not match the address in your browser is the
  usual cause: the magic link is built from it, so the cookie lands on the
  wrong origin.

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

1. **Run `/config` → Web UI → Settings** (members cannot do this; it is
   Administrator-only), set `<command>.enabled` to
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
   is Administrator-only (members use `/me`) and is registered with `setDefaultMemberPermissions(Administrator)`, so
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

   You should see `WebUI mounted at /admin and user surface at /me`.

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
- `voicechannels.category_id` = the ID of the category in Discord (older
  installs that used `voicechannels.category.name` are migrated to the ID
  automatically on startup)

**Solutions:**

1. **Enable voice channels:**
   - Web UI → Settings → set `voicechannels.enabled` = `true`.
   - Save and reload commands.

2. **Run the Setup Wizard:**
   - Web UI → Setup Wizard → Voice Channels.
   - The wizard auto-detects categories.

3. **Verify category exists:**
   - `voicechannels.category_id` must point at a category in this server;
     otherwise the bot logs `voicechannels.category_id is not set or doesn't resolve to a category in this guild`
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

1. **Force cleanup** — Web UI → Voice Channels → **Force VC cleanup**.

   ⚠️ **Warning:** Force VC cleanup removes all empty unmanaged channels in
   the category and then ensures the lobby exists. Unmanaged channels with
   members in them are kept until they empty. An offline lobby is renamed
   back online; otherwise the lobby is deleted and re-created, which
   disconnects anyone currently sitting in it.

2. **Check bot logs:**

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

## 🗓 Feature Issues (2.0)

### Event has no voice channel

Event channels are created by the event scan shortly before the start time
(`events.create_lead_minutes`). Check the bot log for:

- `events.category_id not set — cannot create channel for event ...`: set
  `events.category_id` in Web UI → Settings (or the Events page).
- `Event category ... not found or not a category`: the ID is wrong or not a
  category.
- `Error creating event channel:`: the bot lacks Manage Channels in that
  category.
- `events.announcement_channel_id not set — skipping event announcement`: the
  announcement is skipped (the channel is unaffected).

Also confirm `events.enabled` is `true` and that you reloaded commands so
`/event` appears.

### Reminders are not delivered

`/remind` delivers by DM first. If DMs are closed it falls back to the
channel where the reminder was set, and the bot logs `Reminder: DMs closed
for <user>, falling back to channel`. The fallback is dropped (logged as
`dropping`) if the channel is no longer sendable, is in another server, or
the member has left. Ask the member to allow DMs from server members, and
check `reminders.enabled` and `reminders.max_pending`.

### Birthdays are not announced

- `birthdays.enabled` must be `true` and `birthdays.channel_id` must be a
  text channel; otherwise the run logs `Birthday run aborted: ...`
  (`birthdays.channel_id not configured`, `channel ... not found or not a
  text channel`, or `guild ... not found`).
- Members must have set their own birthday under `/me/birthday` (Web UI,
  reached with `/me`). The job runs on `birthdays.cron` (hourly by default)
  and announces in each member's own timezone.
- To grant a temporary role, `birthdays.role_id` needs the bot's role above
  it and Manage Roles.

### Notification DMs (achievements, digest, rewind) never arrive

Notification DMs are opt-in. A member who has never opened `/me/notifications`
receives nothing, by design, and so does anyone whose preferences cannot be
read. Ask the member to run `/me` and enable the channels they want, and to
allow DMs from server members.

### Moderation log is missing native kicks, bans or timeouts

Actions taken through KoolBot's own `/warn`, `/timeout` and `/ban` are
recorded directly. Kicks, bans and timeouts done with Discord's built-in
tools are mirrored from the server audit log, which needs
`moderation.enabled`, the bot's **View Audit Log** permission, and the
GuildModeration intent (requested automatically). Actions executed by the
bot itself are not mirrored a second time. Failures are logged as
`Error mirroring moderation audit-log entry:`. `/ban` also needs Ban
Members and `/timeout` needs Moderate Members.

### A scheduled job did not pick up its new schedule

Saving a cron key in the Web UI re-arms the matching job (birthdays, digest,
events, reminders, leaderboard roles and so on). If re-arming fails, the
saved page says the schedule "could not be re-armed" and the log shows
`Failed to re-arm <job> after settings save`; the new schedule then applies
after a bot restart. An invalid cron expression is refused rather than
armed. A scheduled run that throws is logged as
`scheduled run failed:` and does not stop later runs.

### Poll import fails

Poll libraries are imported from an uploaded file or pasted text only. URL
import was removed in 2.0, and `POLL_IMPORT_ALLOWED_HOSTS` no longer exists.
Download the file and upload it from Web UI → Polls. See
[`examples/polls/`](examples/polls/README.md) for the format.

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

### Bot lost MongoDB and features stopped saving

The data-keeping services watch the Mongoose connection and log
`MongoDB connection lost for <service>` when it drops and
`MongoDB connection established for <service>` when the driver reconnects.
Before the next query they try to reconnect themselves and log
`Reconnected to MongoDB for <service>`; if that fails you will see
`Error reconnecting to MongoDB:`. The Docker health check (`/ready`) also
reports 503 while MongoDB is down. If the log shows repeated reconnect
errors, fix the database (see the steps above) and, if it does not recover,
`docker compose restart bot`.

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
