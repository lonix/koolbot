# Koolbot

A Discord bot built with TypeScript and discord.js.

## Features

### Basic Commands
- **Ping Command** (`/ping`)
  - Replies with "Pong!"
  - Environment variable: `ENABLE_PING`

### EVE Online Integration
- **PLEX Price Command** (`/plexprice`)
  - Fetches the current Jita split price of PLEX
  - Environment variable: `ENABLE_PLEXPRICE`

### Role Management
- **Am I Kool Command** (`/amikool`)
  - Checks if a user has the cool role
  - Environment variable: `ENABLE_AMIKOOL`
  - Role name configurable via `COOL_ROLE_NAME`

### Voice Channel Management
- **Dynamic Voice Channels**
  - Creates a personal voice channel when joining the Lobby
  - Each channel comes with its own text channel
  - Environment variable: `ENABLE_VC_MANAGEMENT`
- **Channel Commands**
  - `/public` - Make your voice channel public
  - `/private` - Make your voice channel private
  - `/ban <user>` - Ban a user from your voice channel

### Voice Activity Tracking
- **Time Tracking**
  - Automatically tracks time spent in voice channels
  - Environment variable: `ENABLE_VC_TRACKING`
- **Commands**
  - `/vctime <user> [period]` - Check voice chat time for a user
    - Periods: today, week, month, alltime
  - `/seen <user>` - Check when a user was last in voice chat

## Environment Variables

### Discord Configuration
- `DISCORD_TOKEN`: Your Discord bot token
- `CLIENT_ID`: Your Discord application client ID

### Feature Flags
All features are disabled by default. Set to `true` to enable:
- `ENABLE_PING`: Enable the ping command
- `ENABLE_PLEXPRICE`: Enable the PLEX price command
- `ENABLE_AMIKOOL`: Enable the amikool command
- `ENABLE_VC_MANAGEMENT`: Enable voice channel management features
- `ENABLE_VC_TRACKING`: Enable voice activity tracking features

### Role Configuration
- `COOL_ROLE_NAME`: Name of the role to check for in the amikool command (default: "Kool Kids")

### Voice Channel Configuration
- `LOBBY_CHANNEL_NAME`: Name of the lobby channel (default: "Lobby")
- `VC_CATEGORY_NAME`: Category for dynamic voice channels (default: "Dynamic Voice Channels")
- `VC_PREFIX`: Prefix for dynamic voice channels (default: "Room")

### Debug Configuration
- `DEBUG`: Set to `true` to enable debug logging
- `NODE_ENV`: Set to `development` or `production`

## Development

### Prerequisites
- Node.js 20 or later
- Docker and Docker Compose
- A Discord bot token

### Local Development
1. Copy `.env.example` to `.env` and fill in your Discord token and client ID
2. Enable desired features in `.env`
3. Run the bot:
   ```bash
   docker-compose up --build koolbot-dev
   ```

### Production
```bash
docker-compose up --build koolbot
```

## License
MIT
