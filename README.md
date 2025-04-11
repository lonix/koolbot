# KoolBot

A Discord bot with various features including PLEX price checking, role-based commands, and automatic voice channel management.

## Features

- `/ping` - Responds with "Pong!"
- `/plexprice` - Gets the current PLEX price in Jita from Eve Online
- `/amikool` - Checks if a user has the cool role
- `/vctop` - Shows the top users by voice channel time
- `/vcstats` - Shows voice channel statistics for a specific user
- `/seen` - Shows when a user was last seen in a voice channel
- Automatic Voice Channel Management - Automatically creates and manages voice channels when users join the lobby
- Voice Channel Time Tracking - Tracks and records time spent in voice channels

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
ENABLE_SEEN=true

# Role Configuration
COOL_ROLE_NAME=Verifyed Kool Kid
VC_TRACKING_ADMIN_ROLES=Admin,Moderator

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

## Voice Channel Tracking

When `ENABLE_VC_TRACKING` is enabled, the bot tracks:
- Time spent in voice channels
- User presence and activity
- Channel creation and deletion events

Available commands:
- `/vctop` - Shows the top users by total voice channel time
- `/vcstats` - Shows detailed voice channel statistics for a specific user
- `/seen` - Shows when a user was last seen in a voice channel

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

### Using GitHub Container Registry (GHCR)

1. Log in to GitHub Container Registry:
```bash
echo $GITHUB_TOKEN | docker login ghcr.io -u $GITHUB_USER --password-stdin
```

2. Set your GitHub username as an environment variable:
```bash
export GITHUB_USER=your_github_username
```

3. Start the production containers:
```bash
docker-compose -f docker-compose.prod.yml up -d
```

4. To stop the containers:
```bash
docker-compose -f docker-compose.prod.yml down
```

### Manual Build (Alternative)

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

## Release Process

The project uses Release Drafter to automatically create draft releases based on pull request labels and commit messages.

### Pull Request Labels

When creating a pull request, please use one of the following labels to categorize your changes:

- `feature` or `enhancement` - New features or improvements
- `bug` or `fix` - Bug fixes
- `documentation` - Documentation changes
- `chore`, `refactor`, or `dependencies` - Maintenance tasks
- `test` - Test-related changes

### Version Bumping

To specify the version bump for a release, use one of these labels:
- `major` - Major version bump (breaking changes)
- `minor` - Minor version bump (new features)
- `patch` - Patch version bump (bug fixes)

If no version label is specified, the default is a patch version bump.

## License

MIT
