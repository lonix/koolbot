# KoolBot Settings Reference

This document provides a comprehensive reference for all configurable settings in KoolBot.

## Migration Notice

**Important**: The bot no longer automatically migrates old flat settings (like `ENABLE_PING`) to the new dot notation format. 

If you have old settings in your database, you'll see warnings in the bot logs. To migrate them, run:

```bash
npm run migrate-config
```

# KoolBot Settings Reference

This document provides a comprehensive reference for all configurable settings in KoolBot.

## Migration Notice

The bot no longer automatically migrates old flat settings (like `ENABLE_PING`) to the new dot notation format. If you have old settings, warnings will appear in logs. To migrate manually:

```bash
npm run migrate-config
```

## Settings Hierarchy

All settings use hierarchical dot notation for clarity.

### Command Enablement

| Setting | Default | Description |
|---------|---------|-------------|
| `ping.enabled` | `false` | Enable/disable the ping command |
| `amikool.enabled` | `false` | Enable/disable the amikool command |
| `quotes.enabled` | `false` | Enable/disable the quote system |

### Fun / Easter Eggs

| Setting | Default | Description |
|---------|---------|-------------|
| `fun.friendship` | `false` | Passive friendship listener responses to “best ship” / “worst ship” queries |

### Amikool Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `amikool.role.name` | `""` | Name of the role used for `/amikool` verification |

### Quote System Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `quotes.cooldown` | `60` | Seconds between quote additions |
| `quotes.max_length` | `1000` | Maximum quote length |
| `quotes.add_roles` | `""` | Roles allowed to add quotes (comma-separated IDs) |
| `quotes.delete_roles` | `""` | Roles allowed to delete quotes (comma-separated IDs) |

### Voice Channel Management

| Setting | Default | Description |
|---------|---------|-------------|
| `voicechannels.enabled` | `false` | Enable voice channel management |
| `voicechannels.category.name` | `"Voice Channels"` | Category name for managed channels |
| `voicechannels.lobby.name` | `"Lobby"` | Online lobby channel name |
| `voicechannels.lobby.offlinename` | `"Offline Lobby"` | Offline lobby channel name |
| `voicechannels.channel.prefix` | `"🎮"` | Prefix for dynamically created channels |
| `voicechannels.channel.suffix` | `""` | Suffix for dynamically created channels |

### Voice Channel Tracking

| Setting | Default | Description |
|---------|---------|-------------|
| `voicetracking.enabled` | `false` | Enable voice channel tracking |
| `voicetracking.seen.enabled` | `false` | Enable `/seen` last-seen tracking |
| `voicetracking.excluded_channels` | `""` | Comma-separated voice channel IDs to exclude |
| `voicetracking.admin_roles` | `""` | Comma-separated role IDs with tracking admin powers |

### Voice Channel Announcements

| Setting | Default | Description |
|---------|---------|-------------|
| `voicetracking.announcements.enabled` | `false` | Enable weekly stats announcement |
| `voicetracking.announcements.channel` | `"voice-stats"` | Channel name or ID for announcements |
| `voicetracking.announcements.schedule` | `"0 16 * * 5"` | Cron (Fridays 16:00) |

### Voice Channel Cleanup

| Setting | Default | Description |
|---------|---------|-------------|
| `voicetracking.cleanup.enabled` | `false` | Enable automatic data cleanup |
| `voicetracking.cleanup.schedule` | `"0 0 * * *"` | Daily midnight cron |
| `voicetracking.cleanup.retention.detailed_sessions_days` | `30` | Days to keep detailed sessions |
| `voicetracking.cleanup.retention.monthly_summaries_months` | `6` | Months to keep monthly summaries |
| `voicetracking.cleanup.retention.yearly_summaries_years` | `1` | Years to keep yearly summaries |

### Core Bot Logging (Discord)

| Setting | Default | Description |
|---------|---------|-------------|
| `core.startup.enabled` | `false` | Enable startup/shutdown logging |
| `core.startup.channel_id` | `""` | Channel ID for startup/shutdown logs |
| `core.errors.enabled` | `false` | Enable error logging |
| `core.errors.channel_id` | `""` | Channel ID for error logs |
| `core.cleanup.enabled` | `false` | Enable cleanup logging |
| `core.cleanup.channel_id` | `""` | Channel ID for cleanup logs |
| `core.config.enabled` | `false` | Enable config change logging |
| `core.config.channel_id` | `""` | Channel ID for config logs |
| `core.cron.enabled` | `false` | Enable cron job logging |
| `core.cron.channel_id` | `""` | Channel ID for cron logs |

## Configuration Commands

### List Settings

```bash
/config list
```

Shows all current configuration settings organized by category.

### Get Setting Value

```bash
/config get key:ping.enabled
```

Retrieves the current value of a specific setting.

### Set Setting Value

```bash
/config set key:ping.enabled value:false
```

Updates a setting. The system automatically converts:
- `"true"` / `"false"` to boolean
- Numeric strings to numbers
- Role/channel mentions to IDs

### Reset Setting

```bash
/config reset key:ping.enabled
```

Resets a setting to its default value.

### Reload Commands

```bash
/config reload
```

Important: After enabling/disabling commands, run this to sync with Discord.

### Import / Export Configuration

```bash
/config import
/config export
```

Import configuration from or export to YAML files for backup/migration.

## Environment Variables (.env)

The following variables are critical and must be set in `.env`:

```env
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_client_id_here
MONGODB_URI=mongodb://localhost:27017/koolbot
DEBUG=false
NODE_ENV=production
# Optional: Only needed temporarily for guild command cleanup
GUILD_ID=your_guild_id_here
```

## Discord Logging Configuration

Enable logging categories using `core.*` keys.

### Startup / Shutdown

```bash
/config set key:core.startup.enabled value:true
/config set key:core.startup.channel_id value:123456789
```

### Errors

```bash
/config set key:core.errors.enabled value:true
/config set key:core.errors.channel_id value:987654321
```

### Cleanup

```bash
/config set key:core.cleanup.enabled value:true
/config set key:core.cleanup.channel_id value:555666777
```

### Config Changes

```bash
/config set key:core.config.enabled value:true
/config set key:core.config.channel_id value:111222333
```

### Cron Jobs

```bash
/config set key:core.cron.enabled value:true
/config set key:core.cron.channel_id value:444555666
```

**Available Log Types:**
- `core.startup.*` – Startup/shutdown & service init
- `core.errors.*` – Critical errors
- `core.cleanup.*` – Data cleanup reports
- `core.config.*` – Configuration reload/change
- `core.cron.*` – Scheduled task execution

## Voice Channel Cleanup Configuration

Automatically removes old session data while preserving summaries.

### Retention
- Detailed sessions: 30 days (default)
- Monthly summaries: 6 months (default)
- Yearly summaries: 1 year (default)

### Schedule
- Default daily midnight: `0 0 * * *`
- Customizable via cron
- Manual run: `/dbtrunk run`

### Cleanup Report Includes
- Sessions removed
- Data aggregated
- Execution duration
- Errors (if any)

## Migration From Old Settings

Use `npm run migrate-config` for controlled migration of legacy env-based keys.

## Best Practices

1. Always run `/config reload` after enabling/disabling commands.
2. Use exact dot-notation keys.
3. Provide IDs or mentions; comma-separated lists without spaces.
4. Enable Discord logging for production observability.
5. Tune cleanup retention to server needs.

## Examples

Disable ping:
```bash
/config set key:ping.enabled value:false
/config reload
```

Set quote cooldown:
```bash
/config set key:quotes.cooldown value:120
```

Configure voice channel category:
```bash
/config set key:voicechannels.category.name value:"Gaming Channels"
```

Set tracking admin roles:
```bash
/config set key:voicetracking.admin_roles value:@Admin,@Moderator
```

Enable startup logging:
```bash
/config set key:core.startup.enabled value:true
/config set key:core.startup.channel_id value:123456789
```

Enable data cleanup:
```bash
/config set key:voicetracking.cleanup.enabled value:true
/config set key:voicetracking.cleanup.retention.detailed_sessions_days value:60
```

## Related Documentation

- [README.md](README.md) – Overview & setup
- [COMMANDS.md](COMMANDS.md) – Command reference
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) – Common issues
/config set key:voicetracking.cleanup.retention.detailed_sessions_days value:60
