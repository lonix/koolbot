# KoolBot

A Discord bot for managing voice channels and tracking user activity.

## Features

### Voice Channel Management
- Dynamic voice channel creation and deletion
- Automatic cleanup of empty channels
- Offline lobby channel for when the bot is down
- Automatic user migration from offline lobby to new channels on bot restart
- Customizable channel naming and user limits

### Voice Channel Tracking
- Track user time spent in voice channels
- View statistics for different time periods (last week, last month, all time)
- Top users leaderboard
- Individual user statistics

### Other Features
- Plex price checking
- User last seen tracking
- Ping command
- Am I Kool command

## Environment Variables

### Discord Bot Configuration
- `DISCORD_TOKEN`: Your Discord bot token
- `GUILD_ID`: Your Discord server ID
- `CLIENT_ID`: Your Discord application client ID

### Voice Channel Management
- `ENABLE_VC_MANAGEMENT`: Enable/disable voice channel management (true/false)
- `VC_CATEGORY_NAME`: Name of the category for voice channels
- `LOBBY_CHANNEL_NAME`: Name of the lobby channel
- `VC_USER_LIMIT`: Maximum users per voice channel
- `VC_CHANNEL_PREFIX`: Prefix for dynamically created channels

### Voice Channel Tracking
- `ENABLE_VC_TRACKING`: Enable/disable voice channel tracking (true/false)

### MongoDB Configuration
- `MONGODB_URI`: MongoDB connection string

### Logging Configuration
- `LOG_LEVEL`: Logging level (info, debug, error)

### Feature Flags
- `ENABLE_PLEX_PRICE`: Enable/disable plex price checking
- `ENABLE_SEEN_COMMAND`: Enable/disable last seen tracking
- `ENABLE_VC_STATS`: Enable/disable voice channel statistics
- `ENABLE_VC_TOP`: Enable/disable voice channel leaderboard

## Offline Lobby Feature

When the bot shuts down:
1. Creates an offline lobby channel (named `LOBBY_CHANNEL_NAME_OFFLINE`)
2. Cleans up empty voice channels
3. Deletes the regular lobby channel if empty

When the bot starts up:
1. Checks for users in the offline lobby
2. If users are present:
   - Creates a new channel named after the first user
   - Moves all users to the new channel
3. Deletes the offline lobby channel
4. Initializes normal channels

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

1. Build the image:
   ```bash
   docker build -t koolbot .
   ```

2. Run the container:
   ```bash
   docker run -d --name koolbot --env-file .env koolbot
   ```

Or use docker-compose:
```bash
docker-compose up -d
```

## Commands

- `/ping`: Check bot latency
- `/seen @user`: Check when a user was last seen
- `/plexprice`: Check current PLEX price
- `/vcstats`: View your voice channel statistics
- `/vctop`: View voice channel leaderboard
- `/amikool`: Check if you're kool

## Development

- TypeScript
- Discord.js
- MongoDB
- Winston for logging

## License

MIT
