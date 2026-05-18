# KoolBot Commands Reference

Complete reference for every slash command KoolBot registers with Discord.

KoolBot's slash-command surface is intentionally small. All
**day-to-day chat interaction** stays in Discord (`/ping`, `/voicestats`,
`/seen`, `/quote`, `/achievements`, `/amikool`, `/help`). All
**administration and configuration** lives in the Web UI, reached via the
single `/config` launcher.

> **Note:** Most commands must be enabled before they appear in Discord.
> Toggle them from the Web UI's **Settings** page (run `/config` to get a
> single-use sign-in link), then click **Reload commands to Discord** to
> push the registration change.

---

## 📋 Table of Contents

- [User Commands](#-user-commands)
  - [/ping](#ping)
  - [/help](#help)
  - [/voicestats](#voicestats)
  - [/seen](#seen)
  - [/achievements](#achievements)
  - [/quote](#quote)
  - [/amikool](#amikool)
- [Admin: Web UI launcher](#-admin-web-ui-launcher)
  - [/config](#config)
- [Voice Channel Control Panel](#voice-channel-control-panel)
- [Permission Requirements](#-permission-requirements)
- [Quick Command Reference](#-quick-command-reference)

---

## 👥 User Commands

Commands available to all server members. Per-command role gating can be
applied from the Web UI's **Permissions** page; without gating, the
command is open to everyone.

### `/ping`

**Description:** Check if the bot is responding and measure latency.

**Enable:** Web UI → Settings → set `ping.enabled = true` → Reload commands.

**Usage:**

```text
/ping
```

**Response:**

```text
Pong! 🏓
Bot Latency: 45ms
API Latency: 123ms
```

**Use cases:**

- Verify bot is online and responsive
- Check connection quality
- Troubleshoot lag

---

### `/help`

**Description:** Get help with KoolBot commands. Lists all available commands
or shows detailed information about a specific command.

**Note:** Core command, **always enabled**, no configuration needed.

**Usage:**

```text
/help                    # List all enabled commands
/help command:ping       # Detailed help for one command
```

**Parameters:**

- `command` (optional) — Name of the command to get detailed help for

**Example responses:**

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

---

### `/voicestats`

**Description:** Voice channel statistics and leaderboards. Combines
leaderboard (`top`) and personal stats (`user`) functionality.

**Enable:** Web UI → Settings:

- `voicetracking.enabled = true`
- `voicetracking.stats.top.enabled = true` (for `top` subcommand)
- `voicetracking.stats.user.enabled = true` (for `user` subcommand)

Then click **Reload commands to Discord**.

#### Subcommand: `top`

View voice channel activity leaderboards.

**Usage:**

```text
/voicestats top
/voicestats top limit:20
/voicestats top period:month
/voicestats top period:alltime limit:10
```

**Parameters:**

- `limit` (optional) — Number of users to display (1-50, default: 10)
- `period` (optional) — `week` / `month` / `alltime` (default: `week`)

**Example response:**

```text
Top Voice Channel Users (week):
🥇 Alice: 24h 15m
🥈 Bob: 18h 32m
🥉 Charlie: 12h 45m
4. David: 8h 20m
5. Emma: 6h 10m
```

#### Subcommand: `user`

View personal voice channel statistics for yourself or another user.

**Usage:**

```text
/voicestats user
/voicestats user user:@Alice
/voicestats user period:month
/voicestats user user:@Alice period:alltime
```

**Parameters:**

- `user` (optional) — Defaults to yourself
- `period` (optional) — `week` / `month` / `alltime` (default: `week`)

**Example response:**

```text
Voice Channel Statistics for Alice (week):
Total Time: 24h 15m
Last Seen: 2026-01-29 12:00:00

Recent Sessions:
• Gaming Room: 3h 45m
• Study Hall: 2h 15m
• Music Lounge: 1h 30m
```

---

### `/seen`

**Description:** Check when a user was last active in voice channels.

**Enable:** Web UI → Settings:

- `voicetracking.enabled = true`
- `voicetracking.seen.enabled = true`

Then reload commands.

**Usage:**

```text
/seen user:@Username
```

**Parameters:**

- `user` (required) — The user to look up

**Example response:**

```text
👤 Alice was last seen:
🕐 2 hours ago
📍 In: Gaming Room
⏱️ Duration: 3h 45m
```

---

### `/achievements`

**Description:** View earned accolades and badges from voice channel activity.

**Enable:** Web UI → Settings → `achievements.enabled = true` → Reload commands.

**Usage:**

```text
/achievements                    # View your own accolades
/achievements user:@Username     # View another user's accolades
```

**Parameters:**

- `user` (optional) — Defaults to yourself

**Example response:**

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

🦋 Social Butterfly - 15 users
Voiced with 10+ unique users
Earned: 2026-01-14

📊 Summary
Total Accolades: 4
Total Achievements: 0
```

**Available accolades:**

- 🎉 **First Steps** — First hour in voice chat
- 🎖️ **Voice Veteran** — 100 hours
- 🏅 **Voice Elite** — 500 hours
- 🏆 **Voice Master** — 1000 hours
- 👑 **Voice Legend** — 8765 hours (1 year!)
- 🏃 **Marathon Runner** — 4+ hour session
- 🦸 **Ultra Marathoner** — 8+ hour session
- 🦋 **Social Butterfly** — 10+ unique users
- 🤝 **Connector** — 25+ unique users
- 🦉 **Night Owl** — 50+ late-night hours (10 PM - 6 AM UTC)
- 🐦 **Early Bird** — 50+ early-morning hours (6 AM - 10 AM UTC)
- 🎮 **Weekend Warrior** — 100+ weekend hours
- 💼 **Weekday Warrior** — 100+ weekday hours
- 🔥 **On a Roll** — 7 consecutive days (5+ min/day)
- ⚡ **Dedicated AF** — 14 consecutive days (5+ min/day)
- 💀 **No-Lifer** — 30 consecutive days (5+ min/day)
- 🗣️ **Quotable** — Been quoted for the first time
- 📝 **Quote Master** — Added 10 quotes
- 📚 **Quote Collector** — Added 50 quotes
- 🏆 **Quote Legend** — Added 100 quotes
- ⭐ **Widely Quoted** — Been quoted 25 times
- 💫 **Quote Icon** — Been quoted 50 times
- 🔥 **Viral Quote** — Have a quote with 10+ likes

**Notes on time-based accolades:**

- Night Owl / Early Bird use **UTC**, not your local timezone
- Weekend Warrior / Weekday Warrior use UTC day-of-week

**Notifications:**

When you earn a new accolade you receive a DM (if DMs are open) and an
announcement in the configured weekly voice stats channel.

---

### `/quote`

**Description:** Add and manage memorable quotes in a dedicated bot-managed
channel. All quotes are posted in a channel where users can react with
👍/👎.

**Enable:** Web UI → Settings:

- `quotes.enabled = true`
- `quotes.channel_id = <channel-id>`
- (Optional) `quotes.cooldown`, `quotes.max_length`, `quotes.add_roles`,
  `quotes.delete_roles`

Then reload commands.

#### `/quote add`

Add a new quote.

**Usage:**

```text
/quote add text:"Great quote!" author:@Alice
```

**Parameters:**

- `text` (required) — The quote text
- `author` (required) — Who said it

**Example response:**

```text
✅ Quote added successfully and posted to the quote channel!
```

#### `/quote edit`

Edit an existing quote that you added.

**Usage:**

```text
/quote edit id:"697bdfe2808f7d245289392c" text:"Updated quote!"
/quote edit id:"697bdfe2808f7d245289392c" author:@Bob
/quote edit id:"697bdfe2808f7d245289392c" text:"New text" author:@Bob
```

**Parameters:**

- `id` (required) — Quote ID (in the quote footer)
- `text` (optional) — New quote text
- `author` (optional) — New author

**Notes:**

- You can only edit quotes that you added
- At least one of `text` or `author` must be provided

**How it works:**

1. User submits a quote via `/quote add`
2. Bot posts it as an embed in the configured quote channel
3. Bot adds 👍 / 👎 reactions
4. Users browse by scrolling the channel and vote with reactions
5. Bot cleans up unauthorized messages every few minutes

**Security:**

The bot configures the quote channel so that only the bot can post.
Users can read and react only. Unauthorized messages are removed by a
periodic cleanup job. A pinned header explains the channel's purpose
and is auto-recreated if deleted.

---

### `/amikool`

**Description:** Check if you have a specific role (fun role verification).

**Enable:** Web UI → Settings:

- `amikool.enabled = true`
- `amikool.role.name = "Kool Members"` (or whatever role you check for)

Then reload commands.

**Usage:**

```text
/amikool
```

**Example responses:**

```text
✅ Yes, you are kool! You have the "Kool Members" role.

❌ Sorry, you don't have the "Kool Members" role.
```

---

## 🔧 Admin: Web UI launcher

KoolBot has exactly one admin slash command. It does one thing: mint a
single-use sign-in link for the admin Web UI and DM it to you.

### `/config`

**Description:** Open the admin web UI. Sends you a single-use, time-limited
sign-in link via DM. Every administrative action — settings, permissions,
the setup wizard, announcements, polls, reaction roles, notices, voice
channel management, database cleanup, bot stats — happens in the Web UI.

**Permission:** Discord **Administrator** by default. `/config` is
registered with `setDefaultMemberPermissions(Administrator)`, so
Discord itself blocks non-administrators from invoking it before the
bot ever sees the interaction. To grant `/config` to non-admin roles,
override the command's permissions in Discord
(**Server Settings → Integrations → KoolBot → /config**); the Web UI's
Permissions page can only further restrict who is allowed once Discord
has admitted the interaction.

**Prerequisites:** Operator must have set `WEBUI_ENABLED=true`,
`WEBUI_BASE_URL`, and `WEBUI_SESSION_SECRET` in `.env` and restarted the
bot. See [WEBUI.md](WEBUI.md).

**Usage:**

```text
/config
```

No subcommands, no parameters.

**Behavior:**

1. Discord routes the interaction to the bot (it only does this for
   members the command's Discord-level permissions allow — Administrator
   by default; non-admin roles allowed only when an operator has added
   them via Server Settings → Integrations).
2. Bot revokes any prior unrevoked sessions you have.
3. Bot generates a single-use token bound to your Discord user ID
   (default TTL: 10 minutes; configurable via
   `WEBUI_SESSION_TTL_MINUTES`).
4. Bot DMs you a unique URL of the form
   `https://your-bot.example.com/admin/s/<token>`.
5. You open the link. The bot exchanges the token for a signed session
   cookie scoped to your user ID and redirects to `/admin/`.
6. You configure the bot in the Web UI. The session sliding window
   defaults to 30 minutes of inactivity and is hard-capped at the
   server-side TTL.
7. You end the session one of four ways:
   - Click **Finish** — server-side revoke + cookie cleared, immediate.
   - Re-run `/config` — server-side revoke of the prior session +
     fresh link minted.
   - Idle past the inactivity window or hard TTL — the next request
     rejects the cookie (the server-side row stays in MongoDB until
     it's TTL-expired or explicitly revoked).
   - Close the tab — the cookie sticks around in your browser and the
     session row stays valid in MongoDB until idle/TTL, so closing the
     tab is **not** equivalent to signing out. Click Finish if you want
     a hard end.

**Example responses:**

DM is delivered:

```text
✅ I've DMed you a single-use sign-in link. Check your direct messages.
```

DM is blocked (fallback to ephemeral reply, visible only to you):

```text
🔗 Koolbot admin sign-in link
https://bot.example.com/admin/s/9f4b...
This link is single-use and expires in about 10 minute(s).
If you did not run /config, ignore this message.
```

Web UI disabled:

```text
The web UI is disabled. Ask an operator to set WEBUI_ENABLED=true and restart the bot.
```

Missing required env vars:

```text
❌ Web UI is enabled but missing env vars: WEBUI_BASE_URL, WEBUI_SESSION_SECRET
```

**Why a launcher and not subcommands?**

The slash command surface is genuinely bad at editing long lists,
permission matrices, YAML, and structured configuration. The Web UI is
the right home for that. Keeping a single launcher means:

- No persistent OAuth setup for casual operators.
- The admin endpoint is dark unless an admin is actively configuring.
- A leaked link is useless after one redemption or after the TTL.
- Fat-fingering a setting has zero remediation cost — just close the tab.

📖 **[Web UI Guide →](WEBUI.md)**

---

## Voice Channel Control Panel

**Note:** This is not a slash command. It is the inline component-based
panel posted in a dynamically created voice channel's text chat.

**Description:** When you create a voice channel (by joining the lobby),
an interactive control panel is automatically sent to the channel's text
chat. Only you (the channel owner) can use it.

**Enable:** Web UI → Settings → `voicechannels.controlpanel.enabled = true`
(default: `true`).

**Buttons (row 1):**

- **✏️ Rename** — Rename your channel (modal)
- **🔒 Make Private / 🌐 Make Public** — Toggle privacy mode
- **👥 Invite** — Invite a user to your private channel
- **👑 Transfer** — Transfer ownership to another user in the channel

**Buttons (row 2):**

- **🔴 Go Live / ⬜ Go Offline** — Mark the channel as live with a streaming disclaimer
- **⏳ Waiting Room / 🗑️ Remove Waiting Room** — Toggle a companion waiting room

**Features:**

- Posted into the voice channel's text chat — visible to everyone with
  access to that channel; only the channel owner can interact with the
  buttons (non-owners get an ephemeral "Only the channel owner can use
  these controls" reply if they click)
- Updates dynamically as privacy / live / waiting-room state changes
- Persists until the channel is deleted
- Posted automatically every time a new channel is created

**Requirements:**

- Discord server must support text channels associated with voice channels
- `voicechannels.controlpanel.enabled` must be `true`

**Example panel:**

```text
🎮 Voice Channel Controls

Manage your voice channel: **Your Channel Name**

Privacy: 🌐 Public
🔴 LIVE

[✏️ Rename] [🔒 Make Private] [👥 Invite] [👑 Transfer]
[⬜ Go Offline] [🗑️ Remove Waiting Room]

Only the channel owner can use these controls
```

### Rename channel

Click **✏️ Rename** to open a modal where you can enter a new name. No
placeholder requirements — use any name.

### Toggle privacy

**🔒 Make Private** restricts the channel to you and invited users. **🌐
Make Public** opens it back up.

### Invite users

While the channel is private, click **👥 Invite**. The bot replies with
an ephemeral message explaining how to grant a user access:
right-click their name in Discord and **Edit Channel Permissions** for
this channel. (The button is intentionally an instructions handoff, not
an interactive user picker — Discord's per-user channel permission
panel covers the actual grant.)

### Transfer ownership

**👑 Transfer** opens a dropdown of users currently in the channel.
Pick one to hand over ownership instantly.

### Go Live

**🔴 Go Live** adds a `🔴` prefix to your channel name, posts a Terms-of-
Service disclaimer in the channel text chat, and notifies anyone joining
that the channel is live. **⬜ Go Offline** removes the prefix and
indicator.

### Waiting Room

**⏳ Waiting Room** creates a companion waiting-room channel. Joiners
land there muted; you (the owner) get a notification with a **🚪 Let In**
button to admit them. **🗑️ Remove Waiting Room** deletes it.

---

## 🔒 Permission Requirements

### User command permissions

| Command         | Permission Level | Additional Requirements                    |
| --------------- | ---------------- | ------------------------------------------ |
| `/ping`         | Everyone\*       | Command must be enabled                    |
| `/voicestats`   | Everyone\*       | Voice tracking enabled                     |
| `/achievements` | Everyone\*       | Achievements enabled                       |
| `/seen`         | Everyone\*       | Voice tracking + seen enabled              |
| `/quote`        | Everyone\*       | Quotes enabled                             |
| `/amikool`      | Everyone\*       | Command enabled + role configured          |

\* Per-command role gating can be added in the Web UI's **Permissions** page.

### Admin command permissions

| Command   | Permission                                                       |
| --------- | ---------------------------------------------------------------- |
| `/config` | Administrator (overridable in the Web UI's Permissions page)     |

### Bot permissions required

The bot needs these Discord permissions:

**Essential:**

- Read Messages / View Channels
- Send Messages
- Use Slash Commands
- Embed Links
- Attach Files

**For voice features:**

- Manage Channels (create/delete voice channels)
- Move Members (move users to created channels)
- View Channel (see voice channels)
- Connect (for voice state updates)

**For reaction roles:**

- Manage Roles (the bot's highest role must sit above any role it grants)

**For leaderboard role rewards:**

- Manage Roles (same hierarchy rule as above)

---

## 📚 Quick Command Reference

### User commands

```text
/ping                               # Check bot status
/help [command]                     # Get help on commands
/voicestats top [period] [limit]    # Voice leaderboards
/voicestats user [user] [period]    # Personal voice stats
/achievements [user]                # View earned accolades
/seen user:@User                    # Last-seen lookup
/quote add text:"..." author:@User  # Add a quote
/quote edit id:"..." [text:"..."] [author:@User]
/amikool                            # Role verification
```

### Admin command

```text
/config                             # Open the admin Web UI (DMs a sign-in link)
```

Once in the Web UI:

| Page           | Replaces (legacy slash command)                                            |
| -------------- | -------------------------------------------------------------------------- |
| Dashboard      | `/botstats`                                                                |
| Settings       | `/config list`, `get`, `set`, `reset`, `import`, `export`, `reload`        |
| Permissions    | `/permissions set/add/remove/clear/list/view`                              |
| Setup Wizard   | `/setup wizard`                                                            |
| Announcements  | `/announce create/list/delete`, `/announce-vc-stats`                       |
| Polls          | `/poll create/list/add-item/import-url/delete/delete-item/test/list-items` |
| Reaction Roles | `/reactrole create/archive/unarchive/delete/list/status`                   |
| Notices        | `/notice add/edit/delete/sync`                                             |
| Voice Channels | `/vc reload`, `/vc force-reload`                                           |
| Database       | `/dbtrunk status`, `/dbtrunk run`                                          |
| Bootstrap      | (new — read-only `.env` diagnostics)                                       |

---

## 🎯 Common Workflows

### Initial bot setup

1. Run `/config` in Discord.
2. Open the DM'd link.
3. Click **Setup Wizard** in the navigation.
4. Pick the features you want (voice channels, voice tracking, quotes,
   achievements, logging, etc.). The wizard auto-detects existing
   channels and applies the related settings for you.
5. On the **Settings** page, hit **Reload commands to Discord** if the
   wizard enabled any commands that should now appear in Discord.

### Enable a single command

1. `/config` → open the Web UI.
2. **Settings** → find `<command>.enabled`, set to `true`, save.
3. Click **Reload commands to Discord**.
4. Wait a minute or two for Discord to sync.

### Manage permissions

1. `/config` → open the Web UI.
2. **Permissions** → pick a command, pick the roles allowed to use it.
3. Save. Changes take effect immediately.

### Schedule an announcement

1. `/config` → open the Web UI.
2. **Announcements** → New announcement.
3. Pick a channel, a cron schedule (`0 9 * * *` = daily 9 AM), the
   message, and optional embed fields.
4. Save. The announcement persists across bot restarts.

### Trigger weekly voice stats now

1. `/config` → open the Web UI.
2. **Announcements** → click **Post weekly stats now**.

### Manual database cleanup

1. `/config` → open the Web UI.
2. **Database** → click **Run cleanup now**.

### Backup and restore configuration

- **Settings** page → **Export** to download a YAML file.
- **Settings** page → **Import** to upload YAML; preview the diff before
  apply. Bootstrap env vars are excluded from both directions.

### Reset a single setting

- **Settings** page → find the key → click **Reset to default**.

### Troubleshooting commands not appearing

1. Web UI → **Settings** → verify `<command>.enabled = true`.
2. Click **Reload commands to Discord**.
3. Wait 2-5 minutes for Discord to sync.

---

## 🚨 Troubleshooting

### "Command not found" or command doesn't appear

1. Web UI → **Settings** → check `<command>.enabled`.
2. Set it to `true` if needed, save.
3. **Reload commands to Discord** (required).
4. Wait 2-5 minutes.

### "Permission denied" errors

- Do you have Administrator permission (for `/config`)?
- Is the bot's role high enough in the Discord role hierarchy?
- Is the feature enabled in the Web UI's Settings page?
- For `/config`: is `WEBUI_ENABLED=true` and are the other `WEBUI_*`
  env vars set? Check the bot logs for `WebUI mounted at /admin`.

### Voice commands not working

Web UI → **Settings** → verify both:

- `voicechannels.enabled = true`
- `voicetracking.enabled = true`

Then click **Reload commands to Discord**.

### Stats showing as empty

- Tracking might have been enabled recently (give it time).
- Channels you care about might be in `voicetracking.excluded_channels`.
- Users have to actually have been in voice channels since tracking
  started.

Verify excluded channels on the Settings page.

### Magic link doesn't arrive

- DMs from server members might be disabled. The bot falls back to an
  ephemeral reply in the channel where you ran `/config` — check there.
- The bot might not have permission to DM you for other reasons. Run
  `/config` again and look at the channel reply.

### Magic link 404s when clicked

- Already used (single-use).
- Expired (default 10 minutes).
- Superseded by a newer `/config` invocation.

Run `/config` again.

See [WEBUI.md → Troubleshooting](WEBUI.md#troubleshooting) for more.

---

## 📖 Related documentation

- **[README.md](README.md)** — Bot overview and quick start
- **[WEBUI.md](WEBUI.md)** — Web UI setup, magic-link flow, reverse-proxy guidance
- **[SETTINGS.md](SETTINGS.md)** — Complete configuration reference
- **[TROUBLESHOOTING.md](TROUBLESHOOTING.md)** — General troubleshooting

---

<div align="center">

**Need help?** Check the [troubleshooting guide](TROUBLESHOOTING.md) or [open an issue](https://github.com/lonix/koolbot/issues)

</div>
