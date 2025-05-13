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

## Environment Variables

### Discord Bot Configuration
- `DISCORD_TOKEN`: Your Discord bot token
- `GUILD_ID`: Your Discord server ID
- `CLIENT_ID`: Your Discord application client ID

### Voice Channel Management
- `ENABLE_VC_MANAGEMENT`: Enable/disable voice channel management (true/false)
- `VC_CATEGORY_NAME`: Name of the category for voice channels
- `LOBBY_CHANNEL_NAME`: Name of the lobby channel
- `LOBBY_CHANNEL_NAME_OFFLINE`: Name of the offline lobby channel
- `VC_CHANNEL_PREFIX`: Prefix for dynamically created channels
- `VC_SUFFIX`: Suffix for dynamically created channels

### Voice Channel Tracking
- `ENABLE_VC_TRACKING`: Enable/disable voice channel tracking
- `ENABLE_SEEN`: Enable/disable last seen tracking
- `ENABLE_VC_WEEKLY_ANNOUNCEMENT`: Enable/disable weekly announcements
- `VC_ANNOUNCEMENT_CHANNEL`: Channel name for weekly announcements
- `VC_ANNOUNCEMENT_SCHEDULE`: Cron-style schedule for announcements (default: "0 16 * * 5" for Friday at 4 PM)

### MongoDB Configuration
- `MONGODB_URI`: MongoDB connection string

### Bot Features
- `ENABLE_PING`: Enable/disable ping command
- `ENABLE_AMIKOOL`: Enable/disable amikool command
- `ENABLE_PLEX_PRICE`: Enable/disable plex price checking

### Role Configuration
- `COOL_ROLE_NAME`: Name of the role for kool verification
- `VC_TRACKING_ADMIN_ROLES`: Comma-separated list of admin role names

### Debug Configuration
- `DEBUG`: Enable/disable debug mode
- `NODE_ENV`: Environment (development/production)

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
2. Copy `.env.example` to `.env` and fill in your configuration
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

## License

MIT
