# KoolBot Release Notes

## v0.5.0 - Bot Status & Dynamic Voice Channels

**Release Date**: January 2025  
**Major Release** - New features and architectural improvements

### ✨ **New Features**

#### Bot Status System
- **Dynamic Status Colors**: Bot now shows different colors based on operational state
  - 🟡 **Yellow (Idle)**: Connecting to Discord, reloading configuration, shutting down
  - 🟢 **Green (Online)**: Fully operational and ready
  - ⚫ **Invisible**: Final shutdown state
- **Smart Activity Updates**: 
  - "Watching nobody" when no users in voice channels
  - "Watching over X nerds" when users are connected
  - Real-time updates triggered by voice state changes
- **Graceful Shutdown**: Clean status transitions during bot exit

#### Dynamic Voice Channel Management
- **Smart Lobby System**: 
  - Single lobby channel that renames based on bot status
  - "🟢 Lobby" when online, "🔴 Lobby" when offline
  - Automatic channel creation for users joining the lobby
- **User Channel Creation**: Dynamic private channels with proper permissions
- **Intelligent Cleanup**: Removes unmanaged channels and empty managed ones

#### Data Maintenance System
- **Automated Cleanup**: Configurable retention periods for voice tracking data
- **Data Aggregation**: Preserves statistics while removing old sessions
- **Discord Notifications**: Cleanup results reported to configured channels

### 🔧 **Command Updates**

#### New Commands
- **`/dbtrunk`**: Database cleanup management
  - `status` - Show cleanup service status
  - `run` - Execute cleanup immediately
- **`/vc`**: Voice channel management
  - `reload` - Clean up empty channels
  - `force-reload` - Force cleanup of all unmanaged channels

#### Enhanced Commands
- **`/config`**: Added import/export functionality
  - `import` - Import configuration from YAML file
  - `export` - Export configuration to YAML file
  - `reload` - Reload commands to Discord API
  - `reset` - Reset settings to defaults

#### Command Architecture
- **Split `/vc-cleanup`** into two focused commands for better separation of concerns
- **Dynamic Command Loading**: Commands now load based on configuration instead of hardcoded
- **Conditional Registration**: Commands only appear when their features are enabled

### ⚙️ **Configuration Enhancements**

#### New Settings
- **`core.*`**: Discord logging configuration
  - `core.startup.*` - Bot lifecycle events
  - `core.errors.*` - Critical error logging
  - `core.cleanup.*` - Data cleanup notifications
  - `core.config.*` - Configuration change logging
  - `core.cron.*` - Scheduled task logging

- **`voicetracking.cleanup.*`**: Data maintenance configuration
  - Retention periods for detailed sessions, monthly summaries, yearly summaries
  - Configurable cleanup scheduling using cron syntax

#### Import/Export System
- **YAML Support**: Full configuration backup and restore
- **File Attachments**: Import/export via Discord file uploads
- **Schema Validation**: Ensures configuration integrity

### 🐛 **Bug Fixes**

- **Fixed Double "Watching"**: Bot activity now shows clean messages without Discord.js prefix duplication
- **Database Connection Status**: Cleanup commands now show accurate connection status
- **Command Registration**: Improved reliability of command loading and registration
- **Voice Channel Cleanup**: Fixed issues with channel management and cleanup logic

### 📚 **Documentation**

- **`COMMANDS.md`**: Complete command reference organized by permission level
- **`SETTINGS.md`**: Updated with all current settings and examples
- **`README.md`**: Enhanced with current features and proper cross-linking
- **Cross-References**: All documentation now properly linked

### 🚀 **Technical Improvements**

- **TypeScript**: Enhanced type safety throughout the codebase
- **Error Handling**: Better error messages and status reporting
- **Code Quality**: Improved linting and formatting
- **Architecture**: Cleaner separation of concerns and better modularity

---

## Migration Notes

### From v0.4.0
- **Command Changes**: `/vc-cleanup` has been split into `/dbtrunk` and `/vc`
- **New Configuration**: `core.*` and `voicetracking.cleanup.*` settings are available
- **Default Values**: Most features now default to disabled for security

### Required Actions
1. **Update Commands**: Run `/config reload` after updating to register new commands
2. **Configure Features**: Enable desired features using `/config set`
3. **Set Up Logging**: Configure Discord logging channels if desired

---

## Breaking Changes

- **`/vc-cleanup` command removed** - Replaced by `/dbtrunk` and `/vc`
- **Default feature states** - Most features now default to disabled
- **Command registration** - Commands now load dynamically based on configuration

---

**🎉 KoolBot v0.5.0 represents a major step forward in functionality, reliability, and user experience!**
