# KoolBot: AI Coding Agent Instructions

Concise, codebase-specific guidance for automating changes. Focus on existing patterns only.

## Architecture (Mental Model)

Entry point: `src/index.ts` wires services, validates env, registers commands, starts voice subsystems.
Services under `src/services/` each own a domain (config, commands, voice mgmt, tracking, announcements,
truncation, logging, monitoring).

Data flow:

1. Discord events -> `Client` handlers in `src/index.ts` -> delegate to specialized services.
2. Config reads always go through `ConfigService` which caches values and merges env + Mongo (`models/config.ts`).
3. Commands conditionally register via flags in `CommandManager.loadCommandsDynamically()` (`voicechannels.enabled`,
   `quotes.enabled`, etc.).
4. Voice presence events -> `VoiceChannelManager` (lifecycle & cleanup) + `VoiceChannelTracker` (session/stat persistence)
  -> Mongo (`voice-channel-tracking.ts`).
5. Periodic tasks (cleanup, health checks, truncation) run on timers owned by their service.

## Command Pattern

Each file in `src/commands/` exports `data: SlashCommandBuilder` + `execute(interaction)`.
Example: `src/commands/ping.ts`.
Registration is automatic; DO NOT manually push to client collections outside `CommandManager`.
To add a command:

1. Create `src/commands/mycmd.ts` exporting `data` + `execute`.
2. Add `{ name, configKey, file }` entry to `commandConfigs` in `CommandManager`.
3. Add schema key `mycmd.enabled` (default) in `config-schema.ts`.
4. Document in `COMMANDS.md` if user-facing.

## Configuration Conventions

Keys use dot notation grouped by feature: `voicechannels.*`, `voicetracking.*`, `core.*`, `quotes.*`.
Always access via `ConfigService.getBoolean|getString|getNumber` (never direct env mid-runtime).
Add new keys to `config-schema.ts`; if renaming, keep backward compat fallbacks (see `voice-channel-manager.ts`).

Reload: `/config reload` calls `ConfigService.triggerReload()` (cache clear + callbacks).
Do not reintroduce implicit reload logic in `CommandManager` (intentionally removed).

## Logging

Use `utils/logger.ts`. Discord channel logging flows via `DiscordLogger` governed by `core.*` keys
(`core.errors.enabled` + channel id, etc.). To add a category, mirror `core.startup.*` naming style.

## Resilience Patterns

Discord API calls wrap retry + timeout via `CommandManager.makeDiscordApiCall` (race + backoff).
Reuse it or copy pattern for new bulk REST operations.
Periodic jobs (cleanup 5m / health 15m) follow: store interval handle, log errors, never crash.

## MongoDB Usage

Models live in `src/models/`. Batch load config (`Config.find({})`) at init; rely on `ConfigService` cache.
Voice tracking: append session objects (`voice-channel-tracking.ts` shape). Keep aggregation additive.

## Adding Features Safely (Checklist)

1. Define config keys in `config-schema.ts` (dot notation + defaults).
2. New service: singleton `getInstance(client)` pattern.
3. Gate activation via `ConfigService.getBoolean` (copy voice manager initialize pattern).
4. Register reload callback if runtime adjust needed post `/config reload`.
5. Log lifecycle via `DiscordLogger` if user-visible.

## Docker & Scripts

Dev: `npm run dev` | Build: `npm run build` | Quality: `npm run check`.
Docker compose files: prod `docker-compose.yml`, dev `docker-compose.dev.yml` (bind mounts + hot reload).
Validation & migration: `npm run validate-config`, `npm run migrate-config`.
Global command cleanup auto via `cleanupGlobalCommands()`; do not duplicate.


## Code quality
After offering/implemnenting a code change, ensure it adheres to existing code quality standards: by running npn run check and npm run lint and fixing any issues reported before submitting the change.


## Common Pitfalls

1. Direct env access mid-runtime (always use `ConfigService`).
2. Missing backward compat for renamed config keys.
3. Command added without enablement key in schema + `commandConfigs`.
4. New REST call without timeout/retry pattern.

## Reference Files

Entry: `src/index.ts` | Commands: `services/command-manager.ts` | Config: `services/config-service.ts`,
`services/config-schema.ts` | Voice lifecycle: `services/voice-channel-manager.ts` | Tracking:
`services/voice-channel-tracker.ts` | Logging: `services/discord-logger.ts` | Models:
`models/config.ts`, `models/voice-channel-tracking.ts`.

## Quick Example: New Toggleable Command

```ts
// src/commands/echo.ts
export const data = new SlashCommandBuilder()
  .setName('echo')
  .setDescription('Echo text')
  .addStringOption(o => o
    .setName('text')
    .setDescription('Text')
    .setRequired(true));

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.reply(interaction.options.getString('text', true));
}
```

Add to `commandConfigs`: `{ name: 'echo', configKey: 'echo.enabled', file: 'echo' }` then add schema key
`echo.enabled` default `true`.

---
If any section is unclear or missing (e.g., voice tracking internals, migration patterns), ask for refinement and specify which area to deepen.
