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
GUILD_ID=your_guild_id_here
CLIENT_ID=your_client_id_here
MONGODB_URI=mongodb://localhost:27017/koolbot
DEBUG=false
NODE_ENV=production
```

### User Configurable Settings

All other settings can be configured using the `/config` command and are stored in the database. These include:

#### Voice Channel Management
- Enable/disable voice channel management
- Category name for voice channels
- Lobby channel names
- Channel naming patterns

#### Voice Channel Tracking
- Enable/disable tracking features
- Weekly announcement settings
- Last seen tracking

#### Bot Features
- Command toggles
- Feature flags

#### Roles
- Role names for permissions
- Admin role configurations

### Configuration Commands

Use the following commands to manage settings:

1. List all settings:
   ```
   /config list
   ```

2. List settings by category:
   ```
   /config list category:voice_channel
   ```

3. Get a specific setting:
   ```
   /config get key:ENABLE_VC_WEEKLY_ANNOUNCEMENT
   ```

4. Change a setting:
   ```
   /config set key:ENABLE_VC_WEEKLY_ANNOUNCEMENT value:true
   ```

5. Reset a setting to default:
   ```
   /config reset key:ENABLE_VC_WEEKLY_ANNOUNCEMENT
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
     --network koolbot-network \
     koolbot
   ```

Note: When running manually, you'll need to ensure MongoDB is available and the network is properly configured.

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
