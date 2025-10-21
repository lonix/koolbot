# KoolBot: AI Coding Agent Instructions

Concise, codebase-specific guidance for automating changes. Focus on existing patterns only.

## Architecture (Mental Model)
Entry point: `src/index.ts` wires services, validates env, registers commands, starts voice subsystems. Services under `src/services/` each own a domain (config, commands, voice mgmt, tracking, announcements, truncation, logging, monitoring).

Data flow:
1. Discord events -> `Client` handlers in `src/index.ts` -> delegate to specialized services.
2. Config reads always go through `ConfigService` (`getBoolean/getString/getNumber`) which caches values and merges env + Mongo (`models/config.ts`).
3. Commands are conditionally registered based on config flags in `CommandManager.loadCommandsDynamically()`; feature enablement toggles via keys like `voicechannels.enabled`, `quotes.enabled`, etc.
4. Voice presence events -> `VoiceChannelManager` (lifecycle/ownership & cleanup) + `VoiceChannelTracker` (session/stat persistence) -> Mongo models (`voice-channel-tracking.ts`).
5. Periodic tasks (cleanup, health checks, truncation) are timer-driven within their service (e.g., intervals in `voice-channel-manager.ts`).

## Command Pattern
Each file in `src/commands/` exports `data: SlashCommandBuilder` + `execute(interaction)`. Example: `src/commands/ping.ts`. Registration is automatic; DO NOT manually push to client collections outside `CommandManager`. To add a command:
1. Create `src/commands/mycmd.ts` exporting `data` + `execute`.
2. Reference config key pattern `mycmd.enabled` (add to schema if needed) and list it in `commandConfigs` inside `CommandManager` with `configKey`.
3. Document in `COMMANDS.md` if user-facing.

## Configuration Conventions
Keys use dot notation grouped by feature: `voicechannels.*`, `voicetracking.*`, `core.*`, `quotes.*`. Always access via `ConfigService.getBoolean|getString|getNumber` (never directly from env except during boot). Add new keys to `config-schema.ts`; provide backward compatibility if renaming (see fallbacks in `voice-channel-manager.ts` where old keys like `voice_channel.*` are still read).

Reload: `/config reload` triggers `ConfigService.triggerReload()` which clears cache and invokes registered callbacks (services may register). Avoid adding implicit reload hooks in `CommandManager` (explicitly removed; manual reload only).

## Logging
Use `utils/logger.ts`. Discord channel logging routes through `DiscordLogger` governed by `core.*` keys (e.g., `core.errors.enabled` + channel id). When adding new log categories, follow existing `core.startup.*` pattern.

## Resilience Patterns
Discord API calls wrap retry/timeout logic via `CommandManager.makeDiscordApiCall`. For new bulk REST operations, reuse this helper or copy pattern (timeout race + rate limit/backoff). Voice channel cleanup & health checks run on intervals (5m / 15m); mimic this style for new periodic tasks (store interval handle, log errors but don't crash).

## MongoDB Usage
Models in `src/models/`. Read/write through Mongoose queries; batch reads for config at init (`Config.find({})`). Prefer caching via `ConfigService` rather than ad-hoc queries. For voice tracking, append session objects shaped like `IVoiceChannelTracking.sessions` (see `voice-channel-tracking.ts`). Preserve existing aggregation logic—extend with additive fields rather than mutation of existing ones.

## Adding Features Safely (Example Checklist)
1. Define config keys in `config-schema.ts` (dot notation + defaults).
2. Create service or extend existing one; acquire singleton via `Service.getInstance(client)` pattern.
3. Use `ConfigService.getBoolean` to gate activation (mirror pattern in `voice-channel-manager.initialize`).
4. Register necessary reload callback if runtime changes should apply after `/config reload`.
5. Log lifecycle events through `DiscordLogger` if user-visible.

## Docker & Scripts
Local dev: `npm run dev`; build: `npm run build`; quality: `npm run check`. Container orchestration via `docker-compose.yml` (prod) / `.dev.yml` (bind mounts + live reload). Validation & migration: `npm run validate-config`, `npm run migrate-config`. Cleaning global commands handled automatically on startup via `cleanupGlobalCommands()`—avoid duplicating.

## Common Pitfalls
1. Direct env access mid-runtime (use ConfigService cache instead).
2. Forgetting backward compatibility for renamed config keys (see fallbacks in voice services).
3. Registering commands without adding enablement key (command stays always-on or never loads).
4. Long-running API calls without retry/timeout (copy `makeDiscordApiCall`).

## Reference Files
Entry: `src/index.ts` | Commands orchestrator: `services/command-manager.ts` | Config: `services/config-service.ts`, `services/config-schema.ts` | Voice lifecycle: `services/voice-channel-manager.ts` | Tracking: `services/voice-channel-tracker.ts` | Logging: `services/discord-logger.ts` | Models: `models/config.ts`, `models/voice-channel-tracking.ts`.

## Quick Example: New Toggleable Command
```ts
// src/commands/echo.ts
export const data = new SlashCommandBuilder().setName('echo').setDescription('Echo text').addStringOption(o=>o.setName('text').setDescription('Text').setRequired(true));
export async function execute(interaction: ChatInputCommandInteraction){ await interaction.reply(interaction.options.getString('text', true)); }
```
Add to `commandConfigs`: `{ name: "echo", configKey: "echo.enabled", file: "echo" }` then create schema entry `echo.enabled` default `true`.

---
If any section is unclear or missing (e.g., voice tracking internals, migration patterns), ask for refinement and specify which area to deepen.
