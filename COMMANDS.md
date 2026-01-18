# KoolBot Commands Reference

Complete reference for all KoolBot commands with examples and detailed explanations.

> **Note:** All commands must be enabled through configuration before they appear in Discord.  
> Use `/config set key:command.enabled value:true` and then `/config reload` to enable commands.

---

## 📋 Table of Contents

- [User Commands](#-user-commands) - Available to all server members
- [Admin Commands](#-admin-commands) - Require Administrator permission
  - [/config](#config) - Configuration management
  - [/permissions](#permissions) - Role-based access control
  - [/vc](#vc) - Voice channel management
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

### `/achievements`

**Description:** View earned badges and achievements from voice channel activity. Displays persistent accolades earned through milestones and participation.

**Configuration:**

```bash
# Enable gamification system
/config set key:gamification.enabled value:true
/config reload
```

**Usage:**

```bash
/achievements                    # View your own achievements
/achievements user:@Username     # View another user's achievements
```

**Parameters:**

- `user` (optional) - The user to view achievements for (defaults to yourself)

**Example Response:**

```text
🏆 Alice's Achievements

🎖️ Accolades (Permanent)

🎉 First Steps - 12 hrs
Spent your first hour in voice chat
Earned: 2026-01-10

🎖️ Voice Veteran - 150 hrs
Reached 100 hours in voice chat
Earned: 2026-01-15

🏃 Marathon Runner - 6 hrs
Completed a 4+ hour voice session
Earned: 2026-01-12

🦋 Social Butterfly - 15 channels
Visited 10+ unique voice channels
Earned: 2026-01-14

📊 Summary
Total Accolades: 4
Total Achievements: 0
```

**Available Accolades:**

- 🎉 **First Steps** - Spent your first hour in voice chat
- 🎖️ **Voice Veteran** - Reached 100 hours
- 🏅 **Voice Elite** - Reached 500 hours
- 🏆 **Voice Master** - Reached 1000 hours
- 👑 **Voice Legend** - Reached 8765 hours (1 year!)
- 🏃 **Marathon Runner** - Completed a 4+ hour session
- 🦸 **Ultra Marathoner** - Completed an 8+ hour session
- 🦋 **Social Butterfly** - Visited 10+ unique channels
- 🐰 **Channel Hopper** - Visited 25+ unique channels
- 🦉 **Night Owl** - 50+ hours late night (10 PM - 6 AM)
- 🐦 **Early Bird** - 50+ hours early morning (6 AM - 10 AM)
- 🎮 **Weekend Warrior** - 100+ hours on weekends
- 💼 **Weekday Warrior** - 100+ hours on weekdays

**Notification System:**

When you earn a new accolade, you'll receive:

- A DM from the bot with details about your achievement
- Announcement in the weekly voice stats channel

**Use Cases:**

- Track your voice activity milestones
- View your collection of earned badges
- Compare achievements with friends
- Get motivated to participate more

---

### `/quote`

**Description:** Add memorable quotes to a dedicated bot-managed channel. All quotes are posted in a channel where users can react with 👍/👎.

**Configuration:**

```bash
# Enable quotes and set channel
/config set key:quotes.enabled value:true
/config set key:quotes.channel_id value:"YOUR_CHANNEL_ID"
/config set key:quotes.cooldown value:60
/config set key:quotes.max_length value:1000
/config reload
```

**Usage:**

```bash
/quote text:"Great quote!" author:"@Alice"
```

**How It Works:**

1. User submits a quote using `/quote` command
2. Bot posts the quote as an embed in the configured quote channel
3. Bot automatically adds 👍 and 👎 reactions to the message
4. Users browse quotes by scrolling through the channel
5. Users react with 👍 or 👎 to vote on quotes
6. Bot automatically cleans up any unauthorized messages (every 5 minutes)

**Security Features:**

- **Strict Permissions**: Channel is automatically configured so only the bot can post messages
- **Auto-Cleanup**: Removes any non-bot messages every 5 minutes (configurable)
- **User Access**: Users can view, read history, and add reactions only

**Example Response:**

```text
✅ Quote added successfully and posted to the quote channel!
```

**Quote Display in Channel:**

Each quote appears as an embed with:

- The quote text
- Author (mentioned user)
- Who added it
- Quote ID (in footer)
- 👍 and 👎 reactions for voting

**Advanced Configuration:**

```bash
# Restrict who can add quotes (role IDs)
/config set key:quotes.add_roles value:"123456789,987654321"

# Set maximum quote length
/config set key:quotes.max_length value:500

# Set cooldown between adding quotes (seconds)
/config set key:quotes.cooldown value:120

# Set cleanup interval (minutes, default: 5)
/config set key:quotes.cleanup_interval value:10
```

**Use Cases:**

- Preserve memorable server moments
- Create a community quote wall
- Natural browsing via channel scroll
- Engage through Discord reactions
- Simple, streamlined quote management
- Protected channel prevents spam/abuse

**Setup Steps:**

1. Create a dedicated text channel for quotes (e.g., #quotes)
2. Get the channel ID (right-click channel → Copy ID)
3. Configure: `/config set key:quotes.channel_id value:"CHANNEL_ID"`
4. Enable: `/config set key:quotes.enabled value:true`
5. Reload: `/config reload`
6. Bot will automatically set strict permissions on the channel

**Permissions:**

- Everyone can view quotes in the channel
- Everyone can add reactions to quotes
- Only bot can post messages (auto-configured)
- Adding quotes via command respects `quotes.add_roles` configuration (empty = everyone can add)

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

### `/permissions`

**Description:** Manage role-based command access control. This feature allows admins to restrict which commands can be used by
specific Discord roles.

**Command Name Format:** Command names are used directly (e.g., `quote`, `vcstats`)

**Key Features:**

- **Multi-role support** - Assign multiple roles to a single command
- **OR logic** - Users need ANY of the assigned roles to execute the command
- **Admin bypass** - Administrators always have access to all commands
- **Default open** - Commands without permissions are accessible to everyone

**Subcommands:**

#### `/permissions set`

Set command permissions (replaces any existing permissions).

> **Note:** In Discord's slash command UI, `command` and `role` are option names. Select `quote` for the **command** option
> and `@Moderator`, `@VIP`, etc. for the **role** options. The `command:value` notation in examples below represents the
> option structure, not literal text you type.

**Usage:**

```bash
/permissions set command:quote role:@Moderator
/permissions set command:quote role:@Moderator role:@VIP role:@Admin
/permissions set command:vcstats role:@Member
```

**Parameters:**

- `command` (required) - Command name (autocomplete available)
- `role1` (required) - First role that can use this command
- `role2-5` (optional) - Additional roles (up to 5 total)

**Example Response:**

```text
✅ Set permissions for `/quote` to: @Moderator, @VIP, @Admin
```

**Use Cases:**

- Restrict powerful commands to trusted roles
- Limit access to resource-intensive commands
- Create role-specific command sets

#### `/permissions add`

Add roles to existing command permissions without removing current ones.

**Usage:**

```bash
/permissions add command:quote role:@Contributor
/permissions add command:quote role:@VIP role:@Premium
```

**Parameters:**

- `command` (required) - Command name
- `role1` (required) - First role to add
- `role2-5` (optional) - Additional roles to add

**Example Response:**

```text
✅ Added roles to `/quote`: @Contributor
```

**Use Cases:**

- Incrementally expand access
- Grant access to new roles without reconfiguring

#### `/permissions remove`

Remove specific roles from command permissions.

**Usage:**

```bash
/permissions remove command:quote role:@VIP
/permissions remove command:quote role:@Moderator role:@VIP
```

**Parameters:**

- `command` (required) - Command name
- `role1` (required) - First role to remove
- `role2-5` (optional) - Additional roles to remove

**Example Response:**

```text
✅ Removed roles from `/quote`: @VIP
```

**Note:** If all roles are removed, the permission entry is deleted automatically (command becomes accessible to everyone).

**Use Cases:**

- Revoke access from specific roles
- Clean up outdated permissions

#### `/permissions clear`

Remove all permissions for a command, making it accessible to everyone.

**Usage:**

```bash
/permissions clear command:quote
/permissions clear command:vcstats
```

**Parameters:**

- `command` (required) - Command name

**Example Response:**

```text
✅ Cleared all permissions for `/quote`. It is now accessible to everyone.
```

**Use Cases:**

- Reset command to default open access
- Remove all restrictions

#### `/permissions list`

View the permission matrix showing all commands with role restrictions.

**Usage:**

```bash
/permissions list
```

**Example Response:**

```text
Command Permissions

Commands with role restrictions:

/quote
@Moderator, @VIP

/vcstats
@Member

Commands not listed are accessible to everyone.
Admins bypass all restrictions.
```

**Use Cases:**

- Audit current permissions
- Review access control setup
- Documentation and planning

#### `/permissions view`

Check what commands a specific user or role can access.

**Usage:**

```bash
/permissions view user:@username
/permissions view role:@Moderator
```

**Parameters:**

- `user` (optional) - User to check
- `role` (optional) - Role to check

**Note:** Must specify either user OR role, not both.

**Example Responses:**

```text
# View user permissions
Permissions for username#1234
Can access 12 command(s):
`/ping`, `/help`, `/quote`, `/vcstats`, ...

# View role permissions
Permissions for Moderator
Can access 15 command(s):
`/ping`, `/help`, `/quote`, `/vcstats`, `/config`, ...
```

**Use Cases:**

- Troubleshoot access issues
- Verify role permissions
- User support

**Important Notes:**

- **Always enabled** - Permissions are a core feature, no configuration needed
- **Admin commands** - Commands like `/config`, `/vc`, `/dbtrunk` automatically require Administrator permission
- **Permission inheritance** - Users inherit permissions from all their roles (OR logic)
- **Default behavior** - When no permissions are set, everyone has access (except admin-only commands)
- **Cache** - Permissions are cached for performance; changes take effect immediately

**Examples:**

```bash
# Restrict quote command to moderators and VIPs
/permissions set command:quote role:@Moderator role:@VIP

# Add contributors to the allowed list
/permissions add command:quote role:@Contributor

# Check what @user123 can access
/permissions view user:@user123

# See all permission rules
/permissions list

# Make quote accessible to everyone again
/permissions clear command:quote
```

---

### `/vc`

**Description:** Voice channel management, cleanup tools, and user customization.

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

#### `/vc customize name <pattern>`

Set a custom naming pattern for your dynamically created voice channels.

**Usage:**

```bash
/vc customize name pattern:"🎮 {username}'s Gaming Room"
/vc customize name pattern:"🎵 {username} Vibes"
/vc customize name pattern:"{username}'s Chill Zone"
```

**Parameters:**

- `pattern` (required) - Channel name template. Use `{username}` as placeholder for your display name.

**Requirements:**

- Pattern must include `{username}` placeholder
- Final channel name must be under 100 characters

**Example Response:**

```text
✅ Your channel name pattern has been set to: 🎮 {username}'s Gaming Room

Example: 🎮 Alice's Gaming Room
```

**Use Cases:**

- Personalize your voice channel names
- Match channel names to your activity (gaming, music, studying)
- Stand out with custom branding

#### `/vc customize limit <number>`

Set the user limit for your dynamically created voice channels.

**Usage:**

```bash
/vc customize limit number:5
/vc customize limit number:10
/vc customize limit number:0  # Unlimited
```

**Parameters:**

- `number` (required) - Maximum users allowed (0-99, 0 = unlimited)

**Example Response:**

```text
✅ Your channel user limit has been set to: 5 users
```

**Use Cases:**

- Control channel capacity for focused conversations
- Create intimate spaces for small groups
- Prevent overcrowding

#### `/vc customize bitrate <kbps>`

Set the audio quality (bitrate) for your dynamically created voice channels.

**Usage:**

```bash
/vc customize bitrate kbps:64   # Standard quality
/vc customize bitrate kbps:96   # High quality
/vc customize bitrate kbps:128  # Premium quality (requires server boost)
```

**Parameters:**

- `kbps` (required) - Bitrate in kilobits per second (8-384)
  - 8-64 kbps: Low quality (good for voice-only)
  - 64-96 kbps: Standard quality (recommended)
  - 96-128 kbps: High quality (clear audio)
  - 128-384 kbps: Premium quality (requires server boosts)

**Note:** Higher bitrates require server boost levels and will be automatically capped at the server's maximum.

**Example Response:**

```text
✅ Your channel bitrate has been set to: 96 kbps

Note: Higher bitrates may require server boosts and will be capped at the server's maximum.
```

**Use Cases:**

- Optimize audio quality for music listening
- Reduce bandwidth for voice-only conversations
- Maximize clarity for podcasting or streaming

#### `/vc customize reset`

Reset all your voice channel customizations to server defaults.

**Usage:**

```bash
/vc customize reset
```

**What it does:**

- Removes custom name pattern (uses default naming)
- Resets user limit to unlimited
- Resets bitrate to server default

**Example Response:**

```text
✅ All your voice channel customizations have been reset to defaults.
```

**Use Cases:**

- Return to default settings
- Fix misconfigured preferences
- Start fresh with new preferences

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

### `/announce`

**Description:** Manage scheduled announcements to automatically send messages to channels on a schedule.

**Configuration:**

```bash
/config set key:announcements.enabled value:true
/config reload
```

**Subcommands:**

#### Create a scheduled announcement

```bash
/announce create cron:"0 9 * * *" channel:#general message:"Good morning!" placeholders:true
```

**Parameters:**

- `cron` (required) - Cron schedule expression
  - `0 9 * * *` - Daily at 9 AM
  - `0 12 * * 1` - Every Monday at noon
  - `0 0 * * 0` - Every Sunday at midnight
  - `*/30 * * * *` - Every 30 minutes
- `channel` (required) - Channel to send announcements to
- `message` (required) - Message content
- `placeholders` (optional) - Enable dynamic placeholders (default: false)
- `embed_title` (optional) - Add an embed with title
- `embed_description` (optional) - Embed description
- `embed_color` (optional) - Embed color (hex code, e.g., #FF0000)

**Supported Placeholders:**

When `placeholders` is enabled, you can use:

- `{server_name}` - Server name
- `{member_count}` - Current member count
- `{date}` - Current date
- `{time}` - Current time
- `{day}` - Day of week (e.g., Monday)
- `{month}` - Month name (e.g., January)
- `{year}` - Current year

**Examples:**

```bash
# Daily morning announcement
/announce create cron:"0 9 * * *" channel:#general \
  message:"Good morning, {server_name}! We have {member_count} members!" \
  placeholders:true

# Weekly event reminder with embed
/announce create cron:"0 18 * * 5" channel:#events \
  message:"Weekly game night starting soon!" \
  embed_title:"🎮 Game Night" \
  embed_description:"Join us for games this Friday evening!" \
  embed_color:#5865F2

# Monthly server stats
/announce create cron:"0 0 1 * *" channel:#announcements \
  message:"Monthly server update for {month} {year}" \
  placeholders:true
```

#### List scheduled announcements

```bash
/announce list
```

Shows all scheduled announcements with their:

- ID
- Status (enabled/disabled)
- Channel
- Cron schedule
- Message preview

#### Delete an announcement

```bash
/announce delete id:123abc456def
```

**Parameters:**

- `id` (required) - Announcement ID from `/announce list`

**Example Response:**

```text
✅ Announcement Created

Announcement ID: `65f4a3b2c1d9e8f7a6b5c4d3`
Channel: #general
Schedule: `0 9 * * *`
Placeholders: Enabled
Message: Good morning, {server_name}!
```

**Use Cases:**

- Daily/weekly automated announcements
- Event reminders
- Server updates
- Community engagement messages
- Rule reminders
- Automated status updates

**Notes:**

- Announcements persist across bot restarts
- All times use the server's timezone
- Invalid cron expressions are rejected
- Only administrators can manage announcements

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
| `/achievements` | Everyone | Gamification enabled |
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
/achievements [user]               # View earned badges
/seen user:@User                   # Last seen info
/quote text:"..." author:"@User"   # Add quote to channel
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
/announce-vc-stats                 # Post stats now
/announce create                   # Schedule announcement
/announce list                     # View announcements
/announce delete                   # Remove announcement
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

# 5. Enable gamification system
/config set key:gamification.enabled value:true
/config reload

# 6. Setup data cleanup
/config set key:voicetracking.cleanup.enabled value:true
/config reload

# 7. Setup quote channel (optional)
/config set key:quotes.enabled value:true
/config set key:quotes.channel_id value:"YOUR_QUOTE_CHANNEL_ID"
/config reload
```

### Enable Quote Channel

```bash
# 1. Create a dedicated text channel in Discord (e.g., #quotes)
# 2. Right-click the channel → Copy ID
# 3. Configure the bot:
/config set key:quotes.enabled value:true
/config set key:quotes.channel_id value:"YOUR_CHANNEL_ID"
/config reload

# 4. Test it
/quote text:"Hello World!" author:"@YourName"
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
