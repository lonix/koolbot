# KoolBot

A Discord bot that automatically manages voice channels and tracks user activity. Perfect for gaming communities and Discord servers that need dynamic voice channel management.

## Quick Start

1. Download the required files:
```bash
# Download docker-compose.yml
curl -O https://raw.githubusercontent.com/your-username/koolbot/main/docker-compose.yml

# Download .env.example
curl -O https://raw.githubusercontent.com/your-username/koolbot/main/.env.example

# Rename .env.example to .env
mv .env.example .env
```

2. Edit the `.env` file with your Discord bot configuration:
```env
# Discord Configuration
DISCORD_TOKEN=your_discord_token
CLIENT_ID=your_client_id
GUILD_ID=your_guild_id

# Feature Flags (enable/disable features as needed)
ENABLE_VC_MANAGEMENT=true
ENABLE_VC_TRACKING=true
ENABLE_SEEN=true
ENABLE_PING=true
ENABLE_PLEXPRICE=true
ENABLE_AMIKOOL=true

# Voice Channel Settings
LOBBY_CHANNEL_NAME=Lobby
VC_CATEGORY_NAME=Dynamic Voice Channels
VC_PREFIX=s'-Room
```

3. Start the bot with Docker Compose:
```bash
docker-compose up -d
```

That's it! The bot will automatically:
- Create voice channels when users join the lobby
- Track time spent in voice channels
- Show voice channel statistics with `/vctop` and `/seen` commands

## Bot Commands

### Voice Channel Commands
- `/vctop` - Shows the top users by voice channel time
- `/vcstats` - Shows detailed voice channel statistics for a specific user
- `/seen` - Shows when a user was last seen in a voice channel

### Eve Online Commands
- `/plexprice` - Gets the current PLEX price in Jita from Eve Online

### Utility Commands
- `/ping` - Responds with "Pong!" (useful for checking if the bot is responsive)
- `/amikool` - Checks if a user has the cool role

## Voice Channel Features

### Automatic Channel Management
- When a user joins the lobby channel, a new voice channel is created
- Channels are named after the user who created them
- Empty channels are automatically deleted
- All channels are created in the "Dynamic Voice Channels" category

### Time Tracking
- Tracks time spent in voice channels
- Records user presence and activity
- Provides statistics through commands

## Configuration Options

### Environment Variables
| Variable | Description | Default |
|----------|-------------|---------|
| `DISCORD_TOKEN` | Your Discord bot token | Required |
| `CLIENT_ID` | Your Discord application ID | Required |
| `GUILD_ID` | Your Discord server ID | Required |
| `ENABLE_VC_MANAGEMENT` | Enable automatic voice channel management | true |
| `ENABLE_VC_TRACKING` | Enable voice channel time tracking | true |
| `ENABLE_SEEN` | Enable last seen tracking | true |
| `ENABLE_PING` | Enable ping command | true |
| `ENABLE_PLEXPRICE` | Enable PLEX price command | true |
| `ENABLE_AMIKOOL` | Enable amikool command | true |
| `LOBBY_CHANNEL_NAME` | Name of the lobby channel | Lobby |
| `VC_CATEGORY_NAME` | Name of the voice channel category | Dynamic Voice Channels |
| `VC_PREFIX` | Prefix for created voice channels | s'-Room |

## Maintenance

### Viewing Logs
```bash
docker-compose logs -f
```

### Updating the Bot
```bash
docker-compose pull
docker-compose up -d
```

### Stopping the Bot
```bash
docker-compose down
```

## Troubleshooting

### Common Issues

1. **Bot can't create channels**
   - Ensure the bot has the "Manage Channels" permission
   - Check if the bot has permissions in the target category

2. **Commands not working**
   - Verify the bot has the "applications.commands" scope
   - Check if the bot has the necessary permissions
   - Ensure the corresponding feature flag is enabled in `.env`

3. **Time tracking not working**
   - Ensure `ENABLE_VC_TRACKING` is set to true
   - Check if MongoDB is running properly

### Getting Help

If you encounter any issues:
1. Check the logs with `docker-compose logs -f`
2. Verify your environment variables
3. Ensure the bot has all required permissions

## Support

For additional help or feature requests, please open an issue in the GitHub repository.
