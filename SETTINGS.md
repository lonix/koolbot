# KoolBot Settings Reference

Complete configuration reference for all KoolBot settings. All settings can be managed through the `/config` command in Discord.

> **Important:** Most features are **disabled by default** for security. You must enable features you want to use.

---

## 📋 Table of Contents

- [Environment Variables](#-environment-variables) - Required `.env` file settings
- [Command Enablement](#-command-enablement) - Enable/disable commands
- [Voice Channel Management](#-voice-channel-management) - Dynamic channel settings
- [Voice Activity Tracking](#-voice-activity-tracking) - Track user activity
- [Voice Channel Cleanup](#-voice-channel-cleanup) - Data retention
- [Announcements](#-announcements) - Automated stats posting
- [Quote System](#-quote-system) - Quote management settings
- [Discord Logging](#-discord-logging) - Event logging to channels
- [Fun Features](#-fun-features) - Easter eggs and extras
- [Rate Limiting](#-rate-limiting) - Command spam protection
- [Configuration Management](#-configuration-management) - Using `/config` commands
- [Quick Reference](#-quick-settings-reference) - All settings table

---

## 🔐 Environment Variables

These settings **must** be configured in your `.env` file before starting the bot.

### Required Variables

```env
# Discord Bot Credentials (Required)
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_application_id_here
GUILD_ID=your_guild_id_here

# Database Connection (Required)
MONGODB_URI=mongodb://mongodb:27017/koolbot

# Environment Settings (Optional)
DEBUG=false
NODE_ENV=production
```

### How to Get Discord Credentials

1. **Go to [Discord Developer Portal](https://discord.com/developers/applications)**
2. **Create or select your application**
3. **Get your credentials:**
   - `DISCORD_TOKEN`: Bot tab → Reset Token → Copy
   - `CLIENT_ID`: General Information → Application ID
   - `GUILD_ID`: Your Discord Server → Right-click server icon → Copy ID

**Enable Developer Mode in Discord:**
User Settings → Advanced → Developer Mode (toggle on)

### MongoDB URI Examples

```env
# Docker Compose (default)
MONGODB_URI=mongodb://mongodb:27017/koolbot

# Local MongoDB
MONGODB_URI=mongodb://localhost:27017/koolbot

# MongoDB with authentication
MONGODB_URI=mongodb://username:password@host:27017/koolbot

# MongoDB Atlas (cloud)
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/koolbot
```

---

## 🎮 Command Enablement

Enable or disable individual commands. **All commands are disabled by default.**

| Setting | Default | Description |
| --- | --- | --- |
| `ping.enabled` | `false` | Enable/disable the `/ping` command |
| `amikool.enabled` | `false` | Enable/disable the `/amikool` command |
| `amikool.role.name` | `""` | Role name to check for `/amikool` verification |
| `quotes.enabled` | `false` | Enable/disable the quote system |

### Example

```bash
# Enable ping command
/config set key:ping.enabled value:true
/config reload  # Required!

# Enable amikool with role
/config set key:amikool.enabled value:true
/config set key:amikool.role.name value:"Kool Members"
/config reload
```

---

## 📣 Quote System

Configure the quote management system.

| Setting | Default | Description |
| --- | --- | --- |
| `quotes.enabled` | `false` | Enable/disable the quote system |
| `quotes.cooldown` | `60` | Seconds between quote additions (per user) |
| `quotes.max_length` | `1000` | Maximum character length for quotes |
| `quotes.add_roles` | `""` | Role IDs allowed to add quotes (comma-separated, empty = all) |
| `quotes.delete_roles` | `""` | Role IDs allowed to delete quotes (comma-separated, empty = admins only) |

### Example

```bash
# Enable quotes with restrictions
/config set key:quotes.enabled value:true
/config set key:quotes.cooldown value:120
/config set key:quotes.max_length value:500
/config set key:quotes.add_roles value:"123456789,987654321"
/config reload
```

---

## 🎙 Voice Channel Management

Dynamic voice channel creation and management.

| Setting | Default | Description |
| --- | --- | --- |
| `voicechannels.enabled` | `false` | Enable dynamic voice channel management |
| `voicechannels.category.name` | `"Voice Channels"` | Discord category name for managed channels |
| `voicechannels.lobby.name` | `"Lobby"` | Lobby channel name when bot is online |
| `voicechannels.lobby.offlinename` | `"Offline Lobby"` | Lobby channel name when bot is offline |
| `voicechannels.channel.prefix` | `"🎮"` | Prefix for user-created channels |
| `voicechannels.channel.suffix` | `""` | Suffix for user-created channels |

### Example

```bash
# Setup voice channels
/config set key:voicechannels.enabled value:true
/config set key:voicechannels.category.name value:"Voice Channels"
/config set key:voicechannels.lobby.name value:"🟢 Join Here"
/config set key:voicechannels.channel.prefix value:"🎮"
/config set key:voicechannels.channel.suffix value:"'s Room"
/config reload

# Run lobby setup
/setup-lobby
```

**Result:** User "Alice" joining creates: **🎮 Alice's Room**

---

## 📊 Voice Activity Tracking

Track user voice channel activity and generate statistics.

| Setting | Default | Description |
| --- | --- | --- |
| `voicetracking.enabled` | `false` | Enable voice channel activity tracking |
| `voicetracking.seen.enabled` | `false` | Enable `/seen` command for last-seen tracking |
| `voicetracking.excluded_channels` | `""` | Channel IDs to exclude from tracking (comma-separated) |
| `voicetracking.admin_roles` | `""` | Role names with tracking admin powers (comma-separated) |

### Example

```bash
# Enable tracking
/config set key:voicetracking.enabled value:true
/config set key:voicetracking.seen.enabled value:true

# Exclude AFK channels
/config set key:voicetracking.excluded_channels value:"123456789,987654321"

# Set admin roles
/config set key:voicetracking.admin_roles value:"Admin,Moderator"

/config reload
```

**Excluded channels** won't count toward leaderboards or statistics.

---

## ⏰ Announcements

Automated voice channel statistics announcements.

| Setting | Default | Description |
| --- | --- | --- |
| `voicetracking.announcements.enabled` | `false` | Enable weekly stats announcements |
| `voicetracking.announcements.channel` | `"voice-stats"` | Channel name or ID for announcements |
| `voicetracking.announcements.schedule` | `"0 16 * * 5"` | Cron schedule (default: Fridays 4 PM) |

### Example

```bash
# Enable weekly announcements
/config set key:voicetracking.announcements.enabled value:true
/config set key:voicetracking.announcements.channel value:"voice-stats"
/config set key:voicetracking.announcements.schedule value:"0 16 * * 5"
/config reload
```

### Cron Schedule Format

```text
* * * * *
│ │ │ │ │
│ │ │ │ └─── Day of week (0-7, Sun-Sat)
│ │ │ └───── Month (1-12)
│ │ └─────── Day of month (1-31)
│ └───────── Hour (0-23)
└─────────── Minute (0-59)
```

**Examples:**

- `0 16 * * 5` - Every Friday at 4 PM
- `0 0 * * 1` - Every Monday at midnight
- `0 12 * * *` - Every day at noon

---

## 🧹 Voice Channel Cleanup

Automatic cleanup of old tracking data with data aggregation.

| Setting | Default | Description |
| --- | --- | --- |
| `voicetracking.cleanup.enabled` | `false` | Enable automatic data cleanup |
| `voicetracking.cleanup.schedule` | `"0 0 * * *"` | Cron schedule (default: daily at midnight) |
| `voicetracking.cleanup.retention.detailed_sessions_days` | `30` | Days to keep detailed session data |
| `voicetracking.cleanup.retention.monthly_summaries_months` | `6` | Months to keep monthly summaries |
| `voicetracking.cleanup.retention.yearly_summaries_years` | `1` | Years to keep yearly summaries |

### Example

```bash
# Enable cleanup with custom retention
/config set key:voicetracking.cleanup.enabled value:true
/config set key:voicetracking.cleanup.schedule value:"0 2 * * *"
/config set key:voicetracking.cleanup.retention.detailed_sessions_days value:60
/config set key:voicetracking.cleanup.retention.monthly_summaries_months value:12
/config set key:voicetracking.cleanup.retention.yearly_summaries_years value:2
/config reload
```

**How it works:**

1. Old detailed sessions are removed after retention period
2. Data is aggregated into monthly/yearly summaries before deletion
3. Statistics are preserved even after detailed data is removed
4. Manual cleanup available with `/dbtrunk run`

---

## 📝 Discord Logging

Send bot events and logs to Discord channels.

### Startup/Shutdown Logging

| Setting | Default | Description |
| --- | --- | --- |
| `core.startup.enabled` | `false` | Enable startup/shutdown event logging |
| `core.startup.channel_id` | `""` | Channel ID for startup/shutdown logs |

### Error Logging

| Setting | Default | Description |
| --- | --- | --- |
| `core.errors.enabled` | `false` | Enable error logging |
| `core.errors.channel_id` | `""` | Channel ID for error logs |

### Cleanup Logging

| Setting | Default | Description |
| --- | --- | --- |
| `core.cleanup.enabled` | `false` | Enable cleanup operation logging |
| `core.cleanup.channel_id` | `""` | Channel ID for cleanup logs |

### Configuration Logging

| Setting | Default | Description |
| --- | --- | --- |
| `core.config.enabled` | `false` | Enable configuration change logging |
| `core.config.channel_id` | `""` | Channel ID for config logs |

### Cron Job Logging

| Setting | Default | Description |
| --- | --- | --- |
| `core.cron.enabled` | `false` | Enable scheduled task logging |
| `core.cron.channel_id` | `""` | Channel ID for cron logs |

### Example

```bash
# Enable all logging to same channel
/config set key:core.startup.enabled value:true
/config set key:core.startup.channel_id value:123456789

/config set key:core.errors.enabled value:true
/config set key:core.errors.channel_id value:123456789

/config set key:core.cleanup.enabled value:true
/config set key:core.cleanup.channel_id value:123456789

/config set key:core.config.enabled value:true
/config set key:core.config.channel_id value:123456789

/config set key:core.cron.enabled value:true
/config set key:core.cron.channel_id value:123456789
```

**Or use separate channels for organization:**

```bash
# Different channels for different log types
/config set key:core.startup.enabled value:true
/config set key:core.startup.channel_id value:111111111  # #bot-status

/config set key:core.errors.enabled value:true
/config set key:core.errors.channel_id value:222222222   # #admin-alerts

/config set key:core.cleanup.enabled value:true
/config set key:core.cleanup.channel_id value:333333333  # #bot-logs
```

---

## 🎭 Fun Features

Easter eggs and passive listeners.

| Setting | Default | Description |
| --- | --- | --- |
| `fun.friendship` | `false` | Respond to "best ship" and "worst ship" mentions |

### Example

```bash
# Enable friendship listener
/config set key:fun.friendship value:true
```

This enables passive responses when users mention "best ship" or "worst ship" in messages.

---

## 🔒 Rate Limiting

Protect your bot from command spam with global rate limiting.

| Setting | Default | Description |
| --- | --- | --- |
| `ratelimit.enabled` | `false` | Enable global rate limiting for all commands |
| `ratelimit.max_commands` | `5` | Maximum number of commands allowed per time window |
| `ratelimit.window_seconds` | `10` | Time window in seconds for rate limit tracking |
| `ratelimit.bypass_admin` | `true` | Allow administrators to bypass rate limits |

### How Rate Limiting Works

Rate limiting uses a **sliding window** approach to prevent command spam:
- Tracks the number of commands executed by each user within a time window
- When a user exceeds the limit, they receive a rate limit message
- The window slides continuously, so limits reset as old commands expire
- Administrators can bypass rate limiting (configurable)

### Example

```bash
# Enable rate limiting with default settings (5 commands per 10 seconds)
/config set key:ratelimit.enabled value:true

# Custom configuration (3 commands per 5 seconds)
/config set key:ratelimit.enabled value:true
/config set key:ratelimit.max_commands value:3
/config set key:ratelimit.window_seconds value:5

# Disable admin bypass (rate limit applies to everyone)
/config set key:ratelimit.bypass_admin value:false
```

### Rate Limit Messages

When a user is rate limited, they receive an ephemeral message like:
```
⏱️ You're using commands too quickly! Please wait 7 seconds before trying again.
```

### Use Cases

- **Public servers**: Prevent users from spamming commands
- **Bot testing**: Disable bypass for admins to test rate limiting behavior
- **Custom limits**: Adjust based on your server size and activity
- **Security**: Protect against abuse and reduce server load

---

## ⚙ Configuration Management

### Using `/config` Commands

```bash
# List all settings
/config list

# Get specific setting
/config get key:ping.enabled

# Set a value
/config set key:ping.enabled value:true

# Reset to default
/config reset key:ping.enabled

# Reload commands (required after enabling/disabling commands)
/config reload

# Export configuration
/config export

# Import configuration (attach YAML file)
/config import
```

### Value Types

The config system automatically converts values:

```bash
# Booleans
/config set key:ping.enabled value:true
/config set key:ping.enabled value:false

# Numbers
/config set key:quotes.cooldown value:120

# Strings
/config set key:voicechannels.lobby.name value:"🟢 Join Here"

# Comma-separated lists
/config set key:voicetracking.excluded_channels value:"123,456,789"
```

### Best Practices

1. **Always run `/config reload`** after enabling/disabling commands
2. **Use exact key names** - they're case-sensitive
3. **Export regularly** for backups
4. **Test changes** in development first
5. **Document custom settings** for your team

---

## 📖 Quick Settings Reference

### All Available Settings

#### Commands

- `ping.enabled` (bool, default: false)
- `amikool.enabled` (bool, default: false)
- `amikool.role.name` (string, default: "")
- `quotes.enabled` (bool, default: false)

#### Quote System

- `quotes.cooldown` (number, default: 60)
- `quotes.max_length` (number, default: 1000)
- `quotes.add_roles` (string, default: "")
- `quotes.delete_roles` (string, default: "")

#### Voice Channels

- `voicechannels.enabled` (bool, default: false)
- `voicechannels.category.name` (string, default: "Voice Channels")
- `voicechannels.lobby.name` (string, default: "Lobby")
- `voicechannels.lobby.offlinename` (string, default: "Offline Lobby")
- `voicechannels.channel.prefix` (string, default: "🎮")
- `voicechannels.channel.suffix` (string, default: "")

#### Voice Tracking

- `voicetracking.enabled` (bool, default: false)
- `voicetracking.seen.enabled` (bool, default: false)
- `voicetracking.excluded_channels` (string, default: "")
- `voicetracking.admin_roles` (string, default: "")

#### Announcements

- `voicetracking.announcements.enabled` (bool, default: false)
- `voicetracking.announcements.channel` (string, default: "voice-stats")
- `voicetracking.announcements.schedule` (string, default: "0 16 ** 5")

#### Cleanup

- `voicetracking.cleanup.enabled` (bool, default: false)
- `voicetracking.cleanup.schedule` (string, default: "0 0 ** *")
- `voicetracking.cleanup.retention.detailed_sessions_days` (number, default: 30)
- `voicetracking.cleanup.retention.monthly_summaries_months` (number, default: 6)
- `voicetracking.cleanup.retention.yearly_summaries_years` (number, default: 1)

#### Discord Logging

- `core.startup.enabled` (bool, default: false)
- `core.startup.channel_id` (string, default: "")
- `core.errors.enabled` (bool, default: false)
- `core.errors.channel_id` (string, default: "")
- `core.cleanup.enabled` (bool, default: false)
- `core.cleanup.channel_id` (string, default: "")
- `core.config.enabled` (bool, default: false)
- `core.config.channel_id` (string, default: "")
- `core.cron.enabled` (bool, default: false)
- `core.cron.channel_id` (string, default: "")

#### Fun Features

- `fun.friendship` (bool, default: false)

#### Rate Limiting

- `ratelimit.enabled` (bool, default: false)
- `ratelimit.max_commands` (number, default: 5)
- `ratelimit.window_seconds` (number, default: 10)
- `ratelimit.bypass_admin` (bool, default: true)

---

## 📚 Related Documentation

- **[README.md](README.md)** - Bot overview and quick start
- **[COMMANDS.md](COMMANDS.md)** - Complete command reference
- **[TROUBLESHOOTING.md](TROUBLESHOOTING.md)** - Common issues and solutions

---

<div align="center">

**Questions?** Check the [troubleshooting guide](TROUBLESHOOTING.md) or [open an issue](https://github.com/lonix/koolbot/issues)

</div>
