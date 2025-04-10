# KoolBot

A modern Discord bot built with TypeScript and discord.js v14.

## Features

- Slash commands support
- Event handling system
- Database integration with Prisma
- Docker support for development and production

## Development

### Prerequisites

- Node.js 20 or later
- Docker and Docker Compose
- Discord Bot Token

### Setup

1. Clone the repository
2. Copy `.env.example` to `.env` and fill in your Discord credentials
3. Install dependencies:
   ```bash
   npm install
   ```

### Development with Docker

```bash
# Start development environment
docker-compose up

# Build and start development environment
docker-compose up --build

# Stop development environment
docker-compose down
```

### Local Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Deploy commands
npm run deploy
```

## Production Deployment

### Docker

```bash
# Build production image
docker build -t koolbot:latest .

# Run production container
docker run -d \
  --name koolbot \
  -e DISCORD_TOKEN=your_token \
  -e CLIENT_ID=your_client_id \
  -e GUILD_ID=your_guild_id \
  -e DATABASE_URL=your_db_url \
  koolbot:latest
```

## Project Structure

```
src/
├── bot.ts              # Main bot file
├── deploy-commands.ts  # Command deployment script
├── commands/          # Slash commands
├── events/            # Event handlers
└── types/             # TypeScript type definitions
```

## License

ISC
