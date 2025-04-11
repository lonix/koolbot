# KoolBot

A Discord bot with various features including PLEX price checking, role-based commands, and automatic voice channel management.

## Features

- `/ping` - Responds with "Pong!"
- `/plexprice` - Gets the current PLEX price in Jita from Eve Online
- `/amikool` - Checks if a user has the cool role
- Automatic Voice Channel Management - Automatically creates and manages voice channels when users join the lobby

## Environment Variables

Create a `.env` file with the following variables:

```env
# Discord Configuration
DISCORD_TOKEN=your_discord_token
CLIENT_ID=your_client_id
GUILD_ID=your_guild_id

# Feature Flags
ENABLE_PING=true
ENABLE_PLEXPRICE=true
ENABLE_AMIKOOL=true
ENABLE_VC_MANAGEMENT=true
ENABLE_VC_TRACKING=true

# Role Configuration
COOL_ROLE_NAME=Verifyed Kool Kid

# VC Configuration
LOBBY_CHANNEL_NAME=Lobby
VC_CATEGORY_NAME=Dynamic Voice Channels
VC_PREFIX=s'-Room

# Debug Configuration
DEBUG=true
NODE_ENV=development
```

## Voice Channel Management

The bot automatically manages voice channels when the `ENABLE_VC_MANAGEMENT` feature flag is enabled:
- When a user joins the lobby channel (configured by `LOBBY_CHANNEL_NAME`), a new voice channel is automatically created in the specified category (`VC_CATEGORY_NAME`)
- The channel is named after the user who created it
- When all users leave the channel, it is automatically deleted
- The feature can be disabled by setting `ENABLE_VC_MANAGEMENT=false`

## Development

### Prerequisites

- Docker
- Docker Compose
- Node.js (for local development)

### Running with Docker

1. Build and start the containers:
```bash
docker-compose up --build
```

2. To stop the containers:
```bash
docker-compose down
```

### Local Development

1. Install dependencies:
```bash
npm install
```

2. Start the development server:
```bash
npm run dev
```

## Production Deployment

1. Build the Docker image:
```bash
docker build -t koolbot .
```

2. Run the container:
```bash
docker run -d --name koolbot --env-file .env koolbot
```

## Logging

- In production, all commands and actions are logged to stdout
- When DEBUG=true, additional debug information is logged
- If BOT_LOGS_CHANNEL_ID is set, logs are also sent to the specified Discord channel

## License

MIT
