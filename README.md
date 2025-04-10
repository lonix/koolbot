# KoolBot

A Discord bot with various features including PLEX price checking and role-based commands.

## Features

- `/ping` - Responds with "Pong!"
- `/plexprice` - Gets the current PLEX price in Jita from Eve Online
- `/amikool` - Checks if a user has the cool role

## Environment Variables

Create a `.env` file with the following variables:

```env
# Discord Configuration
DISCORD_TOKEN=your_discord_token
CLIENT_ID=your_client_id
BOT_LOGS_CHANNEL_ID=your_logs_channel_id

# Feature Flags
ENABLE_PING=true
ENABLE_PLEXPRICE=true
ENABLE_AMIKOOL=true

# Role Configuration
COOL_ROLE_NAME=Verifyed Kool Kid

# Debug Configuration
DEBUG=true
NODE_ENV=development
```

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
