# KoolBot Settings Reference

Complete configuration reference for all KoolBot settings.

> **Important:** KoolBot has a **two-tier** configuration model.
>
> - **Bootstrap settings** live in `.env`. Edit the file on the host and
>   restart the bot to apply. The Web UI surfaces these read-only on its
>   **Bootstrap** page; they are never editable from the browser.
> - **Feature settings** live in MongoDB and are edited exclusively
>   through the **Web UI**'s Settings, Permissions, Setup Wizard, and
>   per-feature pages. Run `/config` in Discord to get a single-use
>   sign-in link.
>
> Legacy `/config set` / `/permissions add` / `/setup wizard` etc. slash
> commands have been removed — the Web UI is the only admin surface.
> See [WEBUI.md](WEBUI.md).
>
> **Important:** Most features are **disabled by default** for safety.
> Turn them on from the Web UI's Settings page once the bot is running.

---

## 📋 Table of Contents

- [Environment Variables](#-environment-variables) — `.env` (bootstrap, read-only in Web UI)
- [Command Enablement](#-command-enablement) — Enable/disable commands
- [Setup Wizard](#-setup-wizard)
- [Quote System](#-quote-system)
- [Notices System](#-notices-system)
- [Poll System](#️-poll-system)
- [Voice Channel Management](#-voice-channel-management)
- [Voice Activity Tracking](#-voice-activity-tracking)
- [Voice Channel Cleanup](#-voice-channel-cleanup)
- [Announcements](#-announcements)
- [Achievements System](#-achievements-system)
- [Reaction Roles](#-reaction-roles)
- [Leaderboard Role Rewards](#-leaderboard-role-rewards)
- [Discord Logging](#-discord-logging)
- [Fun Features](#-fun-features)
- [Rate Limiting](#-rate-limiting)
- [Permissions & Access Control](#-permissions--access-control)
- [Configuration Management](#-configuration-management) — Using the Web UI
- [Quick Reference](#-quick-settings-reference) — All settings table

---

## 🔐 Environment Variables

These settings live in `.env` only. Editing them requires editing the
file on the host and restarting the bot. The Web UI's **Bootstrap** page
surfaces them read-only for diagnostics, with secrets masked to the last
4 characters.

### Required for the bot itself

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

### Required when the Web UI is enabled

```env
# Master switch — when true, /admin/* is mounted
WEBUI_ENABLED=true

# Public URL the DM'd sign-in link points at (no trailing slash needed)
WEBUI_BASE_URL=https://bot.example.com

# HMAC key for tokens and cookies — generate with `openssl rand -base64 32`
WEBUI_SESSION_SECRET=replace-me

# Optional tuning (defaults shown)
WEBUI_SESSION_TTL_MINUTES=10
WEBUI_INACTIVITY_TIMEOUT_MINUTES=30

# Reverse proxy hop count (set to 1 when running behind Caddy/nginx/Traefik)
# WEBUI_TRUST_PROXY=1
```

See [WEBUI.md → Bootstrap environment variables](WEBUI.md#bootstrap-environment-variables)
for full descriptions and threat-model notes.

### How to get Discord credentials

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create or select your application
3. Get your credentials:
   - `DISCORD_TOKEN`: Bot tab → Reset Token → Copy
   - `CLIENT_ID`: General Information → Application ID
   - `GUILD_ID`: Right-click your server icon in Discord → Copy ID

**Enable Developer Mode in Discord:** User Settings → Advanced → Developer Mode (toggle on)

### MongoDB URI examples

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

### Bootstrap diagnostics

Inside the Web UI, the **Bootstrap** page shows whether each env var is
configured. Secrets are masked (e.g. `DISCORD_TOKEN ✓ ...x9F2`). You
can verify the process picked up the values you set without having to
shell into the container.

---

## 🎮 Command Enablement

Enable or disable individual commands from the Web UI's **Settings**
page. **All commands are disabled by default.**

| Setting | Default | Description |
| --- | --- | --- |
| `ping.enabled` | `false` | Enable/disable the `/ping` command |
| `amikool.enabled` | `false` | Enable/disable the `/amikool` command |
| `amikool.role.name` | `""` | Role name to check for `/amikool` verification |
| `quotes.enabled` | `false` | Enable/disable the quote system |

After changing any `*.enabled` value, click **Reload commands to
Discord** on the Settings page so Discord picks up the change.

---

## 🧙 Setup Wizard

Interactive guided configuration for new operators.

| Setting | Default | Description |
| --- | --- | --- |
| `wizard.enabled` | `true` | Enable/disable the Setup Wizard page |

The wizard is the **Setup Wizard** page inside the Web UI. It:

- Auto-detects existing Discord resources (categories, channels)
- Walks you through each feature step by step
- Validates settings (channels must exist, etc.) before applying
- Sets multiple related settings in one click

**When to disable:** if you prefer to edit settings directly on the
Settings page, or want to keep the wizard out of the navigation for an
already-configured deployment. The wizard is on by default for new
installs.

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
| `quotes.header_enabled` | `true` | Show informational header post in quote channel |
| `quotes.header_pin_enabled` | `true` | Pin the header post for easy access |
| `quotes.header_message_id` | `""` | Stores header message ID (managed automatically) |

**Notes:**

- `quotes.channel_id` — If set, all quotes are posted to this channel.
  If empty, quotes post in the channel where the command was used.
- `quotes.cleanup_interval` — Controls how often unauthorized messages
  in the quote channel are removed.
- `quotes.header_enabled` — Displays a pinned informational header.
  Auto-recreated if deleted.
- `quotes.header_pin_enabled` — Controls whether the header is pinned.
- `quotes.header_message_id` — Managed by the bot.

---

## 📋 Notices System

Bot-managed protected channel for server notices, rules, and help
information. Notice content (titles, bodies, categories, order) is
managed on the Web UI's **Notices** page; the settings below control
the channel itself.

| Setting | Default | Description |
| --- | --- | --- |
| `notices.enabled` | `false` | Enable/disable the notices system |
| `notices.channel_id` | `""` | Channel ID for notice messages |
| `notices.cleanup_interval` | `5` | Minutes between cleanup of unauthorized messages |
| `notices.header_enabled` | `true` | Show informational header post in notices channel |
| `notices.header_pin_enabled` | `true` | Pin the header post for easy access |
| `notices.header_message_id` | `""` | Stores header message ID (managed automatically) |

**Features:**

- **Bot-only channel** — Only bot can post; users can only read
- **Auto-cleanup** — Removes unauthorized messages every 5 minutes
- **Persistent** — Notices stored in MongoDB, survive bot restarts
- **Organized** — Sort by category (Rules, Info, Help, Game Servers, General)
- **Custom order** — Control display order with the `order` field on each notice
- **Rich embeds** — Each notice displayed as a formatted embed with color-coded category

**Notice categories:**

- **General** (📋) — General server information
- **Rules** (📜) — Server rules and guidelines
- **Information** (ℹ️) — Important server info
- **Help** (❓) — Bot feature help and guides
- **Game Servers** (🎮) — Game server connection info

CRUD operations (add, edit, delete, sync) happen on the Web UI's
**Notices** page.

---

## 🗳️ Poll System

Periodic Discord native polls. Poll questions and schedules are managed
on the Web UI's **Polls** page; the settings below are global defaults.

| Setting | Default | Description |
| --- | --- | --- |
| `polls.enabled` | `false` | Enable/disable the poll system |
| `polls.default_duration_hours` | `24` | Default poll duration (1-768, max 32 days) |
| `polls.cooldown_days` | `7` | Minimum days before reusing the same poll question |

**Features:**

- **Native polls** — Discord's built-in poll feature
- **Scheduled posting** — Cron-driven automatic polls
- **URL import** — Fetch poll questions from YAML or JSON files
- **Smart rotation** — Avoids repeating polls within the cooldown
- **Database storage** — Local library of poll questions
- **Role pinging** — Optional role mention when posting
- **Multi-select support** — Polls can accept multiple selections

**URL formats:**

```yaml
polls:
  - question: "What's your favorite programming language?"
    answers: ["JavaScript", "Python", "Go", "Rust"]
    multiselect: false
    tags: ["tech", "icebreaker"]
```

```json
{
  "polls": [
    {
      "question": "What's your favorite season?",
      "answers": ["Spring", "Summer", "Fall", "Winter"],
      "multiselect": false,
      "tags": ["general"]
    }
  ]
}
```

Schedule CRUD and question CRUD live on the Polls page.

**Smart poll selection:**

1. Excludes polls used within the cooldown
2. Prioritizes lower usage counts
3. Random selection from the top 20% least-used eligible polls
4. Fallback to the oldest-used poll if all are within cooldown

**Notes:**

- Poll questions must have 2-10 answer options (Discord limitation)
- Questions limited to 300 characters (Discord limitation)
- Polls can run for 1 hour to 32 days (768 hours)
- URL import copies all polls to the database for local management

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
| `voicechannels.controlpanel.enabled` | `true` | Show interactive control panel in channel text chat |
| `voicechannels.ownership.grace_period_seconds` | `30` | Grace period before transferring ownership when owner disconnects |

### Ownership grace period

When a channel owner disconnects (e.g., network issue, client restart),
the bot waits for the grace period before transferring ownership. If
the owner rejoins within this time, they retain ownership.

**Recommended values:**

- `30` (default) — Good balance for most servers
- `60` — Servers with frequent connection issues
- `10` — For faster ownership transfers

### Manual cleanup

Out-of-schedule channel cleanup runs from the Web UI's **Voice Channels**
page (replaces the old `/vc reload` and `/vc force-reload`).

---

## 📊 Voice Activity Tracking

Track user voice channel activity and generate statistics.

| Setting | Default | Description |
| --- | --- | --- |
| `voicetracking.enabled` | `false` | Enable voice channel activity tracking |
| `voicetracking.stats.top.enabled` | `false` | Enable `/voicestats top` subcommand |
| `voicetracking.stats.user.enabled` | `false` | Enable `/voicestats user` subcommand |
| `voicetracking.seen.enabled` | `false` | Enable `/seen` command for last-seen tracking |
| `voicetracking.excluded_channels` | `""` | Channel IDs to exclude from tracking (comma-separated) |
| `voicetracking.admin_roles` | `""` | Role names with tracking admin powers (comma-separated) |

### Managing excluded channels

Right-click each channel in Discord and **Copy ID** (with Developer Mode
enabled), then set `voicetracking.excluded_channels` on the Web UI's
Settings page as a comma-separated list:

```text
123456789012345678,987654321098765432
```

**Common candidates to exclude:**

- AFK channels
- Music bot channels
- Waiting rooms
- Private / admin channels
- Temporary meeting rooms

Excluded channels won't count toward leaderboards or statistics.

---

## ⏰ Announcements

### Voice channel statistics announcements

Automated weekly voice channel statistics post.

| Setting | Default | Description |
| --- | --- | --- |
| `voicetracking.announcements.enabled` | `false` | Enable weekly stats announcements |
| `voicetracking.announcements.channel` | `"voice-stats"` | Channel name or ID for announcements |
| `voicetracking.announcements.schedule` | `"0 16 * * 5"` | Cron schedule (default: Fridays 4 PM) |

To trigger one out of schedule, use the **Post weekly stats now** button
on the Web UI's Announcements page (replaces the old
`/announce-vc-stats`).

### Scheduled announcements

Custom scheduled announcements (managed on the Web UI's **Announcements**
page).

| Setting | Default | Description |
| --- | --- | --- |
| `announcements.enabled` | `false` | Enable scheduled announcements system |

**Features:**

- Schedule custom messages to any channel
- Cron expressions for the schedule
- Embed support with customizable colors
- Dynamic placeholders (`{server_name}`, `{member_count}`, `{date}`,
  `{time}`, `{day}`, `{month}`, `{year}`)
- Persistent across bot restarts

CRUD operations happen on the Announcements page.

---

## 🏆 Achievements System

Persistent accolade system to encourage voice channel participation.

| Setting | Default | Description |
| --- | --- | --- |
| `achievements.enabled` | `false` | Enable/disable achievements system |
| `achievements.announcements.enabled` | `true` | Include new accolades in weekly announcements |
| `achievements.dm_notifications.enabled` | `true` | Send DM to users when they earn accolades |

**Features:**

- **Persistent accolades** — Permanent badges earned once and kept forever
- **22+ different accolades** — Time milestones, session length, social,
  time-of-day, day-of-week, streak, quote-related
- **Automatic tracking** — Earned automatically based on voice activity
- **DM notifications** — Users notified immediately when earning badges
- **Weekly announcements** — New accolades announced in voice stats channel
- **View command** — Use `/achievements` to see earned badges

**Notes:**

- Time-based accolades (Night Owl, Early Bird, Weekend Warrior, Weekday
  Warrior) use **UTC** timezone, not the user's local time.
- Weekend / weekday determination uses UTC day of week.

**Requirements:**

- Requires `voicetracking.enabled = true`
- Accolades are checked after each voice session ends
- DMs require the user to have DMs enabled for the bot
- **For consecutive-days accolades:** keep
  `voicetracking.cleanup.retention.detailed_sessions_days` at **60 days
  or higher** to preserve enough streak history for the 30-day
  "No-Lifer" badge.

See [COMMANDS.md → /achievements](COMMANDS.md#achievements) for the full
accolade list and usage.

---

### Cron schedule format

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

- `0 16 * * 5` — Every Friday at 4 PM
- `0 0 * * 1` — Every Monday at midnight
- `0 12 * * *` — Every day at noon
- `*/30 * * * *` — Every 30 minutes

---

## 🎭 Reaction Roles

Self-assignable roles via message reactions. Users react to a message
to get a role and access to a dedicated category. Role CRUD happens on
the Web UI's **Reaction Roles** page.

| Setting | Default | Description |
| --- | --- | --- |
| `reactionroles.enabled` | `false` | Enable reaction role system |
| `reactionroles.message_channel_id` | `""` | Channel ID where reaction-role messages are posted |

### How it works

1. Create a reaction role on the Web UI's Reaction Roles page (specify a
   name and emoji).
2. The bot creates:
   - A Discord role with the specified name
   - A category visible only to role members
   - A text channel inside the category
   - A reaction message in `reactionroles.message_channel_id`
3. Users react with the emoji to get the role; remove the reaction to
   lose it.
4. The Web UI lets you **Archive** (disable reactions but keep the role
   and channels), **Unarchive** (re-enable), or **Delete** (remove
   everything).

### Use cases

- Interest groups (Gaming, Movies, Music)
- Event participation (tournament sign-ups)
- Opt-in announcements (news, updates)
- Activity organization (separate channels per game/activity)

### Best practices

- Use a dedicated channel for reaction-role messages (e.g. `#get-roles`)
- Pin the reaction messages for easy access
- Choose clear, recognizable emojis
- Archive seasonal roles instead of deleting them

---

## 🏅 Leaderboard Role Rewards

Auto-assign Discord roles based on each user's position on the
voice-channel leaderboard. A cron job recalculates assignments on a
schedule; users who fall out of a tier lose the role automatically.

| Setting | Default | Description |
| --- | --- | --- |
| `leaderboard_roles.enabled` | `false` | Enable/disable auto-assignment |
| `leaderboard_roles.period` | `alltime` | Leaderboard period: `week`, `month`, or `alltime` |
| `leaderboard_roles.update_cron` | `0 0 * * 1` | Cron schedule for recalculation (default: Mondays 00:00) |
| `leaderboard_roles.tiers` | `""` | Comma-separated `topN:roleId` pairs (e.g. `1:111,3:222,10:333`) |
| `leaderboard_roles.announcement_channel_id` | `""` | Optional channel ID for role-change announcements (empty disables) |

### Tier configuration

Tiers are admin-defined — there is no built-in "top 1 / top 3 / top 10".
You pick any positions you want to reward and which role each one
grants. The format is a comma-separated list of `topN:roleId` pairs:

```text
leaderboard_roles.tiers = "1:111111111111111111,3:222222222222222222,10:333333333333333333"
```

A user at rank #1 receives all three roles; rank #2 or #3 receives the
latter two; rank #4–#10 receives only the third. Each tier is
independent.

Invalid entries (non-numeric `topN`, non-snowflake role ID, malformed
syntax) are logged and skipped — they don't stop the rest of the
configuration from applying.

**Notes:**

- The bot must have **Manage Roles** permission and its highest role
  must sit above the reward roles in the hierarchy.
- Role assignments are tracked in MongoDB so the bot can revoke a role
  from a user even after a restart, without requiring the privileged
  `GuildMembers` intent.
- The announcement embed only posts when there's at least one add or
  remove in a run.

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

**How it works:**

1. Old detailed sessions are removed after the retention period
2. Data is aggregated into monthly / yearly summaries before deletion
3. Statistics are preserved even after detailed data is removed
4. Manual cleanup runs from the Web UI's **Database** page (replaces
   the old `/dbtrunk run`)

⚠️ **Important for consecutive-days accolades:**

The cleanup job deletes session history older than
`detailed_sessions_days`. This affects consecutive-day streak
calculations:

- **Default retention (30 days):** supports streaks up to ~25 days
- **For 30-day "No-Lifer" accolade:** raise retention to at least **60
  days**
- **Formula:** retention ≥ longest streak × 2

---

## 📝 Discord Logging

Send bot events and logs to Discord channels.

### Startup / shutdown logging

| Setting | Default | Description |
| --- | --- | --- |
| `core.startup.enabled` | `false` | Enable startup/shutdown event logging |
| `core.startup.channel_id` | `""` | Channel ID for startup/shutdown logs |

### Error logging

| Setting | Default | Description |
| --- | --- | --- |
| `core.errors.enabled` | `false` | Enable error logging |
| `core.errors.channel_id` | `""` | Channel ID for error logs |

### Cleanup logging

| Setting | Default | Description |
| --- | --- | --- |
| `core.cleanup.enabled` | `false` | Enable cleanup operation logging |
| `core.cleanup.channel_id` | `""` | Channel ID for cleanup logs |

### Configuration logging

| Setting | Default | Description |
| --- | --- | --- |
| `core.config.enabled` | `false` | Enable configuration change logging |
| `core.config.channel_id` | `""` | Channel ID for config logs |

### Cron job logging

| Setting | Default | Description |
| --- | --- | --- |
| `core.cron.enabled` | `false` | Enable scheduled task logging |
| `core.cron.channel_id` | `""` | Channel ID for cron logs |

You can point every category at the same channel for a consolidated log,
or split them across `#bot-status`, `#admin-alerts`, `#bot-logs`, etc.

---

## 🎭 Fun Features

Easter eggs and passive listeners.

| Setting | Default | Description |
| --- | --- | --- |
| `fun.friendship` | `false` | Respond to "best ship" and "worst ship" mentions |

---

## 🔒 Rate Limiting

Protect your bot from command spam with global rate limiting.

| Setting | Default | Description |
| --- | --- | --- |
| `ratelimit.enabled` | `false` | Enable global rate limiting for all commands |
| `ratelimit.max_commands` | `5` | Maximum number of commands allowed per time window |
| `ratelimit.window_seconds` | `10` | Time window in seconds for rate limit tracking |
| `ratelimit.bypass_admin` | `true` | Allow administrators to bypass rate limits |

Rate limiting uses a sliding window. When a user exceeds the limit, they
receive an ephemeral message like:

```text
⏱️ You're using commands too quickly! Please wait 7 seconds before trying again.
```

---

## 🔐 Permissions & Access Control

Per-command role gating. Manage permissions on the Web UI's
**Permissions** page (replaces the old `/permissions set/add/remove/clear/list/view`).

### Key concepts

- **Multi-role support** — Commands can be assigned to multiple roles
- **OR logic** — Users need ANY of the assigned roles to execute a command
- **Admin bypass** — Administrators always have access to all commands
- **Default open** — Commands without permissions are accessible to everyone
- **Cached** — Permissions are cached in memory for performance

### How it works

1. **No permissions set** → Everyone can use the command (except
   admin-only commands like `/config`).
2. **Permissions set** → Only users with the specified roles can use it.
3. **Admins** → Always bypass permission checks.

### Default behavior

These commands are **admin-only** by default:

- `/config` — opens the Web UI

The Web UI itself also requires that the user can run `config` (admin
by default, overridable via the Permissions page).

All other commands default to accessible by everyone unless you add
permissions.

---

## ⚙ Configuration Management

### Editing settings

All DB-backed settings are edited on the Web UI's **Settings** page.
The Settings page groups settings by feature, validates input per
schema, and shows inline help. After changing any `*.enabled` value,
click **Reload commands to Discord** so Discord re-syncs the
registration.

### YAML export / import

- **Export** — Settings page → click **Export** → download YAML. Covers
  DB-backed settings only; bootstrap env vars are excluded.
- **Import** — Settings page → click **Import** → upload YAML → review
  the diff → apply. Imports that try to set a protected key
  (`DISCORD_TOKEN`, `WEBUI_SESSION_SECRET`, any other `.env` value) are
  rejected outright.

### Reset to default

For any setting, click **Reset to default** on the Settings page.

### Value types

The Web UI form controls map to the underlying schema types:

- **Booleans** — checkbox
- **Numbers** — number input with min/max validation
- **Strings** — text input
- **Comma-separated lists** — text input; you handle the commas

### Best practices

1. Always **Reload commands to Discord** after enabling/disabling commands.
2. Export regularly for backups.
3. Test changes in a development setup first when in doubt.
4. Document custom settings for your team if multiple people admin the bot.

---

## 📖 Quick Settings Reference

### All available settings (DB-backed)

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

#### Leaderboard Role Rewards

- `leaderboard_roles.enabled` (bool, default: false)
- `leaderboard_roles.period` (string, default: "alltime") — `week` / `month` / `alltime`
- `leaderboard_roles.update_cron` (string, default: `"0 0 * * 1"`)
- `leaderboard_roles.tiers` (string, default: "") — comma-separated `topN:roleId`
- `leaderboard_roles.announcement_channel_id` (string, default: "")

#### Quote System

- `quotes.channel_id` (string, default: "")
- `quotes.cooldown` (number, default: 60)
- `quotes.cleanup_interval` (number, default: 5)
- `quotes.max_length` (number, default: 1000)
- `quotes.add_roles` (string, default: "")
- `quotes.delete_roles` (string, default: "")
- `quotes.header_enabled` (bool, default: true)
- `quotes.header_pin_enabled` (bool, default: true)

#### Notices

- `notices.enabled` (bool, default: false)
- `notices.channel_id` (string, default: "")
- `notices.cleanup_interval` (number, default: 5)
- `notices.header_enabled` (bool, default: true)
- `notices.header_pin_enabled` (bool, default: true)

#### Polls

- `polls.enabled` (bool, default: false)
- `polls.default_duration_hours` (number, default: 24)
- `polls.cooldown_days` (number, default: 7)

#### Voice Channels

- `voicechannels.enabled` (bool, default: false)
- `voicechannels.category.name` (string, default: "Voice Channels")
- `voicechannels.lobby.name` (string, default: "Lobby")
- `voicechannels.lobby.offlinename` (string, default: "Offline Lobby")
- `voicechannels.channel.prefix` (string, default: "🎮")
- `voicechannels.channel.suffix` (string, default: "")
- `voicechannels.controlpanel.enabled` (bool, default: true)
- `voicechannels.ownership.grace_period_seconds` (number, default: 30)

#### Voice Tracking

- `voicetracking.enabled` (bool, default: false)
- `voicetracking.stats.top.enabled` (bool, default: false)
- `voicetracking.stats.user.enabled` (bool, default: false)
- `voicetracking.seen.enabled` (bool, default: false)
- `voicetracking.excluded_channels` (string, default: "")
- `voicetracking.admin_roles` (string, default: "")

#### Announcements

- `voicetracking.announcements.enabled` (bool, default: false)
- `voicetracking.announcements.channel` (string, default: "voice-stats")
- `voicetracking.announcements.schedule` (string, default: `"0 16 * * 5"`)
- `announcements.enabled` (bool, default: false)

#### Achievements

- `achievements.enabled` (bool, default: false)
- `achievements.announcements.enabled` (bool, default: true)
- `achievements.dm_notifications.enabled` (bool, default: true)

#### Cleanup

- `voicetracking.cleanup.enabled` (bool, default: false)
- `voicetracking.cleanup.schedule` (string, default: `"0 0 * * *"`)
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

### Bootstrap env vars (read-only in Web UI)

- `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`, `MONGODB_URI`
- `NODE_ENV`, `DEBUG`
- `WEBUI_ENABLED`, `WEBUI_BASE_URL`, `WEBUI_SESSION_SECRET`
- `WEBUI_SESSION_TTL_MINUTES`, `WEBUI_INACTIVITY_TIMEOUT_MINUTES`
- `WEBUI_TRUST_PROXY`

These are visible on the Web UI's **Bootstrap** page (secrets masked).
Edit them in `.env` and restart the bot to change them.

---

## 📚 Related Documentation

- **[README.md](README.md)** — Bot overview and quick start
- **[WEBUI.md](WEBUI.md)** — Web UI setup, magic-link flow, reverse-proxy guidance
- **[COMMANDS.md](COMMANDS.md)** — Complete command reference
- **[TROUBLESHOOTING.md](TROUBLESHOOTING.md)** — Common issues and solutions

---

<div align="center">

**Questions?** Check the [troubleshooting guide](TROUBLESHOOTING.md) or [open an issue](https://github.com/lonix/koolbot/issues)

</div>
