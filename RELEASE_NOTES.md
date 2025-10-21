# KoolBot Release Notes

## v0.6.0 - Friendship Listener & Cleanup

**Release Date**: October 21, 2025  
**Minor Release** – Feature toggle and deprecated command removal

### Added

- New configuration key `fun.friendship` (default: false) enabling passive friendship listener responses to “best ship” / “worst ship” queries.

### Removed

- Deprecated `plexprice` command removed from the codebase and documentation.

### Changed

- Friendship listener initialization now gated by configuration (was always active).

### Migration Notes

If upgrading from v0.5.0 and you want the new friendship listener:

1. Set `fun.friendship` to `true` via `/config set key:fun.friendship value:true`.
2. (Optional) Run `/config reload` to confirm configuration; listener reads live values.

If you previously used the `plexprice` command, note that it has been fully removed; no action required unless you
maintained forks. Reintroduce via a custom command if needed.

---

## v0.5.0 - Bot Status & Dynamic Voice Channels

**Release Date**: January 2025  
**Major Release** – New features and architectural improvements

### ✨ New Features

#### Bot Status System

- Dynamic status colors by operational state:
  - 🟡 **Yellow (Idle)**: Connecting, reloading configuration, shutting down
  - 🟢 **Green (Online)**: Fully operational
  - ⚫ **Invisible**: Final shutdown state
- Smart activity updates:
  - “Watching nobody” when no users in voice channels
  - “Watching over X nerds” when users are connected
  - Real-time updates triggered by voice state changes
- Graceful shutdown transitions

#### Dynamic Voice Channel Management

- Smart lobby system:
  - Single lobby channel renames based on bot status
  - “🟢 Lobby” when online, “🔴 Lobby” when offline
  - Automatic channel creation for users joining lobby
- User channel creation with permissions
- Intelligent cleanup of unmanaged and empty managed channels

#### Data Maintenance System

- Automated cleanup with configurable retention periods
- Aggregation preserves statistics while pruning old sessions
- Discord notifications report cleanup results

### 🔧 Command Updates

#### New Commands

- **`/dbtrunk`** – Database cleanup management
  - `status` – Show cleanup service status
  - `run` – Execute cleanup immediately
- **`/vc`** – Voice channel management
  - `reload` – Clean up empty channels
  - `force-reload` – Force cleanup of unmanaged channels

#### Enhanced Commands

- **`/config`** – Import/export functionality
  - `import` – Import configuration from YAML
  - `export` – Export configuration to YAML
  - `reload` – Reload commands to Discord API
  - `reset` – Reset settings to defaults

#### Command Architecture

- Split `/vc-cleanup` into `/dbtrunk` and `/vc`
- Dynamic command loading via configuration
- Conditional registration: only enabled features appear

### ⚙️ Configuration Enhancements

#### New Settings

- **`core.*`** logging configuration:
  - `core.startup.*` – Lifecycle events
  - `core.errors.*` – Critical error logging
  - `core.cleanup.*` – Data cleanup notifications
  - `core.config.*` – Configuration change logging
  - `core.cron.*` – Scheduled task logging
- **`voicetracking.cleanup.*`** data maintenance:
  - Retention for sessions (detailed / monthly / yearly)
  - Cron-based cleanup scheduling

#### Import/Export System

- YAML backup/restore
- Discord file attachments for transfers
- Schema validation ensures integrity

### 🐛 Bug Fixes

- Removed duplicate “Watching” prefix
- Accurate database connection status in cleanup commands
- More reliable command registration
- Fixed voice channel cleanup logic edge cases

### 📚 Documentation

- `COMMANDS.md`: Full command reference
- `SETTINGS.md`: Updated settings and examples
- `README.md`: Current features and cross-links
- Standardized cross-references

### 🚀 Technical Improvements

- Better TypeScript coverage
- Improved error handling
- Stricter linting & formatting
- Clearer modular architecture

### Migration Notes (from v0.4.0)

- `/vc-cleanup` replaced by `/dbtrunk` and `/vc`
- New configuration: `core.*`, `voicetracking.cleanup.*`
- Most features default disabled for security

### Required Actions After Upgrade

1. Run `/config reload` to register new commands.
2. Enable desired features with `/config set`.
3. Configure logging channel IDs (optional).

### Breaking Changes

- `/vc-cleanup` command removed
- Default feature states disabled
- Dynamic command registration via configuration

**🎉 KoolBot v0.5.0 delivered major improvements in reliability, visibility, and UX.**
