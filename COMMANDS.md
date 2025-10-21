# KoolBot Commands Reference

This document provides a comprehensive reference for all available commands in KoolBot, organized by user permission level.

## 📋 Command Categories

- **User Commands**: Available to all users
- **Admin Commands**: Require Administrator permissions
- **Owner Commands**: Special commands for bot owners

---

## 👥 User Commands

These commands are available to all users in the server.

### `/ping`

**Description**: Basic connectivity test to verify the bot is responding  
**Usage**: `/ping`  
**Response**: Pong! (with response time)

### `/amikool`

**Description**: Role-based verification command  
**Usage**: `/amikool`  
**Requirements**: Bot must have a role configured in `amikool.role.name`  
**Response**: Confirms if the user has the required role

### `/vctop`

**Description**: View voice channel leaderboards  
**Usage**: `/vctop [timeframe]`  
**Timeframes**: `week`, `month`, `alltime`  
**Requirements**: Voice tracking must be enabled (`voicetracking.enabled: true`)  
**Response**: Leaderboard showing top voice channel users

### `/vcstats`

**Description**: View personal voice channel statistics  
**Usage**: `/vcstats [timeframe]`  
**Timeframes**: `week`, `month`, `alltime`  
**Requirements**: Voice tracking must be enabled (`voicetracking.enabled: true`)  
**Response**: Personal statistics including total time and session count

### `/seen`

**Description**: Check when a user was last seen in voice channels  
**Usage**: `/seen [user]`  
**Requirements**: Voice tracking must be enabled (`voicetracking.seen.enabled: true`)  
**Response**: Last seen timestamp and channel information

### `/transfer-ownership`

**Description**: Transfer ownership of a voice channel to another user  
**Usage**: `/transfer-ownership [user]`  
**Requirements**:

- Voice channel management must be enabled (`voicechannels.enabled: true`)
- User must be in a voice channel
- User must be the current channel owner  
**Response**: Confirmation of ownership transfer

### `/quote`

**Description**: Quote management system  
**Usage**: `/quote [action] [options]`  
**Actions**:

- `add [text]` - Add a new quote
- `random` - Get a random quote
- `search [query]` - Search quotes
- `list [page]` - List all quotes  
**Requirements**: Quote system must be enabled (`quotes.enabled: true`)  
**Response**: Varies by action

---

## 🔧 Admin Commands

These commands require Administrator permissions in the Discord server.

### `/config`

**Description**: Comprehensive configuration management  
**Usage**: `/config [action] [options]`  
**Actions**:

#### `/config list`

**Description**: Display all current configuration settings  
**Usage**: `/config list`  
**Response**: Organized list of all settings by category

#### `/config get`

**Description**: Get the value of a specific setting  
**Usage**: `/config get key:[setting_key]`  
**Example**: `/config get key:ping.enabled`  
**Response**: Current value of the specified setting

#### `/config set`

**Description**: Set a configuration value  
**Usage**: `/config set key:[setting_key] value:[new_value]`  
**Example**: `/config set key:ping.enabled value:true`  
**Response**: Confirmation of the change

#### `/config reset`

**Description**: Reset a setting to its default value  
**Usage**: `/config reset key:[setting_key]`  
**Example**: `/config reset key:ping.enabled`  
**Response**: Confirmation of the reset

#### `/config reload`

**Description**: Reload all commands to Discord API  
**Usage**: `/config reload`  
**Requirements**: Must be run after changing command enable/disable settings  
**Response**: Confirmation of command reload

#### `/config import`

**Description**: Import configuration from a YAML file  
**Usage**: `/config import` (with file attachment)  
**Requirements**: YAML file attachment  
**Response**: Summary of imported settings

#### `/config export`

**Description**: Export current configuration to YAML file  
**Usage**: `/config export`  
**Response**: YAML file download

### `/announce-vc-stats`

**Description**: Manually trigger voice channel statistics announcement  
**Usage**: `/announce-vc-stats`  
**Requirements**:

- Voice tracking must be enabled (`voicetracking.enabled: true`)
- Announcements must be enabled (`voicetracking.announcements.enabled: true`)  
**Response**: Confirmation of announcement sent

### `/dbtrunk`

**Description**: Voice channel database cleanup management  
**Usage**: `/dbtrunk [action]`  
**Actions**:

#### `/dbtrunk status`

**Description**: Show cleanup service status  
**Usage**: `/dbtrunk status`  
**Response**: Service status, database connection, and last cleanup date

#### `/dbtrunk run`

**Description**: Run cleanup immediately  
**Usage**: `/dbtrunk run`  
**Response**: Cleanup results including sessions removed and data aggregated

### `/vc`

**Description**: Voice channel management  
**Usage**: `/vc [action]`  
**Actions**:

#### `/vc reload`

**Description**: Clean up empty voice channels  
**Usage**: `/vc reload`  
**Requirements**: Voice channel management must be enabled (`voicechannels.enabled: true`)  
**Response**: Confirmation of cleanup completion

#### `/vc force-reload`

**Description**: Force cleanup of ALL unmanaged channels in category  
**Usage**: `/vc force-reload`  
**Requirements**: Voice channel management must be enabled (`voicechannels.enabled: true`)  
**Response**: Confirmation of force cleanup completion

### `/botstats`

**Description**: View bot performance statistics  
**Usage**: `/botstats`  
**Response**: Bot uptime, command usage, and performance metrics

### `/exclude-channel`

**Description**: Exclude a voice channel from tracking  
**Usage**: `/exclude-channel [channel]`  
**Requirements**: Voice tracking must be enabled (`voicetracking.enabled: true`)  
**Response**: Confirmation of channel exclusion

### `/setup-lobby`

**Description**: Configure voice channel lobby system  
**Usage**: `/setup-lobby`  
**Requirements**: Voice channel management must be enabled (`voicechannels.enabled: true`)  
**Response**: Confirmation of lobby setup

---

## 🔒 Permission Requirements

### User Commands

- **Basic**: No special permissions required
- **Voice Commands**: User must be in a voice channel (where applicable)
- **Quote Commands**: May be restricted by role-based permissions

### Admin Commands

- **Discord Permission**: Administrator permission in the server
- **Bot Permission**: Bot must have appropriate permissions in the server
- **Feature Enablement**: Related features must be enabled in configuration

---

## ⚙️ Command Configuration

Commands can be enabled/disabled using the configuration system:

```bash
# Enable ping command
/config set key:ping.enabled value:true

# Disable amikool command  
/config set key:amikool.enabled value:false

# Reload commands after changes
/config reload
```

**Important**: After changing command enable/disable settings, you must run `/config reload` to update Discord.

---

## 📚 Related Documentation

- **[README.md](README.md)**: Bot overview and setup instructions
- **[SETTINGS.md](SETTINGS.md)**: Complete configuration reference
- **[TROUBLESHOOTING.md](TROUBLESHOOTING.md)**: Common issues and solutions

---

## 🚨 Troubleshooting Commands

### Command Not Found

- Check if the command is enabled in configuration
- Run `/config reload` after enabling commands
- Verify bot has proper Discord permissions

### Permission Denied

- Ensure user has Administrator permissions
- Check bot's role hierarchy in the server
- Verify feature is enabled in configuration

### Feature Not Working

- Check if the related feature is enabled
- Verify configuration settings are correct
- Check bot logs for error messages
