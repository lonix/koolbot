# KoolBot

A Discord bot for managing voice channels and tracking user activity.

## Features

### Voice Channel Management
- Dynamic voice channel creation and deletion
- Automatic cleanup of empty channels
- Offline lobby channel for when the bot is down
- Automatic user migration from offline lobby to new channels on bot restart
- Customizable channel naming and user limits
- Voice channel ownership management
- Automatic ownership assignment based on activity

### Voice Channel Tracking
- Track user time spent in voice channels
- View statistics for different time periods (last week, last month, all time)
- Top users leaderboard
- Individual user statistics
- Last seen tracking with `/seen` command
- Weekly voice channel activity announcements
  - Cron-style scheduling
  - Top 10 most active users
  - Special mentions for top 3 users
  - Admin manual trigger option
- Excluded voice channels (comma-separated list of channel IDs)

### Other Features
- PLEX price checking
- Ping command
- Am I Kool command with role-based verification
- Comprehensive logging system
- Clean shutdown handling
- Type-safe configuration

## Configuration

### Critical Settings (.env)

The following settings must be configured in the `.env` file as they are critical for bot operation:

```env
# Critical Bot Configuration
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_client_id_here
MONGODB_URI=mongodb://localhost:27017/koolbot
DEBUG=false
NODE_ENV=production

# Note: GUILD_ID is only needed temporarily to clean up any existing guild commands
# Can be removed after initial cleanup is complete
GUILD_ID=your_guild_id_here
```

### User Configurable Settings

All other settings can be configured using the `/config` command and are stored in the database. These settings use a hierarchical dot notation structure for better organization:

#### Settings Hierarchy

```
ping.enabled                    # Enable/disable ping command
amikool.enabled                # Enable/disable amikool command
amikool.role.name              # Name of the cool role for verification

plexprice.enabled              # Enable/disable plexprice command

quotes.enabled                 # Enable/disable quote system
quotes.cooldown                # Cooldown between quote additions (seconds)
quotes.max_length              # Maximum length for quotes
quotes.add_roles               # Roles that can add quotes (comma-separated IDs)
quotes.delete_roles            # Roles that can delete quotes (comma-separated IDs)

voicechannels.enabled          # Enable/disable voice channel management
voicechannels.category.name    # Category name for voice channels
voicechannels.lobby.name       # Online lobby channel name
voicechannels.lobby.offlinename # Offline lobby channel name
voicechannels.channel.prefix   # Prefix for dynamically created channels
voicechannels.channel.suffix   # Suffix for dynamically created channels

voicetracking.enabled          # Enable/disable voice channel tracking
voicetracking.seen.enabled     # Enable/disable last seen tracking
voicetracking.excluded_channels # Excluded voice channels (comma-separated IDs)
voicetracking.admin_roles      # Admin roles for tracking (comma-separated IDs)
voicetracking.announcements.enabled    # Enable/disable weekly announcements
voicetracking.announcements.channel    # Channel for announcements
voicetracking.announcements.schedule   # Cron schedule for announcements
```

#### Configuration Commands

Use the following commands to manage settings:

1. **List all settings:**
   ```
   /config list
   ```

2. **Get a specific setting:**
   ```
   /config get key:ping.enabled
   ```

3. **Change a setting:**
   ```
   /config set key:ping.enabled value:false
   ```

4. **Reset a setting to default:**
   ```
   /config reset key:ping.enabled
   ```

5. **Reload commands after changing settings:**
   ```
   /config reload
   ```



## Commands

### Voice Channel Commands
- `/seen @user`: Check when a user was last seen in a voice channel
- `/vcstats`: View your voice channel statistics
- `/vctop`: View voice channel leaderboard
- `/transfer-ownership @user`: Transfer ownership of your voice channel
- `/announce-vc-stats`: Manually trigger weekly announcement (Admin only)

### Other Commands
- `/ping`: Check bot latency
- `/plexprice`: Check current PLEX price
- `/amikool`: Check if you're kool (requires role verification)

## Installation

1. Clone the repository
2. Copy `.env.example` to `.env` and configure the critical settings
3. Install dependencies:
   ```bash
   npm install
   ```
4. Build the project:
   ```bash
   npm run build
   ```
5. Start the bot:
   ```bash
   npm start
   ```

## Docker Deployment

The recommended way to deploy KoolBot is using Docker Compose, which will set up both the bot and its MongoDB database.

1. Make sure you have Docker and Docker Compose installed
2. Copy `.env.example` to `.env` and configure your settings
3. Start the services:
   ```bash
   docker-compose up -d
   ```

To view logs:
```bash
docker-compose logs -f
```

To stop the services:
```bash
docker-compose down
```

To rebuild and restart:
```bash
docker-compose up -d --build
```

### Manual Docker Deployment (Alternative)

If you prefer to run the bot without docker-compose, you can use these commands:

1. Build the image:
   ```bash
   docker build -t koolbot .
   ```

2. Run the container:
   ```bash
   docker run -d \
     --name koolbot \
     --env-file .env \
     koolbot
   ```

## Command Registration

The bot uses guild-specific commands for faster updates and better control. The `GUILD_ID` in your `.env` file is required for command registration.

### One-time Global Commands Cleanup

If you have previously registered global commands, you can clean them up using Docker:

```bash
docker run --rm \
  --env-file .env \
  koolbot \
  npm run cleanup-global-commands
```

This will remove all global commands, ensuring a clean transition to guild-specific commands.

### Command Updates

Guild commands update when you:
1. **Manually reload** using `/config reload` after changing command settings
2. Restart the bot
3. Deploy new commands

**Important**: After changing command enable/disable settings, you must run `/config reload` to update Discord. This gives you full control over when commands are updated and prevents unexpected behavior.

### Configuration Migration

**Important**: The bot no longer automatically migrates settings on startup. Instead, it will:

1. **Warn you** if outdated flat settings (like `ENABLE_PING`) are found in the database
2. **Create missing settings** with default values for new installations
3. **Require manual migration** using the standalone script

#### Manual Migration

To migrate old settings to the new dot notation format, run:

```bash
npm run migrate-config
```

This script will:
- Convert old flat keys (e.g., `ENABLE_PING`) to new dot notation (e.g., `ping.enabled`)
- Preserve all your existing values
- Clean up old settings after successful migration

**When to migrate:**
- After updating from an older version of the bot
- When you see warnings about outdated settings in the logs
- Before manually deleting old settings from the database

## Development

### Tech Stack
- TypeScript
- Discord.js
- MongoDB
- Winston for logging
- Cron for scheduling

### Code Quality
- ESLint for code linting
- TypeScript for type safety
- Proper error handling
- Comprehensive logging

## Backup and Restore

### Backup MongoDB Data Volume

To backup the MongoDB data volume in production, run the following command:

```sh
docker run --rm -v koolbot_mongodb_data:/data -v $(pwd):/backup alpine tar -czvf /backup/mongodb_backup_$(date +%Y%m%d_%H%M%S).tar.gz -C /data .
```

This command creates a compressed tar archive of the MongoDB data volume, with a timestamp in the filename.

### Restore MongoDB Data Volume

To restore from a backup in production, run the following command:

```sh
docker run --rm -v koolbot_mongodb_data:/data -v $(pwd):/backup alpine sh -c "rm -rf /data/* && tar -xzvf /backup/your_backup_file.tar.gz -C /data"
```

Replace `your_backup_file.tar.gz` with the name of your backup file.

### Automate Backups

To automate backups in production, you can set up a cron job. For example, to run the backup daily at 2 AM, add the following line to your crontab:

```sh
0 2 * * * docker run --rm -v koolbot_mongodb_data:/data -v /path/to/backup/dir:/backup alpine tar -czvf /backup/mongodb_backup_$(date +%Y%m%d_%H%M%S).tar.gz -C /data .
```

Replace `/path/to/backup/dir` with the directory where you want to store the backups.

## License

MIT
