# KoolBot: AI Coding Agent Instructions

## Project Overview
KoolBot is a modular, service-oriented Discord bot written in TypeScript. It features advanced voice channel management, user activity tracking, utility commands, and automated data cleanup. The bot is designed for seamless deployment with Docker Compose and uses MongoDB for persistent storage.

## Key Architectural Patterns
- **Service-Oriented Structure**: Core logic is organized into services under `src/services/` (e.g., `voice-channel-manager.ts`, `config-service.ts`). Each service encapsulates a major feature or responsibility.
- **Command System**: All Discord commands are implemented as individual files in `src/commands/`. Each file exports a command definition and handler. Commands are auto-registered at startup.
- **Configuration Management**: Runtime settings are managed via the `/config` command and stored in MongoDB. The schema and logic are in `src/services/config-service.ts` and `src/services/config-schema.ts`.
- **Voice Channel Tracking**: User activity and statistics are tracked and aggregated in MongoDB. See `src/models/voice-channel-tracking.ts` and related services.
- **Logging**: Bot lifecycle, errors, and scheduled tasks are logged to Discord channels, configurable via the `core.*` config keys.

## Developer Workflows
- **Build**: `npm run build` (TypeScript compilation)
- **Dev Server**: `npm run dev` (nodemon, hot reload)
- **Quality Check**: `npm run check` (build, lint, format)
- **Lint/Format**: `npm run lint`, `npm run format`
- **Docker**: Use `docker-compose.yml` for production, `docker-compose.dev.yml` for development. MongoDB is included.
- **Config Validation**: `npm run validate-config` (or via Docker: `docker-compose exec bot npm run validate-config`)
- **Settings Migration**: `npm run migrate-config`

## Project-Specific Conventions
- **Commands**: One file per command in `src/commands/`. Use clear, descriptive names. Register new commands in `src/commands/index.ts`.
- **Config Keys**: Use dot-notation (e.g., `core.startup.enabled`). All config changes should be validated and, if needed, migrated.
- **Logging**: Use the logger in `src/utils/logger.ts`. For Discord channel logging, follow the `core.*` config structure.
- **Database**: All persistent data is in MongoDB. Use models in `src/models/` and access via services in `src/services/`.
- **Testing/Validation**: Use scripts in `src/scripts/` for config and data validation.

## Integration Points
- **Discord.js**: Main bot client in `src/index.ts`.
- **MongoDB**: Connection and schema in `src/utils/database.ts` and `src/models/`.
- **Docker**: All deployment is containerized. See `docker-compose.yml` and `Dockerfile`.

## References
- **Commands**: `COMMANDS.md`
- **Settings**: `SETTINGS.md`
- **Troubleshooting**: `TROUBLESHOOTING.md`
- **Release Notes**: `RELEASE_NOTES.md`

## Examples
- Add a new command: create `src/commands/mycommand.ts`, export handler, and add to `src/commands/index.ts`.
- Add a config key: update schema in `src/services/config-schema.ts`, add logic in `config-service.ts`, document in `SETTINGS.md`.
- Log to Discord: update `core.*` config keys and use logger utilities.

---

If any conventions or workflows are unclear, consult the referenced markdown files or ask for clarification.
