# KoolBot

A powerful and modular Discord bot built with TypeScript, featuring dynamic voice channel
management, activity tracking, automated announcements, and a browser-based admin Web UI.

![Discord.js](https://img.shields.io/badge/Discord.js-14.25.1-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9.3-blue)
![MongoDB](https://img.shields.io/badge/MongoDB-Latest-green)
![Docker](https://img.shields.io/badge/Docker-Ready-blue)

---

## 🚀 Quick Start (3 Steps)

KoolBot is designed for simple deployment. You only need two files to get started:

### 1. **Download Required Files**

Download these two files to a new directory:

- [`docker-compose.yml`](https://raw.githubusercontent.com/lonix/koolbot/main/docker-compose.yml)
- [`.env.example`](https://raw.githubusercontent.com/lonix/koolbot/main/.env.example)

```bash
# Create a directory for KoolBot
mkdir koolbot
cd koolbot

# Download the files
curl -O https://raw.githubusercontent.com/lonix/koolbot/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/lonix/koolbot/main/.env.example
```

Or manually download from GitHub and save to your `koolbot` directory.

### 2. **Create Your `.env` File**

```bash
cp .env.example .env
```

Edit `.env` with your Discord credentials and turn the Web UI on:

```env
# Required: Get these from Discord Developer Portal
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_application_id_here
GUILD_ID=your_guild_id_here

# MongoDB connection (leave as-is for Docker)
MONGODB_URI=mongodb://mongodb:27017/koolbot

# Web UI — the admin surface. Recommended.
WEBUI_ENABLED=true
WEBUI_BASE_URL=http://localhost:3000
WEBUI_SESSION_SECRET=replace-with-output-from-openssl-rand-base64-32

# Optional
DEBUG=false
# For local testing over plain HTTP, use NODE_ENV=development. The Web UI
# session cookie is flagged `Secure` whenever NODE_ENV=production, which
# browsers refuse over a `http://localhost` URL.
NODE_ENV=development
```

Generate a strong `WEBUI_SESSION_SECRET` by running this on your host
**before** editing the file (paste the output in as the value above —
dotenv files do not execute shell substitutions):

```bash
openssl rand -base64 32
```

**Where to get your Discord credentials:**

- Go to [Discord Developer Portal](https://discord.com/developers/applications)
- Create a new application (or select existing)
- **DISCORD_TOKEN**: Bot tab → Reset Token → Copy
- **CLIENT_ID**: General Information → Application ID
- **GUILD_ID**: Right-click your server icon in Discord → Copy ID (enable Developer Mode under User Settings → Advanced)

### 3. **Start with Docker Compose**

```bash
docker compose up -d
```

Then in Discord, run:

```text
/config
```

The bot DMs you a single-use sign-in link. Click it, configure everything in the
browser, click **Finish**.

**That's it.** Your bot is now running and configurable from a real UI. The Docker
container will:

- ✅ Automatically install dependencies
- ✅ Set up MongoDB database
- ✅ Register `/config` and `/help` with Discord (other user commands
  register only after you enable them on the Web UI's Settings page and
  click **Reload commands to Discord**)
- ✅ Mount the Web UI at `/admin` (only when `WEBUI_ENABLED=true`)
- ✅ Publish port 3000 to the host so the sign-in link is reachable
- ✅ Start the bot and keep it running

Check the logs:

```bash
docker compose logs -f bot
```

Look for `WebUI mounted at /admin` to confirm the Web UI is live.

> Need HTTPS or a real domain? See **[WEBUI.md](WEBUI.md)** for Caddy, nginx,
> Traefik, and Tailscale recipes.

---

## 📋 What's Included

### Core Features

- **🎙 Dynamic Voice Channels** — Users create their own voice channels from a lobby
- **📊 Activity Tracking** — Voice channel usage with leaderboards and statistics
- **🏆 Achievements** — Persistent accolades for milestones and participation
- **⏰ Automated Announcements** — Scheduled posts on a cron schedule
- **🗳️ Polls** — Native Discord polls posted from a question library
- **🎭 Reaction Roles** — Self-assignable roles via emoji reactions
- **📝 Notices** — Bot-managed rules / info / help / game-server channel
- **🧹 Smart Data Cleanup** — Automatic cleanup with data preservation
- **🌐 Web UI Admin** — Magic-link sign-in, no persistent OAuth setup
- **📝 Discord Logging** — Bot events logged to Discord channels
- **🎭 Quote System** — Save and retrieve memorable quotes
- **🤖 Bot Status** — Dynamic status showing bot state and user count
- **🔒 Rate Limiting** — Protect against command spam with configurable limits

### Available Commands

KoolBot ships **two** kinds of commands: user-facing chat commands, and one
admin launcher.

**User commands** (registered on demand — each one is gated by a
`*.enabled` setting in the Web UI; `/help` and `/config` are the only
commands always registered):

- `/ping` — Check bot responsiveness (`ping.enabled`)
- `/help` — Discover commands (always on)
- `/voicestats top` / `/voicestats user` — Leaderboards and personal stats (`voicetracking.enabled` + per-subcommand flag)
- `/seen` — Last-seen lookup (`voicetracking.seen.enabled`)
- `/achievements` — View earned accolades (`achievements.enabled`)
- `/quote add` / `/quote edit` — Manage memorable quotes (`quotes.enabled`)
- `/amikool` — Role verification (`amikool.enabled`)

A fresh install only sees `/help` and `/config` in Discord until you
enable the others on the Settings page and click **Reload commands to
Discord**.

**Admin launcher** (Discord → Web UI):

- `/config` — DMs you a single-use sign-in link for the admin Web UI.
  Everything formerly behind `/permissions`, `/setup`, `/announce`,
  `/announce-vc-stats`, `/poll`, `/reactrole`, `/notice`, `/dbtrunk`,
  `/vc`, `/botstats`, and the `/config` subcommand tree now lives in
  the Web UI.

📖 **[Complete Command Reference →](COMMANDS.md)**
📖 **[Web UI Guide →](WEBUI.md)**

---

## ⚙ Configuration

KoolBot has a **two-tier** configuration model:

| Tier                | Stored in | Edited via                                 | Picked up                  |
| ------------------- | --------- | ------------------------------------------ | -------------------------- |
| Bootstrap / secrets | `.env`    | Edit the file on the host                  | Bot restart                |
| Feature settings    | MongoDB   | Web UI **Settings**, **Permissions**, etc. | Saved immediately (note ↓) |

> ↓ Plain feature toggles take effect on the next read. A few
> services (cron schedules, channel managers) cache derived state and
> need a manual reload via their per-page button to fully apply.

All features ship **disabled by default** for safety. Turn them on from the
Web UI's Settings page once the bot is running.

### Initial setup, two ways

#### Option 1: Setup wizard (recommended)

1. Run `/config` in Discord.
2. Open the DM'd link.
3. Click **Setup Wizard** in the navigation.
4. Pick the features you want (voice channels, voice tracking, quotes,
   achievements, logging, etc.) and the wizard fills in the relevant
   settings for you.

#### Option 2: Manual configuration

1. Run `/config` in Discord.
2. Open the DM'd link.
3. Open **Settings**, find the keys you care about, edit them, save.
4. If you changed which commands are enabled, hit **Reload commands to
   Discord** on the Settings page so Discord re-syncs the registration.

### Configuration categories

| Category | Description |
| --- | --- |
| **Commands** | Enable/disable individual commands (`ping.enabled`, `quotes.enabled`, etc.) |
| **Voice Channels** | Dynamic channel creation, lobby settings, naming patterns |
| **Voice Tracking** | Activity tracking, excluded channels, admin roles |
| **Announcements** | Scheduled posts and weekly stats |
| **Polls** | Scheduled native Discord polls from a question library |
| **Data Cleanup** | Retention periods, cleanup schedule, aggregation |
| **Discord Logging** | Log bot events to Discord channels (`core.*` settings) |
| **Quote System** | Cooldowns, permissions, max length |
| **Notices** | Server rules / game-server info / help posts |
| **Reaction Roles** | Self-assignable role categories |
| **Leaderboard Roles** | Auto-assign Discord roles from voice leaderboard |
| **Achievements** | Persistent accolades and milestone badges |
| **Fun Features** | Easter eggs and passive listeners |
| **Rate Limiting** | Command spam protection with admin bypass |
| **Permissions** | Per-command role gating |

📖 **[Complete Settings Reference →](SETTINGS.md)**

### YAML import / export

The Web UI's Settings page has **Export** and **Import** buttons. Exports
are YAML files covering DB-backed settings only — bootstrap env vars are
never included.

Imports are previewed as a diff before you apply them. Apply is
**per-key**: rows that target protected bootstrap keys
(`DISCORD_TOKEN`, `WEBUI_SESSION_SECRET`, etc.) are skipped with a
`rejected: protected key` status, and the remaining valid rows still
apply. The result page reports per-key `applied` / `rejected` outcomes
and a top-level `ok` / `partial` / `failed` summary, so a mixed YAML
file produces a partial import rather than an all-or-nothing failure.

---

## 🎙 Voice Channel Features (Examples)

### Dynamic voice channel creation

When enabled, KoolBot creates private voice channels on-demand:

1. **User joins the lobby channel** (e.g., "🟢 Lobby")
2. **Bot creates a new channel** named "Username's Room"
3. **User is moved to their new channel** automatically
4. **Channel is deleted** when everyone leaves

Configure from the Web UI's **Settings** page (or use **Setup Wizard →
Voice Channels** to be walked through it):

| Setting | Example value |
| --- | --- |
| `voicechannels.enabled` | `true` |
| `voicechannels.category.name` | `Voice Channels` |
| `voicechannels.lobby.name` | `🟢 Lobby` |
| `voicechannels.lobby.offlinename` | `🔴 Lobby` |
| `voicechannels.channel.prefix` | `🎮` |

The lobby automatically renames based on bot status:

- **"🟢 Lobby"** — Bot online and ready
- **"🔴 Lobby"** — Bot offline

### Voice activity tracking

Track how much time users spend in voice channels:

| Setting | Example value |
| --- | --- |
| `voicetracking.enabled` | `true` |
| `voicetracking.stats.top.enabled` | `true` |
| `voicetracking.stats.user.enabled` | `true` |
| `voicetracking.seen.enabled` | `true` |
| `voicetracking.excluded_channels` | `123456789,987654321` |

Usage from Discord:

```text
/voicestats top                     # This week's top users
/voicestats top period:month        # This month's top users
/voicestats top period:alltime limit:20

/voicestats user                    # Your stats for this week
/voicestats user period:alltime

/seen user:@JohnDoe                 # Last-seen lookup
```

### Automated stats announcements

The weekly voice channel stats post is configured on the **Announcements**
page or via **Setup Wizard → Voice Tracking**:

| Setting | Example value |
| --- | --- |
| `voicetracking.announcements.enabled` | `true` |
| `voicetracking.announcements.channel` | `voice-stats` (name or ID) |
| `voicetracking.announcements.schedule` | `0 16 * * 5` (Fridays at 4 PM) |

Trigger one on demand from the Web UI's Announcements page — click
**Post weekly stats now**.

### Data cleanup & retention

Automatically clean old session data while preserving aggregated
statistics. Configure on the Settings page:

| Setting | Default |
| --- | --- |
| `voicetracking.cleanup.enabled` | `false` (turn on) |
| `voicetracking.cleanup.schedule` | `0 0 * * *` (daily at midnight) |
| `voicetracking.cleanup.retention.detailed_sessions_days` | `30` |
| `voicetracking.cleanup.retention.monthly_summaries_months` | `6` |
| `voicetracking.cleanup.retention.yearly_summaries_years` | `1` |

Run an out-of-schedule cleanup from the **Database** page.

---

## 📝 Discord Logging (Examples)

Configure the bot to send event logs to Discord channels via the
Settings page. Available log categories:

| Log Type | Description | Example Events |
| --- | --- | --- |
| `core.startup.*` | Bot lifecycle | Startup, shutdown, service initialization |
| `core.errors.*` | Critical errors | Command failures, service crashes |
| `core.cleanup.*` | Data maintenance | Cleanup results, sessions removed |
| `core.config.*` | Settings changes | Configuration reloads, value updates |
| `core.cron.*` | Scheduled tasks | Announcement triggers, cleanup runs |

You can point each category at the same channel for one consolidated log,
or split them between `#bot-status`, `#admin-alerts`, `#bot-logs`, etc.

---

## 🐳 Docker Management

### Useful Docker commands

```bash
# Start the bot
docker compose up -d

# View live logs
docker compose logs -f bot

# Stop the bot
docker compose down

# Restart the bot
docker compose restart bot

# Update to latest version
docker compose pull
docker compose up -d

# Shell into the bot container
docker compose exec bot sh

# View MongoDB logs
docker compose logs -f mongodb
```

### Exposing the Web UI

The default `docker-compose.yml` **publishes port 3000 to the host**
already — that's what makes the quick-start magic link reachable at
`http://your-host:3000` out of the box. There is no HTTPS. The compose
file's `bot.ports` block is the spot to change if you want something
else:

- **Direct port publish (shipped default)** — fine for LAN-only or
  VPN-only deployments:

  ```yaml
  services:
    bot:
      # ...
      ports:
        - "3000:3000"     # /health and /admin
  ```

- **Bind to localhost only** (then SSH-tunnel or VPN in) — replace the
  publish above with:

  ```yaml
  services:
    bot:
      # ...
      ports:
        - "127.0.0.1:3000:3000"
  ```

- **Reverse proxy with Caddy** (recommended for any internet-facing
  deployment — gets you HTTPS for free). Remove the `ports:` block on
  the bot service entirely and let the proxy forward to `bot:3000` on
  the internal Docker network:

  See [WEBUI.md → Docker Compose recipes](WEBUI.md#docker-compose-recipes)
  for a complete `docker-compose.yml` + `Caddyfile` you can copy.

After changing the compose file, run `docker compose up -d --force-recreate`.

### MongoDB exposure

The production `docker-compose.yml` deliberately does **not** publish
MongoDB's port 27017 to the host — the bot reaches MongoDB over the
internal Docker network at `mongodb:27017`. The default `mongo` image
ships with no authentication, so publishing 27017 would mean any
process on the host (and, on hosts with no firewall, anyone on the
public internet) could read and write the bot's entire database.

If you need host-side access for `mongosh`, Compass, or backups from
the host, bind to localhost only — never `0.0.0.0`:

```yaml
services:
  mongodb:
    # ...
    ports:
      - "127.0.0.1:27017:27017"
```

For backups and exec'd-in tools, you don't need to publish at all —
`docker compose exec mongodb mongodump <args>` runs inside the
container.

`docker-compose.dev.yml` does publish 27017 (bound to 127.0.0.1) for
developer convenience. Do not use the dev compose file in production.

### Development mode

For local development with hot reloading:

```bash
docker compose -f docker-compose.dev.yml up
# or in detached mode:
docker compose -f docker-compose.dev.yml up -d
```

This mounts your local code into the container and reloads on file
changes.

### Configuration & data backup

**Configuration backup (DB-backed settings):**

From the Web UI's Settings page, click **Export** to download a YAML
file containing every DB-backed setting. To restore on the same or a
different bot, use the **Import** button — the diff is previewed before
apply. Bootstrap env vars (`DISCORD_TOKEN`, etc.) are never included
in either direction.

**Database backup (all data):**

To back up everything — voice tracking stats, quotes, notices,
announcements, reaction roles, achievements — back up MongoDB:

```bash
# Create a backup
docker compose exec mongodb mongodump \
  --archive=/data/db/backup.archive --db=koolbot

# Copy backup file to your local machine
docker cp koolbot-mongodb:/data/db/backup.archive \
  ./koolbot-backup-$(date +%Y%m%d).archive
```

**Database restore:**

```bash
# Copy backup file into the container
docker cp ./koolbot-backup-YYYYMMDD.archive \
  koolbot-mongodb:/data/db/restore.archive

# Restore (--drop removes existing collections before restoring)
docker compose exec mongodb mongorestore \
  --archive=/data/db/restore.archive --db=koolbot --drop

# Restart the bot to refresh connections
docker compose restart bot
```

> **Note:** The `--drop` flag removes existing collections before
> restoring. This ensures a clean restore but will delete any data
> created after the backup was made.

**Complete backup (recommended):**

```bash
# 1. Export settings from the Web UI's Settings page (Export button)
# 2. Backup the database
docker compose exec mongodb mongodump \
  --archive=/data/db/backup.archive --db=koolbot
docker cp koolbot-mongodb:/data/db/backup.archive \
  ./koolbot-backup-$(date +%Y%m%d).archive
```

---

## 🚨 Troubleshooting

### Bot not starting

```bash
docker compose logs -f bot
```

Common issues:

- ❌ Invalid `DISCORD_TOKEN` → Check Discord Developer Portal
- ❌ Missing `MONGODB_URI` → Ensure it's set to `mongodb://mongodb:27017/koolbot`
- ❌ Docker not running → Start Docker Desktop / `systemctl start docker`

### `/config` says "the web UI is disabled"

You didn't set `WEBUI_ENABLED=true` (or didn't restart after editing
`.env`). Fix `.env`, then:

```bash
docker compose up -d --force-recreate
```

### `/config` says "missing env vars: WEBUI_BASE_URL, WEBUI_SESSION_SECRET"

Both must be set in `.env` when `WEBUI_ENABLED=true`. Generate a secret
with `openssl rand -base64 32` and restart.

### The DM link 404s when I click it

One of:

- It was already used (single-use).
- It expired (default 10 minutes).
- You ran `/config` again and got a newer link, which revoked this one.

Run `/config` again to mint a fresh one.

See [WEBUI.md → Troubleshooting](WEBUI.md#troubleshooting) for more.

### Commands not appearing in Discord

From the Web UI Settings page:

1. Verify the command is enabled (e.g. `ping.enabled` = `true`).
2. Click **Reload commands to Discord**.
3. Wait up to a few minutes for Discord to sync.

### Voice channels not creating

Verify `voicechannels.enabled` is `true` on the Settings page, then
check:

- The category named in `voicechannels.category.name` exists in Discord.
- The bot has `Manage Channels` and `Move Members` permissions.
- The lobby channel exists inside that category.

### Database connection issues

```bash
docker compose ps                # Is mongodb running?
docker compose logs -f mongodb   # Why isn't it?
docker compose restart mongodb
```

📖 **[Detailed Troubleshooting Guide →](TROUBLESHOOTING.md)**
📖 **[Web UI Troubleshooting →](WEBUI.md#troubleshooting)**

---

## 📚 Documentation

- **[WEBUI.md](WEBUI.md)** — Web UI setup, reverse-proxy guidance, magic-link flow
- **[COMMANDS.md](COMMANDS.md)** — Complete command reference with examples
- **[SETTINGS.md](SETTINGS.md)** — All configuration options explained
- **[DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md)** — Architecture and contribution patterns
- **[TESTING.md](TESTING.md)** — Testing guide and best practices
- **[TROUBLESHOOTING.md](TROUBLESHOOTING.md)** — Common issues and solutions
- **[CHANGELOG.md](CHANGELOG.md)** — Version history (managed by release-please)
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — Contribution guidelines for developers
- **[SECURITY.md](SECURITY.md)** — Security policy and vulnerability reporting

---

## 🔧 For Developers

> **Note:** The Quick Start guide above is for **users** who just want to run the bot.
> If you want to **develop** or **contribute** to KoolBot, you'll need to clone the
> full repository.

### Cloning for development

```bash
git clone https://github.com/lonix/koolbot.git
cd koolbot
npm install
```

### Local development (without Docker)

```bash
# Start MongoDB separately (Docker, local install, or cloud MongoDB)

# Update .env with your MongoDB URI
MONGODB_URI=mongodb://localhost:27017/koolbot

# Build TypeScript
npm run build

# Run in development mode
npm run dev
```

### Code quality tools

```bash
npm run lint           # Check code quality
npm run lint:fix       # Auto-fix linting issues
npm run format         # Format code with Prettier
npm run format:check   # Check formatting
npm run check          # Run all checks (build + lint + format)
npm run check:all      # Run all checks including tests
```

### Testing

```bash
npm test               # Run all tests
npm run test:watch     # Run tests in watch mode
npm run test:coverage  # Run tests with coverage report
npm run test:ci        # Run tests in CI mode
```

📖 **[Complete Testing Guide →](TESTING.md)**

### Available scripts

```bash
npm run build                     # Compile TypeScript
npm run start                     # Start production bot
npm run dev                       # Development with hot reload
npm run validate-config           # Validate configuration
npm run migrate-config            # Migrate old settings
npm run cleanup-global-commands   # Clean up Discord commands
```

### Architecture overview

```text
src/
├── commands/             # Discord slash commands (/ping, /config, etc.)
├── services/             # Core business logic (single source of truth)
│   ├── config-service.ts
│   ├── permissions-service.ts
│   ├── voice-channel-manager.ts
│   ├── voice-channel-tracker.ts
│   ├── web-session-service.ts
│   └── ...
├── web/                  # Web UI router (HTTP layer over services)
│   ├── index.ts          # Express router mounted at /admin
│   ├── session.ts        # Cookie session middleware
│   ├── read-only-routes.ts
│   ├── write-routes.ts
│   ├── csrf.ts
│   └── ...
├── models/               # MongoDB schemas
├── handlers/             # Discord event handlers
├── utils/                # Helper functions
└── index.ts              # Application entry point
```

The target for `src/web/` is to be a thin HTTP layer over the
services — the routes today do still hold some input coercion
(`coerceConfigValue`, `normalizeCron`) and direct model reads for page
data, but new write paths should prefer pushing that into a service
method. The goal is one validation path shared between the slash-command
surface and the Web UI surface, not two. See
[DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md) for the current state and
conventions.

### Contributing

Contributions are welcome! Please see our [Contributing Guide](CONTRIBUTING.md)
for detailed information on:

- Development setup and workflow
- Coding standards and best practices
- Testing requirements
- Pull request process
- Issue reporting guidelines

Quick start for contributors:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run quality checks (`npm run check:all`)
5. Commit your changes (`git commit -m 'Add amazing feature'`)
6. Push to the branch (`git push origin feature/amazing-feature`)
7. Open a Pull Request

For security vulnerabilities, please see our [Security Policy](SECURITY.md).

---

## 📄 License

This project is licensed under the MIT License — see the LICENSE file for details.

---

## 🙏 Acknowledgments

- **Discord.js** — Powerful Discord API library
- **Express** — HTTP server backbone for the Web UI and healthcheck
- **MongoDB** — Flexible NoSQL database
- **Docker** — Containerization platform
- **TypeScript** — Type-safe JavaScript

---

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/lonix/koolbot/issues)
- **Discussions**: [GitHub Discussions](https://github.com/lonix/koolbot/discussions)

---

<div align="center">

**KoolBot v1.0** — Making Discord servers more engaging! 🚀

Built with ❤️ using TypeScript and Discord.js

</div>
