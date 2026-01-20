# KoolBot

A powerful and modular Discord bot built with TypeScript, featuring dynamic voice channel
management, activity tracking, automated announcements, and comprehensive configuration
management.

![Discord.js](https://img.shields.io/badge/Discord.js-14.25.1-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9.3-blue)
![MongoDB](https://img.shields.io/badge/MongoDB-Latest-green)
![Docker](https://img.shields.io/badge/Docker-Ready-blue)
![Tests](https://img.shields.io/badge/Tests-51%20passing-brightgreen)
![Coverage](https://img.shields.io/badge/Coverage-In%20Progress-yellow)

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
# Copy the example file
cp .env.example .env
```

Edit `.env` with your Discord bot credentials:

```env
# Required: Get these from Discord Developer Portal
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_application_id_here
GUILD_ID=your_guild_id_here

# MongoDB connection (leave as-is for Docker)
MONGODB_URI=mongodb://mongodb:27017/koolbot

# Optional settings
DEBUG=false
NODE_ENV=production
```

**Where to get your credentials:**

- Go to [Discord Developer Portal](https://discord.com/developers/applications)
- Create a new application (or select existing)
- **DISCORD_TOKEN**: Bot tab → Reset Token → Copy
- **CLIENT_ID**: General Information → Application ID
- **GUILD_ID**: Your Discord Server → Right-click server icon → Copy ID (Enable Developer Mode in Discord settings)

### 3. **Start with Docker Compose**

```bash
docker-compose up -d
```

**That's it!** Your bot is now running. The Docker container will:

- ✅ Automatically install dependencies
- ✅ Set up MongoDB database
- ✅ Register commands with Discord
- ✅ Start the bot and keep it running

Check the logs:

```bash
docker-compose logs -f bot
```

---

## 📋 What's Included

### Core Features

- **🎙 Dynamic Voice Channels** - Users create their own voice channels from a lobby
- **📊 Activity Tracking** - Track voice channel usage with leaderboards and statistics
- **⏰ Automated Announcements** - Weekly stats announcements
- **🧹 Smart Data Cleanup** - Automatic cleanup with data preservation
- **⚙ Flexible Configuration** - Configure everything through Discord commands
- **📝 Discord Logging** - Bot events logged to Discord channels
- **🎭 Quote System** - Save and retrieve memorable quotes
- **🤖 Bot Status** - Dynamic status showing bot state and user count
- **🔒 Rate Limiting** - Protect against command spam with configurable limits

### Available Commands

**User Commands:**

- `/ping` - Check bot responsiveness
- `/vctop` - View voice channel leaderboards
- `/vcstats` - View your personal voice statistics
- `/transfer-ownership` - Transfer ownership of your voice channel
- `/quote` - Add or retrieve quotes
- `/seen` - Check when a user was last seen
- `/amikool` - Role verification command

**Admin Commands:**

- `/config` - Manage all bot settings
- `/vc` - Voice channel management
- `/dbtrunk` - Database cleanup management
- `/setup-lobby` - Configure voice lobby
- `/exclude-channel` - Exclude channels from tracking
- `/botstats` - View bot performance metrics
- `/announce-vc-stats` - Manually trigger voice channel stats announcements

📖 **[Complete Command Reference →](COMMANDS.md)**

---

## ⚙ Configuration

All bot features are **disabled by default** for security. You enable and configure them using Discord commands after the bot starts.

### Initial Setup

Once your bot is running, configure it from Discord:

```bash
# Enable the ping command
/config set key:ping.enabled value:true
/config reload

# Enable voice channel management
/config set key:voicechannels.enabled value:true
/config set key:voicechannels.category.name value:"Voice Channels"
/config reload

# Enable voice tracking
/config set key:voicetracking.enabled value:true
/config reload
```

### View All Settings

```bash
# List all configuration options
/config list

# Get a specific setting
/config get key:ping.enabled

# Reset a setting to default
/config reset key:ping.enabled
```

### Configuration Categories

| Category | Description |
| --- | --- |
| **Commands** | Enable/disable individual commands (`ping.enabled`, `quotes.enabled`, etc.) |
| **Voice Channels** | Dynamic channel creation, lobby settings, naming patterns |
| **Voice Tracking** | Activity tracking, excluded channels, admin roles |
| **Announcements** | Weekly stats announcements, schedule, target channel |
| **Data Cleanup** | Retention periods, cleanup schedule, aggregation |
| **Discord Logging** | Log bot events to Discord channels (`core.*` settings) |
| **Quote System** | Cooldowns, permissions, max length |
| **Fun Features** | Easter eggs and passive listeners |
| **Rate Limiting** | Command spam protection with admin bypass |

📖 **[Complete Settings Reference →](SETTINGS.md)**

---

## 🎙 Voice Channel Features (Examples)

### Dynamic Voice Channel Creation

When enabled, KoolBot creates private voice channels on-demand:

1. **User joins the lobby channel** (e.g., "🟢 Lobby")
2. **Bot creates a new channel** named "Username's Room"
3. **User is moved to their new channel** automatically
4. **Channel is deleted** when everyone leaves

**Setup:**

```bash
# Enable voice channel management
/config set key:voicechannels.enabled value:true

# Set the category name (create this category in Discord first)
/config set key:voicechannels.category.name value:"Voice Channels"

# Configure lobby channel names
/config set key:voicechannels.lobby.name value:"🟢 Lobby"
/config set key:voicechannels.lobby.offlinename value:"🔴 Lobby"

# Optional: Customize channel naming
/config set key:voicechannels.channel.prefix value:"🎮"

# Apply changes
/config reload
```

The lobby will automatically rename based on bot status:

- **"🟢 Lobby"** - Bot online and ready
- **"🔴 Lobby"** - Bot offline

### Voice Activity Tracking

Track how much time users spend in voice channels:

**Setup:**

```bash
# Enable tracking
/config set key:voicetracking.enabled value:true

# Exclude specific channels (e.g., AFK channels)
/config set key:voicetracking.excluded_channels value:"123456789,987654321"

# Enable /seen command
/config set key:voicetracking.seen.enabled value:true

/config reload
```

**Usage:**

```bash
# View leaderboards
/vctop              # This week's top users
/vctop period:month # This month's top users
/vctop period:alltime limit:20  # Top 20 all-time

# Check personal stats
/vcstats            # Your stats for this week
/vcstats period:alltime  # Your all-time stats

# Check when someone was last online
/seen user:@JohnDoe
```

### Automated Stats Announcements

Post weekly voice channel statistics automatically:

**Setup:**

```bash
# Enable announcements
/config set key:voicetracking.announcements.enabled value:true

# Set the channel (by name or ID)
/config set key:voicetracking.announcements.channel value:"voice-stats"

# Set schedule (cron format) - Default: Every Friday at 4 PM
/config set key:voicetracking.announcements.schedule value:"0 16 * * 5"

/config reload
```

**Manual trigger:**

```bash
/announce-vc-stats
```

### Data Cleanup & Retention

Automatically clean old session data while preserving aggregated statistics:

**Setup:**

```bash
# Enable automatic cleanup
/config set key:voicetracking.cleanup.enabled value:true

# Set retention periods
/config set key:voicetracking.cleanup.retention.detailed_sessions_days value:30
/config set key:voicetracking.cleanup.retention.monthly_summaries_months value:6
/config set key:voicetracking.cleanup.retention.yearly_summaries_years value:1

# Set cleanup schedule (default: daily at midnight)
/config set key:voicetracking.cleanup.schedule value:"0 0 * * *"

/config reload
```

**Manual cleanup:**

```bash
/dbtrunk status     # Check cleanup status
/dbtrunk run        # Run cleanup now
```

---

## 📝 Discord Logging (Examples)

Configure the bot to send event logs to Discord channels:

### Setup Logging Channels

```bash
# Log startup/shutdown events to #bot-status
/config set key:core.startup.enabled value:true
/config set key:core.startup.channel_id value:123456789

# Log errors to #admin-alerts
/config set key:core.errors.enabled value:true
/config set key:core.errors.channel_id value:987654321

# Log cleanup reports to #bot-logs
/config set key:core.cleanup.enabled value:true
/config set key:core.cleanup.channel_id value:555666777

# Log configuration changes
/config set key:core.config.enabled value:true
/config set key:core.config.channel_id value:111222333

# Log cron job execution
/config set key:core.cron.enabled value:true
/config set key:core.cron.channel_id value:444555666
```

**Tip:** You can use the same channel for multiple log types, or separate them for better organization.

### Available Log Types

| Log Type | Description | Example Events |
| --- | --- | --- |
| `core.startup.*` | Bot lifecycle | Startup, shutdown, service initialization |
| `core.errors.*` | Critical errors | Command failures, service crashes |
| `core.cleanup.*` | Data maintenance | Cleanup results, sessions removed |
| `core.config.*` | Settings changes | Configuration reloads, value updates |
| `core.cron.*` | Scheduled tasks | Announcement triggers, cleanup runs |

---

## 🐳 Docker Management

### Useful Docker Commands

```bash
# Start the bot
docker-compose up -d

# View live logs
docker-compose logs -f bot

# Stop the bot
docker-compose down

# Restart the bot
docker-compose restart bot

# Update to latest version
docker-compose pull
docker-compose up -d

# Access the bot container
docker-compose exec bot sh

# View MongoDB logs
docker-compose logs -f mongodb
```

### Development Mode

For local development with hot reloading:

```bash
# Start in development mode
docker-compose -f docker-compose.dev.yml up

# Or in detached mode
docker-compose -f docker-compose.dev.yml up -d
```

This will:

- Mount your local code into the container
- Automatically reload on file changes
- Show detailed debug output

### Configuration Backup & Restore

**Configuration (Settings) Backup:**

```bash
# Export configuration to YAML
/config export

# Import configuration from YAML (attach file to Discord)
/config import
```

**Database (Data) Backup:**

To backup all your data (voice tracking stats, quotes, etc.), backup the MongoDB database:

```bash
# Create a backup of the MongoDB database
docker-compose exec mongodb mongodump --archive=/data/db/backup.archive --db=koolbot

# Copy backup file to your local machine
docker cp koolbot-mongodb:/data/db/backup.archive ./koolbot-backup-$(date +%Y%m%d).archive
```

**Database Restore:**

```bash
# Copy backup file to container
docker cp ./koolbot-backup-20240101.archive koolbot-mongodb:/data/db/restore.archive

# Restore the database
docker-compose exec mongodb mongorestore --archive=/data/db/restore.archive --db=koolbot

# Restart the bot to refresh connections
docker-compose restart bot
```

**Complete Backup (Recommended):**

For a complete backup, save both configuration and database:

```bash
# 1. Export configuration from Discord
/config export
# (Download the YAML file Discord sends you)

# 2. Backup database
docker-compose exec mongodb mongodump --archive=/data/db/backup.archive --db=koolbot
docker cp koolbot-mongodb:/data/db/backup.archive ./koolbot-backup-$(date +%Y%m%d).archive
```

---

## 🔧 Advanced Configuration Examples

### Quote System

```bash
# Enable quotes
/config set key:quotes.enabled value:true

# Set cooldown (seconds between adding quotes)
/config set key:quotes.cooldown value:120

# Set max quote length
/config set key:quotes.max_length value:500

# Restrict who can add quotes (role IDs, comma-separated)
/config set key:quotes.add_roles value:"123456789,987654321"

# Restrict who can delete quotes
/config set key:quotes.delete_roles value:"123456789"

/config reload
```

### Role-Based Commands

```bash
# Enable amikool command
/config set key:amikool.enabled value:true

# Set the role name to check
/config set key:amikool.role.name value:"Kool Members"

/config reload
```

### Fun Features

```bash
# Enable friendship listener (responds to "best ship" mentions)
/config set key:fun.friendship value:true
```

### Voice Channel Customization

```bash
# Customize channel naming
/config set key:voicechannels.channel.prefix value:"🎮"
/config set key:voicechannels.channel.suffix value:"'s Gaming Room"

# Set specific admin roles for tracking
/config set key:voicetracking.admin_roles value:"Admin,Moderator"
```

---

## 🚨 Troubleshooting

### Bot Not Starting

**Check the logs:**

```bash
docker-compose logs -f bot
```

**Common issues:**

- ❌ Invalid `DISCORD_TOKEN` → Check Discord Developer Portal
- ❌ Missing `MONGODB_URI` → Ensure it's set to `mongodb://mongodb:27017/koolbot`
- ❌ Docker not running → Start Docker Desktop

### Commands Not Appearing

```bash
# Reload commands to Discord
/config reload
```

**If still not working:**

- Ensure the command is enabled (`/config list`)
- Check bot has proper Discord permissions
- Wait a few minutes for Discord to sync

### Voice Channels Not Creating

**Check configuration:**

```bash
/config get key:voicechannels.enabled
/config get key:voicechannels.category.name
```

**Ensure:**

- The category exists in Discord
- Bot has permissions: `Manage Channels`, `Move Members`
- The lobby channel exists

### Database Connection Issues

```bash
# Check MongoDB container
docker-compose ps

# View MongoDB logs
docker-compose logs -f mongodb

# Restart MongoDB
docker-compose restart mongodb
```

### Reset Configuration

```bash
# Reset a specific setting
/config reset key:ping.enabled

# Or re-import from backup
/config import
```

📖 **[Detailed Troubleshooting Guide →](TROUBLESHOOTING.md)**

---

## 📚 Documentation

- **[COMMANDS.md](COMMANDS.md)** - Complete command reference with examples
- **[SETTINGS.md](SETTINGS.md)** - All configuration options explained
- **[TESTING.md](TESTING.md)** - Testing guide and best practices
- **[TROUBLESHOOTING.md](TROUBLESHOOTING.md)** - Common issues and solutions
- **[RELEASE_NOTES.md](RELEASE_NOTES.md)** - Version history and changelog
- **[CONTRIBUTING.md](CONTRIBUTING.md)** - Contribution guidelines for developers
- **[SECURITY.md](SECURITY.md)** - Security policy and vulnerability reporting

---

## 🔧 For Developers

> **Note:** The Quick Start guide above is for **users** who just want to run the bot.
> If you want to **develop** or **contribute** to KoolBot, you'll need to clone the full repository.

### Cloning for Development

```bash
# Clone the repository
git clone https://github.com/lonix/koolbot.git
cd koolbot

# Install dependencies
npm install
```

### Local Development (Without Docker)

If you want to develop locally without Docker:

```bash
# Start MongoDB separately
# (Use Docker, local install, or cloud MongoDB)

# Update .env with your MongoDB URI
MONGODB_URI=mongodb://localhost:27017/koolbot

# Build TypeScript
npm run build

# Run in development mode
npm run dev
```

### Code Quality Tools

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

### Available Scripts

```bash
npm run build                     # Compile TypeScript
npm run start                     # Start production bot
npm run dev                       # Development with hot reload
npm run validate-config           # Validate configuration
npm run migrate-config            # Migrate old settings
npm run cleanup-global-commands   # Clean up Discord commands
```

### Architecture Overview

```text
src/
├── commands/           # Discord slash commands
├── services/          # Core business logic
│   ├── config-service.ts
│   ├── voice-channel-manager.ts
│   ├── voice-channel-tracker.ts
│   └── ...
├── models/            # MongoDB schemas
├── utils/             # Helper functions
└── index.ts           # Application entry point
```

### Contributing

Contributions are welcome! Please see our [Contributing Guide](CONTRIBUTING.md) for detailed information on:

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

This project is licensed under the MIT License - see the LICENSE file for details.

---

## 🙏 Acknowledgments

- **Discord.js** - Powerful Discord API library
- **MongoDB** - Flexible NoSQL database
- **Docker** - Containerization platform
- **TypeScript** - Type-safe JavaScript

---

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/lonix/koolbot/issues)
- **Discussions**: [GitHub Discussions](https://github.com/lonix/koolbot/discussions)

---

<div align="center">

**KoolBot v0.6.0** - Making Discord servers more engaging! 🚀

Built with ❤️ using TypeScript and Discord.js

</div>
