# KoolBot Commands Reference

Complete reference for all KoolBot commands with examples and detailed explanations.

> **Note:** All commands must be enabled through configuration before they appear in Discord.  
> Use `/config set key:command.enabled value:true` and then `/config reload` to enable commands.

---

## 📋 Table of Contents

- [User Commands](#-user-commands) - Available to all server members
- [Admin Commands](#-admin-commands) - Require Administrator permission
- [Configuration Management](#config) - Detailed `/config` command guide
- [Quick Command Reference](#-quick-command-reference) - Summary table

---

## 👥 User Commands

Commands available to all server members.

### `/ping`

**Description:** Check if the bot is responding and measure latency.

**Configuration:**

```bash
/config set key:ping.enabled value:true
/config reload
```

**Usage:**

```bash
/ping
```

**Response:**

```text
Pong! 🏓
Bot Latency: 45ms
API Latency: 123ms
```

**Use Cases:**

- Verify bot is online and responsive
- Check connection quality
- Troubleshoot lag issues

---

### `/help`

**Description:** Get help with KoolBot commands. Lists all available commands or shows detailed information about a specific command.

**Configuration:**

```bash
/config set key:help.enabled value:true
/config reload
```

**Usage:**

```bash
/help                    # List all commands
/help command:ping       # Get detailed help for a specific command
```

**Parameters:**

- `command` (optional) - Name of the command to get detailed help for

**Example Responses:**

```text
# List all commands
📚 KoolBot Help
✅ Enabled Commands
/ping - Check if the bot is responding and measure latency.
/help - Get help with KoolBot commands.
...

# Specific command help
📖 Help: /ping
Check if the bot is responding and measure latency.
Usage: /ping
Status: ✅ Enabled
```

**Use Cases:**

- Discover available commands
- Learn command syntax
- Check if a command is enabled
- New user onboarding

---

### `/vctop`

**Description:** View voice channel activity leaderboards showing top users by time spent.

**Configuration:**

```bash
# Requires voice tracking to be enabled
/config set key:voicetracking.enabled value:true
/config reload
```

**Usage:**

```bash
/vctop
/vctop limit:20
/vctop period:month
/vctop period:alltime limit:10
```

**Parameters:**

- `limit` (optional) - Number of users to display (1-50, default: 10)
- `period` (optional) - Time period: `week`, `month`, `alltime` (default: week)

**Example Response:**

```json
Top Voice Channel Users (week):
🥇 Alice: 24h 15m
🥈 Bob: 18h 32m
🥉 Charlie: 12h 45m
4. David: 8h 20m
5. Emma: 6h 10m
```

**Use Cases:**

- See who's most active in voice channels
- Create friendly competition
- Recognize community engagement

---

### `/vcstats`

**Description:** View your personal voice channel statistics and activity history.

**Configuration:**

```bash
# Requires voice tracking to be enabled
/config set key:voicetracking.enabled value:true
/config reload
```

**Usage:**

```bash
/vcstats
/vcstats period:month
/vcstats period:alltime
```

**Parameters:**

- `period` (optional) - Time period: `week`, `month`, `alltime` (default: week)

**Example Response:**

```json
Your Voice Channel Stats (week):
Total Time: 24h 15m
Sessions: 12
Average Session: 2h 1m
Most Active Channel: Gaming Room
```

**Use Cases:**

- Track your own voice channel usage
- See your activity trends
- Check your ranking position

---

### `/seen`

**Description:** Check when a user was last active in voice channels.

**Configuration:**

```bash
/config set key:voicetracking.enabled value:true
/config set key:voicetracking.seen.enabled value:true
/config reload
```

**Usage:**

```bash
/seen user:@Username
```

**Parameters:**

- `user` (required) - The user to look up

**Example Response:**

```json
👤 Alice was last seen:
🕐 2 hours ago
📍 In: Gaming Room
⏱️ Duration: 3h 45m
```

**Use Cases:**

- Check if someone has been online recently
- See what channel they were in
- Track member activity patterns

---

### `/quote`

**Description:** Comprehensive quote management system - add, search, like, dislike, delete, and list quotes.

**Configuration:**

```bash
/config set key:quotes.enabled value:true
/config set key:quotes.cooldown value:60
/config set key:quotes.max_length value:1000
/config reload
```

**Usage:**

```bash
/quote random                                    # Get random quote
/quote add text:"Great quote!" author:"Alice"    # Add new quote
/quote search query:"wisdom"                     # Search quotes
/quote like id:"507f1f77bcf86cd799439011"       # Like a quote
/quote dislike id:"507f1f77bcf86cd799439011"    # Dislike a quote
/quote delete id:"507f1f77bcf86cd799439011"     # Delete a quote
/quote list                                      # List quotes (5 per page)
/quote list page:2                               # List page 2 of quotes
```

**Subcommands:**

- `random` - Get a random quote from the database
- `add` - Add a new quote (requires text and author)
- `search` - Search for quotes by content (returns up to 10 matches)
- `like` - Upvote a quote by ID
- `dislike` - Downvote a quote by ID
- `delete` - Delete a quote by ID (admin or own quotes only)
- `list` - Browse all quotes with pagination (5 per page)

**Example Responses:**

```text
# Random quote
📖 "To be or not to be"
Author: @Shakespeare
Added by: @User123
👍 Likes: 15
👎 Dislikes: 2
ID: 507f1f77bcf86cd799439011

# Adding quote
✅ Quote added successfully!

# Search results
🔍 Search Results for "wisdom"
Found 3 quote(s)
1. 507f1f77bcf86cd799439011
"The only true wisdom is in knowing you know nothing"
— @Socrates (👍 10 👎 1)

# Like/Dislike
👍 Liked quote: "To be or not to be..."

# List
📚 Quote List
Page 1 of 5 (23 total quotes)
[Shows 5 quotes with IDs, content, authors, and reaction counts]
```

**Advanced Configuration:**

```bash
# Restrict who can add quotes (role IDs)
/config set key:quotes.add_roles value:"123456789,987654321"

# Restrict who can delete quotes (role IDs)
/config set key:quotes.delete_roles value:"123456789"

# Set maximum quote length
/config set key:quotes.max_length value:500

# Set cooldown between adding quotes (seconds)
/config set key:quotes.cooldown value:120
```

**Use Cases:**

- Preserve memorable server moments
- Create a community quote collection
- Search for specific quotes
- Engage with quotes through reactions
- Moderate quote content

**Permissions:**

- Everyone can view and react to quotes (if quotes.enabled is true)
- Adding quotes respects `quotes.add_roles` configuration
- Deleting quotes requires admin role or being the quote creator

---

### `/amikool`

**Description:** Check if you have a specific role (for role verification).

**Configuration:**

```bash
/config set key:amikool.enabled value:true
/config set key:amikool.role.name value:"Kool Members"
/config reload
```

**Usage:**

```bash
/amikool
```

**Example Responses:**

```text
✅ Yes, you are kool! You have the "Kool Members" role.

❌ Sorry, you don't have the "Kool Members" role.
```

**Use Cases:**

- Fun role verification
- Check membership status
- Confirm permissions

---

### `/transfer-ownership`

**Description:** Transfer ownership of your voice channel to another user.

**Configuration:**

```bash
/config set key:voicechannels.enabled value:true
/config reload
```

**Usage:**

```bash
/transfer-ownership user:@NewOwner
```

**Requirements:**

- You must be the current channel owner
- You must be in a voice channel
- Voice channel management must be enabled

**Parameters:**

- `user` (required) - The user to transfer ownership to

**Example Response:**

```text
✅ Channel ownership transferred to @NewOwner
```

**Use Cases:**

- Leave while keeping the channel active
- Delegate channel control
- Hand off to another organizer

---

## 🔧 Admin Commands

Commands that require Administrator permission in Discord.

---

### `/config`

**Description:** Comprehensive configuration management for all bot settings.

**Usage:**

```bash
/config list                              # List all settings
/config get key:ping.enabled              # Get specific setting
/config set key:ping.enabled value:true   # Set a value
/config reset key:ping.enabled            # Reset to default
/config reload                            # Reload commands to Discord
/config export                            # Export config to YAML
/config import                            # Import config from YAML (attach file)
```

**Subcommands:**

#### `/config list`

Displays all configuration settings organized by category.

**Example Response:**

```text
📋 Configuration Settings

Commands:
  ping.enabled: true
  quotes.enabled: false
  amikool.enabled: true

Voice Channels:
  voicechannels.enabled: true
  voicechannels.category.name: "Voice Channels"
  ...
```

#### `/config get`

Get the value of a specific setting.

**Parameters:**

- `key` (required) - The setting key (e.g., `ping.enabled`)

**Example:**

```bash
/config get key:voicetracking.enabled
→ voicetracking.enabled: true
```

#### `/config set`

Update a configuration value.

**Parameters:**

- `key` (required) - The setting key
- `value` (required) - The new value

**Examples:**

```bash
# Enable a feature
/config set key:ping.enabled value:true

# Set a string value
/config set key:voicechannels.lobby.name value:"🟢 Join Here"

# Set a number
/config set key:quotes.cooldown value:120

# Set comma-separated list
/config set key:voicetracking.excluded_channels value:"123,456,789"
```

#### `/config reset`

Reset a setting to its default value.

**Parameters:**

- `key` (required) - The setting key to reset

**Example:**

```bash
/config reset key:ping.enabled
→ ✅ Reset ping.enabled to default value: false
```

#### `/config reload`

Reload all commands to Discord API. **Required after enabling/disabling commands.**

**Example:**

```bash
/config reload
→ ✅ Commands reloaded successfully!
```

**When to use:**

- After enabling/disabling any command
- After changing command-related settings
- If commands don't appear in Discord

#### `/config export`

Export current configuration to a YAML file.

**Example:**

```bash
/config export
→ 📄 config-2026-01-15.yaml (attached file)
```

**Use Cases:**

- Backup configuration
- Transfer settings between instances
- Version control settings

#### `/config import`

Import configuration from a YAML file.

**Usage:**

```bash
/config import (attach YAML file)
```

**Use Cases:**

- Restore from backup
- Clone settings to new instance
- Bulk configuration updates

---

### `/vc`

**Description:** Voice channel management and cleanup tools.

**Configuration:**

```bash
/config set key:voicechannels.enabled value:true
/config reload
```

**Subcommands:**

#### `/vc reload`

Clean up empty dynamically created voice channels.

**Usage:**

```bash
/vc reload
```

**What it does:**

- Removes empty user-created channels
- Keeps channels with active users
- Preserves the lobby channel

**Example Response:**

```text
🧹 Cleaned up 3 empty voice channels
```

**Use Cases:**

- Manual cleanup of abandoned channels
- Server organization
- Free up channel slots

#### `/vc force-reload`

Force cleanup of ALL unmanaged channels in the voice category.

**Usage:**

```bash
/vc force-reload
```

**Warning:** This is destructive! It removes ALL channels except the lobby, even if they have users.

**What it does:**

- Removes ALL unmanaged channels in category
- Keeps only the lobby channel
- Does not remove manually created channels outside the category

**Example Response:**

```text
⚠️ Force cleanup completed
Removed 8 channels from Voice Channels category
```

**Use Cases:**

- Reset voice channel setup
- Fix corrupted channel states
- Emergency cleanup

---

### `/dbtrunk`

**Description:** Database cleanup management for voice tracking data.

**Configuration:**

```bash
/config set key:voicetracking.cleanup.enabled value:true
/config reload
```

**Subcommands:**

#### `/dbtrunk status`

Show cleanup service status and statistics.

**Usage:**

```bash
/dbtrunk status
```

**Example Response:**

```text
📊 Cleanup Service Status

Status: ✅ Running
Database: ✅ Connected
Schedule: Daily at 00:00

Last Cleanup: 2026-01-14 00:00:15
Sessions Removed: 1,247
Data Aggregated: 89 records

Retention Policy:
  Detailed Sessions: 30 days
  Monthly Summaries: 6 months
  Yearly Summaries: 1 year
```

**Use Cases:**

- Check cleanup status
- Verify database health
- Monitor data retention

#### `/dbtrunk run`

Manually trigger database cleanup now.

**Usage:**

```bash
/dbtrunk run
```

**What it does:**

- Removes old detailed sessions (older than retention period)
- Removes old monthly summaries
- Removes old yearly summaries
- Preserves aggregated statistics

**Example Response:**

```text
🧹 Cleanup completed successfully!

Detailed sessions removed: 1,247
Monthly summaries removed: 12
Yearly summaries removed: 1
Total space freed: 15.4 MB
Duration: 3.2 seconds
```

**Use Cases:**

- Manual cleanup between scheduled runs
- Free up database space immediately
- Test cleanup configuration

---

### `/announce-vc-stats`

**Description:** Manually trigger the weekly voice channel statistics announcement.

**Configuration:**

```bash
/config set key:voicetracking.enabled value:true
/config set key:voicetracking.announcements.enabled value:true
/config set key:voicetracking.announcements.channel value:"voice-stats"
/config reload
```

**Usage:**

```bash
/announce-vc-stats
```

**What it does:**

- Posts top voice channel users to configured channel
- Shows weekly statistics
- Includes medals for top 3 users

**Example Response (in configured channel):**

```text
📊 Weekly Voice Channel Stats

🥇 Alice: 45h 30m
🥈 Bob: 38h 15m
🥉 Charlie: 32h 20m
4. David: 28h 10m
5. Emma: 24h 45m
...

Total server voice time: 324h 15m
Active users: 47
```

**Use Cases:**

- Post stats on-demand
- Test announcement format
- Share stats outside regular schedule

**Automatic Announcements:**

```bash
# Configure automatic weekly announcements
/config set key:voicetracking.announcements.schedule value:"0 16 * * 5"
# Every Friday at 4 PM
```

---

### `/setup-lobby`

**Description:** Configure the voice channel lobby system.

**Configuration:**

```bash
/config set key:voicechannels.enabled value:true
/config reload
```

**Usage:**

```bash
/setup-lobby
```

**What it does:**

- Creates the voice category if missing
- Creates/updates the lobby channel
- Configures proper permissions
- Sets up dynamic channel creation

**Example Response:**

```text
✅ Lobby setup complete!

Category: Voice Channels
Lobby Channel: 🟢 Lobby
Status: Ready for users

Users joining the lobby will automatically get their own channel.
```

**Use Cases:**

- Initial bot setup
- Fix broken lobby configuration
- Recreate deleted channels

---

### `/exclude-channel`

**Description:** Exclude a voice channel from activity tracking.

**Configuration:**

```bash
/config set key:voicetracking.enabled value:true
/config reload
```

**Usage:**

```bash
/exclude-channel channel:#afk-channel
```

**Parameters:**

- `channel` (required) - The voice channel to exclude

**Example Response:**

```text
✅ Channel #afk-channel excluded from tracking
```

**Use Cases:**

- Exclude AFK channels
- Don't track music bot channels
- Ignore waiting rooms

**View Excluded Channels:**

```bash
/config get key:voicetracking.excluded_channels
```

**Manual Configuration:**

```bash
# Add channel IDs (comma-separated)
/config set key:voicetracking.excluded_channels value:"123456789,987654321"
```

---

### `/botstats`

**Description:** View bot performance and usage statistics.

**Usage:**

```bash
/botstats
```

**Example Response:**

```text
🤖 KoolBot Statistics

Uptime: 7 days, 14 hours, 23 minutes
Version: 0.6.0

Performance:
  Memory Usage: 245 MB
  CPU Usage: 3.2%
  Database: Connected
  Latency: 45ms

Activity:
  Guilds: 1
  Users Tracked: 347
  Voice Sessions Today: 89
  Commands Executed: 2,451

Most Used Commands:
  1. /vctop - 892 times
  2. /vcstats - 634 times
  3. /ping - 421 times
```

**Use Cases:**

- Monitor bot health
- Check resource usage
- View usage statistics
- Troubleshoot performance issues

---

## 🔒 Permission Requirements

### User Command Permissions

| Command | Permission Level | Additional Requirements |
| --- | --- | --- |
| `/ping` | Everyone | Command must be enabled |
| `/vctop` | Everyone | Voice tracking enabled |
| `/vcstats` | Everyone | Voice tracking enabled |
| `/seen` | Everyone | Voice tracking + seen enabled |
| `/quote` | Everyone* | Quotes enabled (*may be role-restricted) |
| `/amikool` | Everyone | Command enabled + role configured |
| `/transfer-ownership` | Channel Owner | Must own a voice channel |

### Admin Command Permissions

All admin commands require **Administrator** permission in Discord.

| Command | Additional Requirements |
| --- | --- |
| `/config` | Administrator permission |
| `/vc` | Administrator + voice channels enabled |
| `/dbtrunk` | Administrator + cleanup enabled |
| `/announce-vc-stats` | Administrator + tracking & announcements enabled |
| `/setup-lobby` | Administrator + voice channels enabled |
| `/exclude-channel` | Administrator + voice tracking enabled |
| `/botstats` | Administrator permission |

### Bot Permissions Required

The bot needs these Discord permissions to function:

**Essential:**

- Read Messages/View Channels
- Send Messages
- Use Slash Commands

**For Voice Features:**

- Manage Channels (create/delete voice channels)
- Move Members (move users to created channels)
- View Channel (see voice channels)
- Connect (for voice state updates)

**For Configuration:**

- Embed Links (for rich responses)
- Attach Files (for config export/import)

---

## 📚 Quick Command Reference

### User Commands Summary

```bash
/ping                               # Check bot status
/help [command]                     # Get help on commands
/vctop [period] [limit]            # Voice leaderboards
/vcstats [period]                  # Your voice stats
/seen user:@User                   # Last seen info
/quote <subcommand> [options]      # Quotes system (random, add, search, like, dislike, delete, list)
/amikool                           # Role verification
/transfer-ownership user:@User     # Transfer channel
```

### Admin Commands Summary

```bash
# Configuration
/config list                       # List all settings
/config get key:...                # Get setting value
/config set key:... value:...      # Set setting value
/config reset key:...              # Reset to default
/config reload                     # Reload commands
/config export                     # Export config
/config import                     # Import config

# Voice Management
/vc reload                         # Clean empty channels
/vc force-reload                   # Force cleanup all

# Database Management
/dbtrunk status                    # Cleanup status
/dbtrunk run                       # Run cleanup now

# Other Admin
/setup-lobby                       # Setup voice lobby
/exclude-channel channel:...       # Exclude from tracking
/announce-vc-stats                 # Post stats now
/botstats                          # Bot statistics
```

---

## 🎯 Common Workflows

### Initial Bot Setup

```bash
# 1. Enable basic commands
/config set key:ping.enabled value:true
/config reload

# 2. Setup voice channels
/config set key:voicechannels.enabled value:true
/config set key:voicechannels.category.name value:"Voice Channels"
/setup-lobby
/config reload

# 3. Enable tracking
/config set key:voicetracking.enabled value:true
/config set key:voicetracking.seen.enabled value:true
/config reload

# 4. Enable weekly announcements
/config set key:voicetracking.announcements.enabled value:true
/config set key:voicetracking.announcements.channel value:"voice-stats"
/config reload

# 5. Setup data cleanup
/config set key:voicetracking.cleanup.enabled value:true
/config reload
```

### Enable Logging

```bash
# Create channels in Discord first, then:
/config set key:core.startup.enabled value:true
/config set key:core.startup.channel_id value:YOUR_CHANNEL_ID

/config set key:core.errors.enabled value:true
/config set key:core.errors.channel_id value:YOUR_CHANNEL_ID

/config set key:core.cleanup.enabled value:true
/config set key:core.cleanup.channel_id value:YOUR_CHANNEL_ID
```

### Troubleshooting Commands Not Appearing

```bash
# 1. Check if command is enabled
/config get key:ping.enabled

# 2. Enable if needed
/config set key:ping.enabled value:true

# 3. MUST reload commands
/config reload

# 4. Wait a few minutes for Discord to sync
```

### Backup and Restore Configuration

```bash
# Backup
/config export
# Save the file somewhere safe

# Restore
/config import
# Attach the saved YAML file
```

---

## 🚨 Troubleshooting

### "Command not found" or command doesn't appear

**Solutions:**

1. Check if enabled: `/config get key:commandname.enabled`
2. Enable it: `/config set key:commandname.enabled value:true`
3. **Reload commands: `/config reload`** (Required!)
4. Wait 2-5 minutes for Discord to sync

### "Permission denied" errors

**Check:**

- Do you have Administrator permission?
- Is the bot role high enough in the hierarchy?
- Is the feature enabled in configuration?

### Voice commands not working

**Verify:**

```bash
/config get key:voicechannels.enabled
/config get key:voicetracking.enabled
```

Both should be `true`. If not:

```bash
/config set key:voicechannels.enabled value:true
/config set key:voicetracking.enabled value:true
/config reload
```

### Stats showing as empty

**Possible causes:**

- Tracking recently enabled (give it time)
- Channels are excluded
- Users not in voice channels yet

**Check excluded channels:**

```bash
/config get key:voicetracking.excluded_channels
```

---

## 📖 Related Documentation

- **[README.md](README.md)** - Bot overview and quick start
- **[SETTINGS.md](SETTINGS.md)** - Complete configuration reference
- **[TROUBLESHOOTING.md](TROUBLESHOOTING.md)** - Detailed troubleshooting guide

---

<div align="center">

**Need help?** Check the [troubleshooting guide](TROUBLESHOOTING.md) or [open an issue](https://github.com/lonix/koolbot/issues)

</div>
