# Koolbot

A Discord bot built with TypeScript and Discord.js, containerized with Docker.

## Features

- `/ping` - Responds with "Pong!"
- `/plexprice` - Shows the current Jita split price of PLEX
- `/amikool` - Checks if you're cool (requires role specified in COOL_ROLE_NAME)

## Prerequisites

- Docker and Docker Compose
- Node.js (for local development)
- Discord Bot Token and Client ID

## Setup

1. Clone the repository
2. Copy `.env.example` to `.env` and fill in your Discord bot credentials:
   ```bash
   cp .env.example .env
   ```
3. Edit `.env` with your Discord bot credentials:
   ```
   DISCORD_TOKEN=your_discord_bot_token_here
   CLIENT_ID=your_discord_client_id_here
   COOL_ROLE_NAME=Kool Kids  # Change this to match your role name
   DEBUG=true  # Set to true to see command logs
   ```

## Running the Bot

### Development Mode
```bash
docker-compose up koolbot-dev
```

### Production Mode
```bash
docker-compose up koolbot-prod
```

## Development

The bot uses slash commands, which are automatically registered on startup. The bot will:
1. Clean up any existing commands first
2. Register the new commands
3. Log all commands when DEBUG=true

### Available Commands

- `/ping` - Simple ping-pong command
- `/plexprice` - Fetches current PLEX price from Jita
- `/amikool` - Checks if you're in the specified role (COOL_ROLE_NAME)

## Security

- Uses Alpine Linux for minimal attack surface
- Runs as non-root user in production
- Environment variables for sensitive data
- Dependabot enabled for security updates

## CI/CD

- GitHub Actions for testing on PR
- Automated production builds on merge to master
- Dependabot for dependency updates

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

MIT
