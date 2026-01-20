# KoolBot Troubleshooting Guide

Common issues and solutions for KoolBot deployment and operation.

---

## 📋 Table of Contents

- [Initial Setup Issues](#-initial-setup-issues)
- [Docker Issues](#-docker-issues)
- [Discord Connection Issues](#-discord-connection-issues)
- [Command Issues](#-command-issues)
- [Voice Channel Issues](#-voice-channel-issues)
- [Database Issues](#-database-issues)
- [Configuration Issues](#-configuration-issues)
- [Performance Issues](#-performance-issues)

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
docker-compose logs -f bot
```

**Common causes:**

1. **Database not ready:**
   - Wait 30 seconds for MongoDB to initialize
   - Check MongoDB status: `docker-compose ps`

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

### "docker-compose: command not found"

**Solutions:**

1. **Install Docker Compose:**

   ```bash
   # Linux
   sudo apt-get install docker-compose
   
   # macOS (via Homebrew)
   brew install docker-compose
   
   # Or use Docker Desktop (includes compose)
   ```

2. **Use `docker compose` (without dash):**

   ```bash
   docker compose up -d
   ```

### MongoDB Container Won't Start

**Check logs:**

```bash
docker-compose logs -f mongodb
```

**Solutions:**

1. **Remove corrupted volume:**

   ```bash
   docker-compose down -v
   docker-compose up -d
   ```

2. **Check disk space:**

   ```bash
   df -h
   ```

3. **Verify MongoDB image:**

   ```bash
   docker pull mongo:latest
   docker-compose up -d --force-recreate
   ```

---

## 📡 Discord Connection Issues

### Bot Appears Offline

**Verify:**

1. **Check bot is running:**

   ```bash
   docker-compose ps
   ```

2. **Check logs for connection errors:**

   ```bash
   docker-compose logs -f bot | grep -i "error\|discord"
   ```

3. **Verify Discord token:**
   - Token must be from the "Bot" section, not "OAuth2"
   - Token should start with your bot's user ID

4. **Check Discord API status:**
   - Visit [Discord Status](https://discordstatus.com)

### Invalid Token Error

**Symptoms:**

```json
Error: An invalid token was provided
```

**Solutions:**

1. **Reset your bot token:**
   - Discord Developer Portal → Your App → Bot
   - Reset Token → Copy new token
   - Update `.env` file
   - Restart bot: `docker-compose restart bot`

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

```json
   https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=8&scope=bot%20applications.commands
   ```

   Replace `YOUR_CLIENT_ID` with your actual Client ID.

1. **Check role hierarchy:**
   - Bot's role must be ABOVE roles it needs to manage
   - Move bot's role higher in Server Settings → Roles

2. **Verify required permissions:**
   - Administrator (easiest, or:)
   - Manage Channels
   - Move Members
   - Send Messages
   - Use Slash Commands

---

## ⚡ Command Issues

### Commands Don't Appear in Discord

**Most common issue!**

**Solutions:**

1. **Enable the command:**

   ```bash
   /config set key:ping.enabled value:true
   ```

2. **Reload commands (REQUIRED!):**

   ```bash
   /config reload
   ```

3. **Wait for Discord to sync:**
   - Can take 2-5 minutes
   - Try in a different channel
   - Restart Discord client

4. **Check if commands are enabled:**

   ```bash
   /config list
   ```

### "Application did not respond" Error

**Causes:**

- Bot is processing but taking too long
- Bot crashed during command execution
- Network issues

**Solutions:**

1. **Check bot logs:**

   ```bash
   docker-compose logs -f bot | tail -50
   ```

2. **Restart bot:**

   ```bash
   docker-compose restart bot
   ```

3. **Check MongoDB connection:**

   ```bash
   docker-compose logs mongodb | grep -i error
   ```

### `/config` Command Not Working

**Solutions:**

1. **Verify you have Administrator permission** in Discord

2. **Check bot logs for errors:**

   ```bash
   docker-compose logs -f bot | grep -i config
   ```

3. **Verify MongoDB is connected:**

   ```bash
   /dbtrunk status
   ```

---

## 🎙 Voice Channel Issues

### Lobby Channel Not Creating Users' Rooms

**Check configuration:**

```bash
/config get key:voicechannels.enabled
/config get key:voicechannels.category.name
```

**Solutions:**

1. **Enable voice channels:**

   ```bash
   /config set key:voicechannels.enabled value:true
   /config reload
   ```

2. **Run lobby setup:**

   ```bash
   /setup-lobby
   ```

3. **Verify category exists:**
   - Create category in Discord: "Voice Channels"
   - Match exact name in config
   - Bot role must have permissions in category

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

1. **Manual cleanup:**

   ```bash
   /vc reload
   ```

2. **Force cleanup:**

   ```bash
   /vc force-reload
   ```

   ⚠️ **Warning:** Removes ALL unmanaged channels!

3. **Check bot logs:**

   ```bash
   docker-compose logs -f bot | grep -i "voice"
   ```

### Voice Tracking Not Working

**Check configuration:**

```bash
/config get key:voicetracking.enabled
```

**Solutions:**

1. **Enable tracking:**

   ```bash
   /config set key:voicetracking.enabled value:true
   /config reload
   ```

2. **Check excluded channels:**

   ```bash
   /config get key:voicetracking.excluded_channels
   ```

3. **Verify users are in voice channels:**
   - Stats only update while users are active
   - Check if channel is excluded

4. **Check database:**

   ```bash
   /dbtrunk status
   ```

### `/vctop` Shows "No data"

**Causes:**

- Tracking recently enabled (no data yet)
- All channels are excluded
- Users haven't been in voice yet

**Solutions:**

1. **Wait for data to accumulate:**
   - Join a voice channel for a few minutes
   - Run `/vcstats` to verify tracking

2. **Check excluded channels:**

   ```bash
   /config get key:voicetracking.excluded_channels
   ```

3. **Verify tracking is enabled:**

   ```bash
   /config list
   ```

   Check `voicetracking.enabled: true`

---

## 💾 Database Issues

### "MongoDB connection timeout"

**Solutions:**

1. **Check MongoDB container:**

   ```bash
   docker-compose ps mongodb
   ```

2. **Restart MongoDB:**

   ```bash
   docker-compose restart mongodb
   ```

3. **Check MongoDB logs:**

   ```bash
   docker-compose logs -f mongodb
   ```

4. **Verify MONGODB_URI:**

   ```bash
   cat .env | grep MONGODB_URI
   ```

   Should be: `mongodb://mongodb:27017/koolbot`

### Database Connection Refused

**Solutions:**

1. **Ensure MongoDB container is running:**

   ```bash
   docker-compose up -d mongodb
   ```

2. **Check network connectivity:**

   ```bash
   docker-compose exec bot ping mongodb
   ```

3. **Recreate containers:**

   ```bash
   docker-compose down
   docker-compose up -d
   ```

### Data Loss / Cleanup Too Aggressive

**Check retention settings:**

```bash
/config get key:voicetracking.cleanup.retention.detailed_sessions_days
```

**Adjust retention:**

```bash
# Keep detailed sessions for 90 days instead of 30
/config set key:voicetracking.cleanup.retention.detailed_sessions_days value:90

# Keep monthly summaries for 12 months
/config set key:voicetracking.cleanup.retention.monthly_summaries_months value:12

# Disable automatic cleanup
/config set key:voicetracking.cleanup.enabled value:false
```

### Database Backup and Restore

**Create a backup:**

```bash
# Backup MongoDB database to archive file
docker-compose exec mongodb mongodump --archive=/data/db/backup.archive --db=koolbot

# Copy backup to your local machine
docker cp koolbot-mongodb:/data/db/backup.archive ./koolbot-backup-$(date +%Y%m%d).archive
```

**Restore from backup:**

```bash
# Copy backup file to container
docker cp ./koolbot-backup-20240101.archive koolbot-mongodb:/data/db/restore.archive

# Restore the database
docker-compose exec mongodb mongorestore --archive=/data/db/restore.archive --db=koolbot

# Restart bot to refresh connections
docker-compose restart bot
```

**Automated backups (recommended):**

Create a cron job or scheduled task to backup regularly:

```bash
# Example: Daily backup script
#!/bin/bash
BACKUP_DIR="/path/to/backups"
DATE=$(date +%Y%m%d)
docker-compose exec mongodb mongodump --archive=/data/db/backup.archive --db=koolbot
docker cp koolbot-mongodb:/data/db/backup.archive "$BACKUP_DIR/koolbot-backup-$DATE.archive"

# Keep only last 7 days of backups
find "$BACKUP_DIR" -name "koolbot-backup-*.archive" -mtime +7 -delete
```

---

## ⚙ Configuration Issues

### "Invalid key" Error

**Cause:** Typo in configuration key

**Solution:**

1. **Check exact key name:**

   ```bash
   /config list
   ```

2. **Copy exact key from list**

3. **Use tab completion in Discord**

### Settings Not Persisting

**Check MongoDB:**

```bash
# Verify database is running
docker-compose ps mongodb

# Check bot can write to database
/config set key:ping.enabled value:true
/config get key:ping.enabled
```

**Solution:**

If database is corrupted:

```bash
# Backup first!
# 1. Backup configuration
/config export

# 2. Backup database (if possible)
docker-compose exec mongodb mongodump --archive=/data/db/backup.archive --db=koolbot
docker cp koolbot-mongodb:/data/db/backup.archive ./koolbot-backup-$(date +%Y%m%d).archive

# Reset database
docker-compose down -v
docker-compose up -d

# Restore config
/config import

# Restore database (if backup was successful)
# Replace the date with your actual backup file date (e.g., 20240101)
docker cp ./koolbot-backup-20240101.archive koolbot-mongodb:/data/db/restore.archive
docker-compose exec mongodb mongorestore --archive=/data/db/restore.archive --db=koolbot
docker-compose restart bot
```

### Can't Import Configuration

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

---

## 🚀 Performance Issues

### Bot Running Slowly

**Check resource usage:**

```bash
# View container stats
docker stats

# Check system resources
docker-compose exec bot top
```

**Solutions:**

1. **Increase Docker resources:**
   - Docker Desktop → Settings → Resources
   - Increase CPU and memory allocation

2. **Check database size:**

   ```bash
   /dbtrunk status
   ```

   Run cleanup if database is large:

   ```bash
   /dbtrunk run
   ```

3. **Optimize retention:**

   ```bash
   # Reduce retention periods to save space
   /config set key:voicetracking.cleanup.retention.detailed_sessions_days value:14
   ```

### High Memory Usage

**Normal memory usage:** 200-300 MB

**If exceeding 500 MB:**

1. **Restart bot:**

   ```bash
   docker-compose restart bot
   ```

2. **Check for memory leaks in logs:**

   ```bash
   docker-compose logs -f bot | grep -i "memory\|heap"
   ```

3. **Update to latest version:**

   ```bash
   docker-compose pull
   docker-compose up -d
   ```

---

## 🆘 Emergency Procedures

### Complete Reset

If everything is broken:

```bash
# 1. Backup configuration
/config export

# 2. Backup database
docker-compose exec mongodb mongodump --archive=/data/db/backup.archive --db=koolbot
docker cp koolbot-mongodb:/data/db/backup.archive ./koolbot-backup-$(date +%Y%m%d).archive

# 3. Stop everything
docker-compose down -v

# 4. Verify .env file
cat .env

# 5. Start fresh
docker-compose up -d

# 6. Wait for startup
sleep 30

# 7. Check logs
docker-compose logs -f bot

# 8. Restore configuration
/config import

# 9. Restore database
# Replace the date with your actual backup file date (e.g., 20240101)
docker cp ./koolbot-backup-20240101.archive koolbot-mongodb:/data/db/restore.archive
docker-compose exec mongodb mongorestore --archive=/data/db/restore.archive --db=koolbot
docker-compose restart bot
```

### Get Support

1. **Check logs first:**

   ```bash
   docker-compose logs bot > bot-logs.txt
   ```

2. **Gather information:**
   - KoolBot version: `docker-compose exec bot cat package.json | grep version`
   - Docker version: `docker --version`
   - OS: `uname -a`
   - Error messages from logs

3. **Open an issue:**
   - [GitHub Issues](https://github.com/lonix/koolbot/issues)
   - Include logs and configuration (remove sensitive data!)

---

## 📖 Related Documentation

- **[README.md](README.md)** - Bot overview and quick start
- **[COMMANDS.md](COMMANDS.md)** - Complete command reference
- **[SETTINGS.md](SETTINGS.md)** - Configuration guide

---

<div align="center">

**Still having issues?** [Open an issue on GitHub](https://github.com/lonix/koolbot/issues)

Include logs, configuration (without tokens!), and steps to reproduce.

</div>
