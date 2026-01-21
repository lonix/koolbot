# KoolBot Settings Reference

Complete configuration reference for all KoolBot settings. All settings can be managed through the `/config` command in Discord.

> **Important:** Most features are **disabled by default** for security. You must enable features you want to use.

---

## 📋 Table of Contents

- [Environment Variables](#-environment-variables) - Required `.env` file settings
- [Command Enablement](#-command-enablement) - Enable/disable commands
- [Setup Wizard](#-setup-wizard) - Interactive configuration system
- [Quote System](#-quote-system) - Quote management settings
- [Voice Channel Management](#-voice-channel-management) - Dynamic channel settings
- [Voice Activity Tracking](#-voice-activity-tracking) - Track user activity
- [Voice Channel Cleanup](#-voice-channel-cleanup) - Data retention
- [Announcements](#-announcements) - Automated stats posting
- [Gamification System](#-gamification-system) - Badges and achievements
- [Reaction Roles](#-reaction-roles) - Self-assignable roles via reactions
- [Discord Logging](#-discord-logging) - Event logging to channels
- [Fun Features](#-fun-features) - Easter eggs and extras
- [Rate Limiting](#-rate-limiting) - Command spam protection
- [Permissions & Access Control](#-permissions--access-control) - Role-based command access
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

## 🧙 Setup Wizard

Interactive configuration wizard for guided server setup.

| Setting | Default | Description |
| --- | --- | --- |
| `wizard.enabled` | `true` | Enable/disable the interactive setup wizard |

### About the Setup Wizard

The setup wizard (`/setup wizard`) provides an interactive, step-by-step configuration experience for new users. It:

- **Auto-detects resources** - Finds existing categories and channels
- **Validates settings** - Ensures channels exist before applying configuration
- **Guides users** - Provides explanations and suggestions for each setting
- **Bulk configuration** - Sets multiple related settings at once
- **Feature-specific** - Can configure individual features or all at once

**When to disable:**

- If you prefer manual configuration only
- To prevent accidental reconfiguration by admins
- For servers with complex custom setups

### Example

```bash
# Disable the wizard (not recommended for new users)
/config set key:wizard.enabled value:false
/config reload

# Re-enable the wizard
/config set key:wizard.enabled value:true
/config reload
```

**Note:** The wizard is **enabled by default** and is the recommended way to configure KoolBot for first-time users.

---

## 📣 Quote System

Configure the quote management system.

| Setting | Default | Description |
| --- | --- | --- |
| `quotes.enabled` | `false` | Enable/disable the quote system |
| `quotes.channel_id` | `""` | Channel ID for quote messages (empty = use command channel) |
| `quotes.cooldown` | `60` | Seconds between quote additions (per user) |
| `quotes.cleanup_interval` | `5` | Minutes between cleanup of unauthorized quote messages |
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

# Optionally set a dedicated quote channel
/config set key:quotes.channel_id value:"1234567890"
/config reload
```

**Notes:**

- `quotes.channel_id` - If set, all quotes will be posted to this channel. If empty, quotes post in the channel where the command was used.
- `quotes.cleanup_interval` - Controls how often unauthorized quote messages are cleaned up (messages from non-command sources in the quote channel).

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

### Managing Excluded Channels

**View currently excluded channels:**

```bash
/config get key:voicetracking.excluded_channels
```

**Add channels to exclusion list:**

To exclude channels, get their IDs (right-click channel → Copy ID with Developer Mode enabled) and set them as a comma-separated list:

```bash
# Exclude a single channel
/config set key:voicetracking.excluded_channels value:"123456789"

# Exclude multiple channels
/config set key:voicetracking.excluded_channels value:"123456789,987654321,555555555"
```

**Remove channels from exclusion:**

```bash
# Remove all exclusions (empty value)
/config set key:voicetracking.excluded_channels value:""

# Or manually edit the list to remove specific channels
/config set key:voicetracking.excluded_channels value:"123456789,987654321"
```

**Common channels to exclude:**

- AFK channels
- Music bot channels
- Waiting rooms
- Private/admin channels
- Temporary meeting rooms

**Excluded channels** won't count toward leaderboards or statistics.

---

## ⏰ Announcements

### Voice Channel Statistics Announcements

Automated voice channel statistics announcements.

| Setting | Default | Description |
| --- | --- | --- |
| `voicetracking.announcements.enabled` | `false` | Enable weekly stats announcements |
| `voicetracking.announcements.channel` | `"voice-stats"` | Channel name or ID for announcements |
| `voicetracking.announcements.schedule` | `"0 16 * * 5"` | Cron schedule (default: Fridays 4 PM) |

**Example:**

```bash
# Enable weekly announcements
/config set key:voicetracking.announcements.enabled value:true
/config set key:voicetracking.announcements.channel value:"voice-stats"
/config set key:voicetracking.announcements.schedule value:"0 16 * * 5"
/config reload
```

### Scheduled Announcements

Custom scheduled announcements system for automated messages.

| Setting | Default | Description |
| --- | --- | --- |
| `announcements.enabled` | `false` | Enable scheduled announcements system |

**Example:**

```bash
# Enable scheduled announcements
/config set key:announcements.enabled value:true
/config reload

# Create announcements using /announce command
/announce create cron:"0 9 * * *" channel:#general message:"Good morning!"
```

**Features:**

- Schedule custom messages to any channel
- Support for cron expressions
- Embed support with customizable colors
- Dynamic placeholders ({server_name}, {member_count}, {date}, {time}, etc.)
- Persistent across bot restarts
- Manage via `/announce` commands

**Commands:**

- `/announce create` - Create a new scheduled announcement
- `/announce list` - View all scheduled announcements
- `/announce delete` - Remove an announcement

See [Commands Documentation](COMMANDS.md#announce) for detailed usage.

---

## 🏆 Gamification System

Badge and achievement system to encourage voice channel participation.

| Setting | Default | Description |
| --- | --- | --- |
| `gamification.enabled` | `false` | Enable/disable gamification system |
| `gamification.announcements.enabled` | `true` | Include new accolades in weekly announcements |
| `gamification.dm_notifications.enabled` | `true` | Send DM to users when they earn accolades |

**Example:**

```bash
# Enable gamification
/config set key:gamification.enabled value:true
/config reload

# Disable DM notifications (keep announcements)
/config set key:gamification.dm_notifications.enabled value:false
/config reload
```

**Features:**

- **Persistent Accolades** - Permanent badges earned once and kept forever
- **13 Different Accolades** - Milestone-based, time-based, and behavior-based
- **Automatic Tracking** - Earned automatically based on voice activity
- **DM Notifications** - Users notified immediately when earning badges
- **Weekly Announcements** - New accolades announced in voice stats channel
- **View Command** - Use `/achievements` to see earned badges

**Available Accolades:**

Time Milestones:

- First Steps (1 hour)
- Voice Veteran (100 hours)
- Voice Elite (500 hours)
- Voice Master (1000 hours)
- Voice Legend (8765 hours / 1 year)

Session Length:

- Marathon Runner (4+ hour session)
- Ultra Marathoner (8+ hour session)

Social Activity:

- Social Butterfly (10+ unique users)
- Connector (25+ unique users)

Time of Day:

- Night Owl (50+ late-night hours, 10 PM - 6 AM)
- Early Bird (50+ early-morning hours, 6 AM - 10 AM)

Day of Week:

- Weekend Warrior (100+ weekend hours)
- Weekday Warrior (100+ weekday hours)

**Requirements:**

- Requires `voicetracking.enabled` to be `true`
- Accolades are checked after each voice session ends
- DMs require user to have DMs enabled for the bot

See [Achievements Command](COMMANDS.md#achievements) for usage details.

---

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

## 🎭 Reaction Roles

Self-assignable roles via message reactions. Users react to get a role and access to dedicated channels.

| Setting | Default | Description |
| --- | --- | --- |
| `reactionroles.enabled` | `false` | Enable reaction role system |
| `reactionroles.message_channel_id` | `""` | Channel ID for reaction role messages |

### Setup

```bash
# Enable reaction roles
/config set key:reactionroles.enabled value:true

# Set message channel (users react here)
/config set key:reactionroles.message_channel_id value:"1234567890"

/config reload
```

### How it Works

1. **Create a reaction role:**

```bash
/reactrole create name:"Gaming" emoji:🎮
```

1. **Bot automatically creates:**
   - A Discord role named "Gaming"
   - A category channel (visible only to role members)
   - A text channel inside the category
   - A reaction message in the configured message channel

1. **Users can:**
   - React with 🎮 to get the Gaming role
   - Gain access to the Gaming category and channels
   - Remove reaction to lose the role and access

1. **Lifecycle management:**
   - **Archive:** Disable reactions but keep role/channels (`/reactrole archive`)
   - **Unarchive:** Re-enable reactions for an archived role (`/reactrole unarchive`)
   - **Delete:** Remove everything permanently (`/reactrole delete`)

### Features

- **Automatic role assignment** - React to get the role instantly
- **Private channels** - Category visible only to role members
- **Permission management** - Bot maintains category permissions
- **Flexible lifecycle** - Archive, unarchive, or delete as needed
- **Status tracking** - List and check status of all reaction roles

### Use Cases

- **Interest groups** - Gaming, movies, music communities
- **Event participation** - Tournament sign-ups, event attendance
- **Opt-in announcements** - News, updates for specific topics
- **Activity organization** - Separate channels for different games/activities

### Commands

- `/reactrole create` - Create a new reaction role
- `/reactrole archive` - Archive a role (disable reactions)
- `/reactrole unarchive` - Unarchive a role (re-enable reactions)
- `/reactrole delete` - Delete a role and all resources
- `/reactrole list` - List all configured reaction roles
- `/reactrole status` - Check status of a specific role

See [Commands Documentation](COMMANDS.md#reactrole) for detailed usage.

### Best Practices

- Use a dedicated channel for reaction role messages (e.g., #get-roles)
- Pin reaction messages for easy access
- Choose clear, recognizable emojis
- Archive seasonal roles instead of deleting them (use unarchive to reactivate)
- Use descriptive names for roles and channels

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

```text
⏱️ You're using commands too quickly! Please wait 7 seconds before trying again.
```

### Use Cases

- **Public servers**: Prevent users from spamming commands
- **Bot testing**: Disable bypass for admins to test rate limiting behavior
- **Custom limits**: Adjust based on your server size and activity
- **Security**: Protect against abuse and reduce server load

---

## 🔐 Permissions & Access Control

**Role-Based Command Access** allows you to control which Discord roles can use specific commands. This is a **core feature** that is
always enabled.

### Key Concepts

**Command Name Format:** Command names are used directly (e.g., `quote`, `vcstats`)

**Access Logic:**

- **Multi-role support** - Commands can be assigned to multiple roles
- **OR logic** - Users need ANY of the assigned roles to execute a command
- **Admin bypass** - Administrators always have access to all commands
- **Default open** - Commands without permissions are accessible to everyone
- **Cached** - Permissions are cached in memory for performance

### How It Works

1. **No permissions set** → Everyone can use the command (except admin-only commands)
2. **Permissions set** → Only users with the specified roles can use the command
3. **Admins** → Always bypass permission checks

### Managing Permissions

Use the `/permissions` command to manage role-based access:

> **Note:** In the examples below, `command:` and `role:` represent Discord slash command option names.
> When using the command in Discord, you'll select values from dropdowns or type them in the option fields.

```bash
# Set permissions (replaces existing)
/permissions set command:quote role:@Moderator role:@VIP

# Add roles to existing permissions
/permissions add command:quote role:@Contributor

# Remove specific roles
/permissions remove command:quote role:@VIP

# View all permissions
/permissions list

# Check what a user can access
/permissions view user:@username

# Check what a role can access
/permissions view role:@Moderator

# Clear all permissions (make accessible to everyone)
/permissions clear command:quote
```

### Use Cases

**Restrict powerful commands:**

```bash
/permissions set command:dbtrunk role:@ServerAdmin
/permissions set command:vc role:@Moderator
```

**Limit resource-intensive commands:**

```bash
/permissions set command:vcstats role:@Member
/permissions set command:vctop role:@Member
```

**Create tiered access:**

```bash
# Moderators and VIPs can use quote
/permissions set command:quote role:@Moderator role:@VIP

# Anyone can see stats
# (no permissions set, default open)
```

**Audit permissions:**

```bash
/permissions list
/permissions view user:@newmember
```

### Default Behavior

The following commands are **admin-only by default** (require Administrator permission):

- `/config` - Bot configuration
- `/vc` - Voice channel management
- `/dbtrunk` - Database cleanup
- `/setup-lobby` - Initial setup
- `/permissions` - Permission management

All other commands default to accessible by everyone unless you set permissions.

### Important Notes

- **Database storage** - Permissions are stored in MongoDB
- **Single guild** - Permissions are per-guild (designed for self-hosted bots)
- **Immediate effect** - Permission changes take effect immediately
- **Role IDs** - Uses Discord role IDs internally for consistency
- **Autocomplete** - Command names have autocomplete in `/permissions` commands

### Examples

#### Example 1: Member-only commands

```bash
# Restrict voice tracking commands to Members role
/permissions set command:vcstats role:@Member
/permissions set command:vctop role:@Member
/permissions set command:seen role:@Member
```

#### Example 2: Tiered moderation

```bash
# Moderators can manage quotes
/permissions set command:quote role:@Moderator role:@Admin

# Only admins can manage voice channels
# (already admin-only by default, no action needed)
```

#### Example 3: Troubleshooting access

```bash
# User reports they can't use /vcstats
/permissions view user:@user123
# Shows: Can access 10 command(s): /ping, /help, /quote, ...
# (vcstats not in list)

# Check role permissions
/permissions view role:@Member
# Shows: Can access 15 command(s): /ping, /help, /vcstats, ...

# Solution: User needs @Member role
```

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

#### Setup Wizard

- `wizard.enabled` (bool, default: true)

#### Reaction Roles

- `reactionroles.enabled` (bool, default: false)
- `reactionroles.message_channel_id` (string, default: "")

#### Quote System

- `quotes.channel_id` (string, default: "")
- `quotes.cooldown` (number, default: 60)
- `quotes.cleanup_interval` (number, default: 5)
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
- `announcements.enabled` (bool, default: false)

#### Gamification

- `gamification.enabled` (bool, default: false)
- `gamification.announcements.enabled` (bool, default: true)
- `gamification.dm_notifications.enabled` (bool, default: true)

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
