# KoolBot Settings Reference

This document provides a comprehensive reference for all configurable settings in KoolBot.

## Migration Notice

**Important**: The bot no longer automatically migrates old flat settings (like `ENABLE_PING`) to the new dot notation format. 

If you have old settings in your database, you'll see warnings in the bot logs. To migrate them, run:

```bash
npm run migrate-config
```

This ensures you have full control over when migrations happen and prevents unexpected behavior during startup.

## Settings Hierarchy

All settings use a hierarchical dot notation structure for better organization and clarity.

### Command Enablement

| Setting | Default | Description |
|---------|---------|-------------|
| `ping.enabled` | `true` | Enable/disable the ping command |
| `amikool.enabled` | `true` | Enable/disable the amikool command |
| `plexprice.enabled` | `true` | Enable/disable the plexprice command |
| `quotes.enabled` | `true` | Enable/disable the quote system |

### Amikool Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `amikool.role.name` | `"HR"` | Name of the cool role for verification |

### Quote System Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `quotes.cooldown` | `60` | Cooldown between quote additions (seconds) |
| `quotes.max_length` | `1000` | Maximum length for quotes |
| `quotes.add_roles` | `""` | Roles that can add quotes (comma-separated IDs) |
| `quotes.delete_roles` | `""` | Roles that can delete quotes (comma-separated IDs) |

### Voice Channel Management

| Setting | Default | Description |
|---------|---------|-------------|
| `voicechannels.enabled` | `true` | Enable/disable voice channel management |
| `voicechannels.category.name` | `"Voice Channels"` | Category name for voice channels |
| `voicechannels.lobby.name` | `"🟢 Lobby"` | Online lobby channel name |
| `voicechannels.lobby.offlinename` | `"🔴 Lobby"` | Offline lobby channel name |
| `voicechannels.channel.prefix` | `"🎮"` | Prefix for dynamically created channels |
| `voicechannels.channel.suffix` | `""` | Suffix for dynamically created channels |

### Voice Channel Tracking

| Setting | Default | Description |
|---------|---------|-------------|
| `voicetracking.enabled` | `true` | Enable/disable voice channel tracking |
| `voicetracking.seen.enabled` | `true` | Enable/disable last seen tracking |
| `voicetracking.excluded_channels` | `""` | Excluded voice channels (comma-separated IDs) |
| `voicetracking.admin_roles` | `""` | Admin roles for tracking (comma-separated IDs) |

### Voice Channel Announcements

| Setting | Default | Description |
|---------|---------|-------------|
| `voicetracking.announcements.enabled` | `true` | Enable/disable weekly announcements |
| `voicetracking.announcements.channel` | `"announcement"` | Channel for announcements |
| `voicetracking.announcements.schedule` | `"0 16 * * 5"` | Cron schedule for announcements (Fridays at 4 PM) |

## Configuration Commands

### List Settings
```
/config list
```
Shows all current configuration settings organized by category.

### Get Setting Value
```
/config get key:ping.enabled
```
Retrieves the current value of a specific setting.

### Set Setting Value
```
/config set key:ping.enabled value:false
```
Updates a setting to a new value. The system automatically converts:
- `"true"`/`"false"` strings to boolean values
- Numeric strings to numbers
- Role/channel mentions to IDs

### Reset Setting
```
/config reset key:ping.enabled
```
Resets a setting to its default value.

### Reload Commands
```
/config reload
```
**Important**: After changing command enable/disable settings, you must run this command to update Discord. This ensures that disabled commands are properly removed and enabled commands are registered.

## Environment Variables (.env)

The following settings are **critical** and must be configured in the `.env` file:

```env
# Critical Bot Configuration
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_client_id_here
MONGODB_URI=mongodb://localhost:27017/koolbot
DEBUG=false
NODE_ENV=production

# Note: GUILD_ID is only needed temporarily to clean up any existing guild commands
# Can be removed after initial cleanup is complete
GUILD_ID=your_guild_id_here
```

## Migration from Old Settings

KoolBot automatically migrates old flat settings (e.g., `ENABLE_PING`) to the new dot notation format (e.g., `ping.enabled`) on startup. Old settings are automatically cleaned up after successful migration.

## Best Practices

1. **Always use `/config reload`** after changing command enable/disable settings
2. **Use the exact setting keys** as shown in this document
3. **Boolean values** can be set as `true`/`false` or `"true"`/`"false"`
4. **Role and channel IDs** can be provided as mentions or raw IDs
5. **Multiple IDs** should be comma-separated without spaces

## Examples

### Disable Ping Command
```
/config set key:ping.enabled value:false
/config reload
```

### Set Quote Cooldown
```
/config set key:quotes.cooldown value:120
```

### Configure Voice Channel Category
```
/config set key:voicechannels.category.name value:"Gaming Channels"
```

### Set Admin Roles for Tracking
```
/config set key:voicetracking.admin_roles value:@Admin,@Moderator
```
