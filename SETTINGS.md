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
| `ping.enabled` | `false` | Enable/disable the ping command |
| `amikool.enabled` | `false` | Enable/disable the amikool command |
| `quotes.enabled` | `false` | Enable/disable the quote system |


### Fun / Easter Eggs

| Setting | Default | Description |
|---------|---------|-------------|
| `fun.friendship` | `false` | Enable passive friendship listener responses to "best ship" / "worst ship" queries |

### Amikool Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `amikool.role.name` | `""` | Name of the cool role for verification |

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
| `voicechannels.enabled` | `false` | Enable/disable voice channel management |
| `voicechannels.category.name` | `"Voice Channels"` | Category name for voice channels |
| `voicechannels.lobby.name` | `"Lobby"` | Online lobby channel name |
| `voicechannels.lobby.offlinename` | `"Offline Lobby"` | Offline lobby channel name |
| `voicechannels.channel.prefix` | `"🎮"` | Prefix for dynamically created channels |
| `voicechannels.channel.suffix` | `""` | Suffix for dynamically created channels |

### Voice Channel Tracking

| Setting | Default | Description |
|---------|---------|-------------|
| `voicetracking.enabled` | `false` | Enable/disable voice channel tracking |
| `voicetracking.seen.enabled` | `false` | Enable/disable last seen tracking |
| `voicetracking.excluded_channels` | `""` | Excluded voice channels (comma-separated IDs) |
| `voicetracking.admin_roles` | `""` | Admin roles for tracking (comma-separated IDs) |

### Voice Channel Announcements

| Setting | Default | Description |
|---------|---------|-------------|
| `voicetracking.announcements.enabled` | `false` | Enable/disable weekly announcements |
| `voicetracking.announcements.channel` | `"voice-stats"` | Channel for announcements |
| `voicetracking.announcements.schedule` | `"0 16 * * 5"` | Cron schedule for announcements (Fridays at 4 PM) |

### Voice Channel Cleanup

| Setting | Default | Description |
|---------|---------|-------------|
| `voicetracking.cleanup.enabled` | `false` | Enable/disable automatic data cleanup |
| `voicetracking.cleanup.schedule` | `"0 0 * * *"` | Cron schedule for cleanup (daily at midnight) |
| `voicetracking.cleanup.retention.detailed_sessions_days` | `30` | Days to keep detailed session data |
| `voicetracking.cleanup.retention.monthly_summaries_months` | `6` | Months to keep monthly summaries |
| `voicetracking.cleanup.retention.yearly_summaries_years` | `1` | Years to keep yearly summaries |

### Core Bot Logging (Discord)

| Setting | Default | Description |
|---------|---------|-------------|
| `core.startup.enabled` | `false` | Enable/disable startup/shutdown logging to Discord |
| `core.startup.channel_id` | `""` | Channel ID for startup/shutdown logs |
| `core.errors.enabled` | `false` | Enable/disable error logging to Discord |
| `core.errors.channel_id` | `""` | Channel ID for error logs |
| `core.cleanup.enabled` | `false` | Enable/disable cleanup logging to Discord |
| `core.cleanup.channel_id` | `""` | Channel ID for cleanup logs |
| `core.config.enabled` | `false` | Enable/disable config change logging to Discord |
| `core.config.channel_id` | `""` | Channel ID for config logs |
| `core.cron.enabled` | `false` | Enable/disable cron job logging to Discord |
| `core.cron.channel_id` | `""` | Channel ID for cron logs |

## Configuration Commands

### List Settings
```bash
/config list
Shows all current configuration settings organized by category.

### Get Setting Value
```


```bash
/config get key:ping.enabled
```
 
Retrieves the current value of a specific setting.

### Set Setting Value
```


```bash
/config set key:ping.enabled value:false
```

```
Updates a setting to a new value. The system automatically converts:
- `"true"`/`"false"` strings to boolean values
- Numeric strings to numbers
- Role/channel mentions to IDs

```

### Reset Setting

```bash
/config reset key:ping.enabled
```
Resets a setting to its default value.

### Reload Commands

```bash
/config reload
```
**Important**: After changing command enable/disable settings, you must run this command to update Discord. This ensures that disabled commands are properly removed and enabled commands are registered.

### Import/Export Configuration

```bash
/config import
/config export
```
Import configuration from or export configuration to YAML files for backup and migration purposes.

## Environment Variables (.env)

```

The following settings are **critical** and must be configured in the `.env` file:

```env
# Critical Bot Configuration
DISCORD_TOKEN=your_bot_token_here
```

CLIENT_ID=your_client_id_here
MONGODB_URI=mongodb://localhost:27017/koolbot
DEBUG=false
NODE_ENV=production

```

# Note: GUILD_ID is only needed temporarily to clean up any existing guild commands
# Can be removed after initial cleanup is complete
GUILD_ID=your_guild_id_here
```

```

## Discord Logging Configuration

The bot can log important events to Discord channels using the `core.*` configuration structure:

### Startup/Shutdown Logging
```

```bash
# Enable startup/shutdown logging to #bot-status channel
/config set key:core.startup.enabled value:true
/config set key:core.startup.channel_id value:123456789
```

### Error Logging
```bash
# Enable error logging to #admin-alerts channel  
/config set key:core.errors.enabled value:true
/config set key:core.errors.channel_id value:987654321
```

### Cleanup Logging
```bash
# Enable cleanup logging to #bot-logs channel
/config set key:core.cleanup.enabled value:true
/config set key:core.cleanup.channel_id value:555666777
```

### Configuration Change Logging
```bash
# Enable configuration change logging
/config set key:core.config.enabled value:true
/config set key:core.config.channel_id value:111222333
```

### Cron Job Logging
```bash
# Enable cron job logging
/config set key:core.cron.enabled value:true
/config set key:core.cron.channel_id value:444555666
```

**Available Log Types:**
- **`core.startup.*`** - Bot startup/shutdown, service initialization, Discord registration
- **`core.errors.*`** - Critical errors and problems that need admin attention
- **`core.cleanup.*`** - Voice channel cleanup results and status
- **`core.config.*`** - Configuration reloads and changes
- **`core.cron.*`** - Scheduled task execution results

## Voice Channel Cleanup Configuration

The voice channel cleanup system automatically removes old session data while preserving aggregated statistics:

### Retention Settings
- **Detailed Sessions**: Keep individual session records for 30 days by default
- **Monthly Summaries**: Keep monthly aggregated data for 6 months by default
- **Yearly Summaries**: Keep yearly aggregated data for 1 year by default

### Cleanup Schedule
- **Default**: Daily at midnight (`0 0 * * *`)
- **Customizable**: Use standard cron syntax
- **Manual Execution**: Use `/dbtrunk run` command

### Cleanup Results
The system provides detailed reports including:
- Number of sessions removed
- Data aggregated into summaries
- Execution time
- Any errors encountered

## Migration from Old Settings

KoolBot automatically migrates old flat settings (e.g., `ENABLE_PING`) to the new dot notation format (e.g., `ping.enabled`) on startup. Old settings are automatically cleaned up after successful migration.

## Best Practices

1. **Always use `/config reload`** after changing command enable/disable settings
2. **Use the exact setting keys** as shown in this document
3. **Boolean values** can be set as `true`/`false` or `"true"`/`"false"`
4. **Role and channel IDs** can be provided as mentions or raw IDs
5. **Multiple IDs** should be comma-separated without spaces
6. **Enable Discord logging** for production environments to monitor bot health
7. **Configure cleanup schedules** based on your data retention needs

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

### Enable Discord Logging
```
/config set key:core.startup.enabled value:true
/config set key:core.startup.channel_id value:#bot-status
```

### Configure Data Cleanup
```
/config set key:voicetracking.cleanup.enabled value:true
/config set key:voicetracking.cleanup.retention.detailed_sessions_days value:60
```

## Related Documentation

- **[README.md](README.md)**: Bot overview and setup instructions
- **[COMMANDS.md](COMMANDS.md)**: Complete command reference
- **[TROUBLESHOOTING.md](TROUBLESHOOTING.md)**: Common issues and solutions
