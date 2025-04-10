# Koolbot

A Discord bot built with TypeScript and Discord.js, containerized with Docker.

## Features

- `/ping` - Responds with "Pong!"
- `/plexprice` - Shows the current Jita split price of PLEX
- `/amikool` - Checks if you're cool (requires "Cool People" role)

## Prerequisites

- Docker and Docker Compose
- Node.js (for local development)
- Discord Bot Token and Client ID

## Setup

1. Clone the repository
2. Copy `.env.example` to `.env` and fill in your Discord bot credentials
3. Build and run the containers:

```bash
# For development
docker-compose up koolbot-dev

# For production
docker-compose up koolbot-prod
```

## Development

The bot uses slash commands, which need to be registered with Discord. The bot will automatically register these commands on startup.

### Available Commands

- `/ping` - Simple ping-pong command
- `/plexprice` - Fetches current PLEX price from Jita
- `/amikool` - Checks if you're in the "Cool People" role

## Security

- Uses Alpine Linux for minimal attack surface
- Runs as non-root user in production
- Environment variables for sensitive data

## License

MIT
