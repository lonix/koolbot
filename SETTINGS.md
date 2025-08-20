# KoolBot Settings Configuration

This document describes all configurable settings for KoolBot using the new dot notation system.

## Settings Hierarchy

All settings use dot notation for logical grouping and easy identification. The format is: `category.subcategory.setting`

## Voice Channel Management (`voicechannels.*`)

Settings for dynamic creation, deletion, and management of voice channels.

### Core Settings
- **`voicechannels.enabled`** (boolean) - Enable/disable dynamic voice channel management
- **`voicechannels.category.name`** (string) - Name of the category for voice channels
- **`voicechannels.lobby.name`** (string) - Name of the lobby channel
- **`voicechannels.lobby.offlinename`** (string) - Name of the offline lobby channel
- **`voicechannels.channel.prefix`** (string) - Prefix for dynamically created channels
- **`voicechannels.channel.suffix`** (string) - Suffix for dynamically created channels

### Default Values
```json
{
  "voicechannels.enabled": false,
  "voicechannels.category.name": "Voice Channels",
  "voicechannels.lobby.name": "Lobby",
  "voicechannels.lobby.offlinename": "Offline Lobby",
  "voicechannels.channel.prefix": "🎮",
  "voicechannels.channel.suffix": ""
}
```

## Voice Activity Tracking (`voicetracking.*`)

Settings for tracking voice channel activity, statistics, and announcements.

### Core Settings
- **`voicetracking.enabled`** (boolean) - Enable/disable voice activity tracking
- **`voicetracking.seen.enabled`** (boolean) - Enable/disable last seen tracking
- **`voicetracking.excluded_channels`** (string) - Comma-separated list of voice channel IDs to exclude from tracking
- **`voicetracking.announcements.enabled`** (boolean) - Enable/disable weekly voice channel announcements
- **`voicetracking.announcements.channel`** (string) - Channel name for voice channel announcements
- **`voicetracking.announcements.schedule`** (string) - Cron expression for weekly announcements
- **`voicetracking.admin_roles`** (string) - Comma-separated role names that can manage tracking

### Default Values
```json
{
  "voicetracking.enabled": false,
  "voicetracking.seen.enabled": false,
  "voicetracking.excluded_channels": "",
  "voicetracking.announcements.enabled": false,
  "voicetracking.announcements.schedule": "0 16 * * 5",
  "voicetracking.announcements.channel": "voice-stats",
  "voicetracking.admin_roles": ""
}
```

## Individual Feature Settings

### Ping Command (`ping.*`)
- **`ping.enabled`** (boolean) - Enable/disable ping command

### Amikool Command (`amikool.*`)
- **`amikool.enabled`** (boolean) - Enable/disable amikool command
- **`amikool.role.name`** (string) - Role name required to use amikool command

### PLEX Price Checker (`plexprice.*`)
- **`plexprice.enabled`** (boolean) - Enable/disable PLEX price checker

### Quote System (`quotes.*`)
- **`quotes.enabled`** (boolean) - Enable/disable quote system
- **`quotes.add_roles`** (string) - Comma-separated role IDs that can add quotes
- **`quotes.delete_roles`** (string) - Comma-separated role IDs that can delete quotes
- **`quotes.max_length`** (number) - Maximum quote length
- **`quotes.cooldown`** (number) - Cooldown in seconds between quote additions

### Default Values
```json
{
  "ping.enabled": false,
  "amikool.enabled": false,
  "amikool.role.name": "",
  "plexprice.enabled": false,
  "quotes.enabled": false,
  "quotes.add_roles": "",
  "quotes.delete_roles": "",
  "quotes.max_length": 1000,
  "quotes.cooldown": 60
}
```

## Configuration Commands

Use the following commands to manage settings:

### List all settings:
```
/config list
```

### List settings by category:
```
/config list category:voicechannels
/config list category:voicetracking
/config list category:quotes
```

### Get a specific setting:
```
/config get key:voicechannels.enabled
/config get key:voicetracking.announcements.schedule
```

### Change a setting:
```
/config set key:voicechannels.enabled value:true
/config set key:voicetracking.excluded_channels value:123456789,987654321
/config set key:quotes.max_length value:500
```

### Reset a setting to default:
```
/config reset key:voicechannels.category.name
/config reset key:voicetracking.announcements.schedule
```

## Migration from Old Format

The old flat settings format (e.g., `ENABLE_VC_MANAGEMENT`) is being migrated to the new dot notation format. Use the migration script to convert existing settings:

```bash
npm run migrate-config
```

## Environment Variables

Critical startup settings remain in `.env` and cannot be changed via `/config`:
- `DISCORD_TOKEN` - Bot authentication token
- `GUILD_ID` - Target Discord server ID
- `CLIENT_ID` - Bot client ID
- `MONGODB_URI` - Database connection string
- `DEBUG` - Debug mode flag
- `NODE_ENV` - Environment (development/production)

## Examples

### Enable voice channel management:
```
/config set key:voicechannels.enabled value:true
```

### Set lobby channel name:
```
/config set key:voicechannels.lobby.name value:"🎮 Gaming Lobby"
```

### Configure weekly announcements:
```
/config set key:voicetracking.announcements.enabled value:true
/config set key:voicetracking.announcements.schedule value:"0 18 * * 5"
/config set key:voicetracking.announcements.channel value:"voice-stats"
```

### Set amikool role requirement:
```
/config set key:amikool.role.name value:"Gamer"
```

### Configure quote system:
```
/config set key:quotes.enabled value:true
/config set key:quotes.max_length value:2000
/config set key:quotes.cooldown value:30
```
