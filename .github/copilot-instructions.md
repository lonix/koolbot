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
2. **CRITICAL:** Add `{ name, configKey, file }` entry to `commandConfigs` in **BOTH** methods in `CommandManager`:
   - `loadCommandsDynamically()` - registers command with Discord API
   - `populateClientCommands()` - loads execute handler into client
   - **Both arrays must stay in sync** or commands will appear but not respond
3. Add schema key `mycmd.enabled` (default) in `config-schema.ts`.
4. Document in `COMMANDS.md` if user-facing.

**Common Pitfall:** Adding command only to `loadCommandsDynamically()` without adding to
`populateClientCommands()` causes "The application did not respond" error because Discord knows
about the command but the bot has no handler.

## Setup Wizard

The `/setup wizard` command provides interactive onboarding for configuring features. When adding new features:

**User-Facing Features:** Consider adding wizard support for user-facing features that require configuration.

- Add feature configuration to `src/commands/setup-wizard.ts` in the `FEATURES` constant
- Implement feature-specific configuration function (e.g., `configureMyFeature`)
- Add interaction handlers in `src/handlers/wizard-*-handler.ts` if needed
- Update auto-detection logic in `src/utils/channel-detector.ts` for resource discovery

**Wizard Architecture:**

- Ephemeral interactions in server (not DMs)
- Session-based state management via `WizardService` (15-min timeout)
- Button/select menu/modal interactions for multi-step configuration
- Auto-detects existing channels/categories to avoid duplicates
- Bulk configuration with single `ConfigService.triggerReload()` on completion

**When to Use Wizard vs Manual Config:**

- Wizard: Multi-setting features requiring guided setup (voice channels, tracking, quotes)
- Manual `/config set`: Single-setting features or advanced configuration

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

## Reusable Patterns

### Bot-Controlled Channel Header Posts

When implementing bot-controlled channels (quotes, stats, achievements), add informational headers:

**Pattern Location**: See `QuoteChannelManager.ensureHeaderPost()` and `DEVELOPER_GUIDE.md`

**Quick Implementation**:
1. Add config keys: `feature.header_enabled`, `feature.header_pin_enabled`, `feature.header_message_id`
2. Copy `ensureHeaderPost()` and `createHeaderPost()` methods from `quote-channel-manager.ts`
3. Customize embed content for your channel's purpose
4. Call `ensureHeaderPost()` in `initialize()` and cleanup jobs
5. Test header creation, validation, and auto-recreation

See **DEVELOPER_GUIDE.md** "Bot-Controlled Channel Header Posts" for complete implementation guide with examples.

## Docker & Scripts

Dev: `npm run dev` | Build: `npm run build` | Quality: `npm run check`.
Docker compose files: prod `docker-compose.yml`, dev `docker-compose.dev.yml` (bind mounts + hot reload).
Validation & migration: `npm run validate-config`, `npm run migrate-config`.
Global command cleanup auto via `cleanupGlobalCommands()`; do not duplicate.

## Code Quality Standards

**MANDATORY:** All code changes must pass quality gates before completion. Never mark a task as complete until all checks pass.

### TypeScript & JavaScript

- **Linting:** Always run `npm run lint` and fix all issues
- **Formatting:** Always run `npm run format:check` or `npm run format` to auto-fix
- **Type Safety:** Use explicit types, avoid `any` where possible
- **Build:** Ensure `npm run build` succeeds without errors
- **Full Check:** Use `npm run check` (build + lint + format check) before final submission

### Markdown Documentation

- **Linting:** All markdown files must pass markdownlint
- **Line Length:** Max 160 characters (code blocks and tables excluded)
- **HTML:** HTML tags are allowed (MD033: false)
- **Run Check:** `npx markdownlint "**/*.md" --ignore node_modules --ignore dist`
- **Fix Issues:** Address all markdown linting errors before completion

### Testing Requirements

**MANDATORY:** Write tests for all new code unless explicitly told otherwise.

1. **Test Location:** Place tests in `__tests__/` matching the source structure
   - Commands: `__tests__/commands/`
   - Services: `__tests__/services/`
   - Utils: `__tests__/utils/`

2. **Test Pattern:** Follow AAA pattern (Arrange, Act, Assert)

3. **Test Commands:**
   - Run all: `npm test`
   - Run with watch: `npm run test:watch`
   - Run with coverage: `npm run test:coverage`
   - CI mode: `npm run test:ci`

4. **Coverage:** Maintain minimum 2% coverage (baseline), aim for 70-80% for critical modules

5. **Test Structure:**

   ```typescript
   import { describe, it, expect } from '@jest/globals';
   
   describe('MyFunction', () => {
     it('should handle expected case', () => {
       // Arrange
       const input = 'test';
       
       // Act
       const result = myFunction(input);
       
       // Assert
       expect(result).toBe('expected');
     });
   });
   ```

6. **Mock External Dependencies:** Always mock Discord.js, MongoDB, file system, and network calls

### Docker Integration

**MANDATORY:** Update Dockerfiles when dependencies or build processes change.

- **Production:** `Dockerfile` - Multi-stage build for optimized production image
- **Development:** `Dockerfile.dev` - Development with hot reloading
- **Test Changes:**
  - Build: `docker-compose build`
  - Run: `docker-compose up -d`
  - Logs: `docker-compose logs -f bot`
- **When to Update:**
  - New npm packages added/removed
  - Build process changes
  - Environment variable requirements change
  - New system dependencies needed

### Documentation Requirements

**MANDATORY:** Update documentation when making user-facing or architectural changes.

- **Commands:** Update `COMMANDS.md` for new/modified commands
- **Settings:** Update `SETTINGS.md` for new/modified config keys
- **README:** Update if setup steps, features, or quick start changes
- **Code Comments:** Add comments only when necessary to explain complex logic

### Pre-Completion Checklist

Before marking any task complete, verify:

- [ ] Code builds successfully (`npm run build`)
- [ ] All linters pass (`npm run lint`)
- [ ] Code is formatted (`npm run format:check`)
- [ ] Markdown is valid (`npx markdownlint "**/*.md" --ignore node_modules --ignore dist`)
- [ ] Tests written and passing (`npm test`)
- [ ] Dockerfiles updated if dependencies changed
- [ ] Documentation updated if user-facing changes
- [ ] Full quality check passes (`npm run check` or `npm run check:all`)

### Quality Commands Summary

```bash
# Quick quality check (build + lint + format)
npm run check

# Full quality check (includes tests)
npm run check:all

# Individual checks
npm run build          # TypeScript compilation
npm run lint           # ESLint
npm run format:check   # Prettier
npm test              # Jest tests
npx markdownlint "**/*.md" --ignore node_modules --ignore dist  # Markdown
```

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

## CI/CD & GitHub Workflows

The repository uses GitHub Actions for automated quality checks. All PRs must pass:

- **Test Workflow** (`.github/workflows/test.yml`):
  - TypeScript compilation
  - ESLint checks
  - Prettier formatting verification
  - Jest test suite with coverage
  - Runs on: push to main, PRs, manual trigger
  - Includes concurrency control to cancel duplicate runs

- **Markdown Lint Workflow** (`.github/workflows/markdown-lint.yml`):
  - Validates all markdown files
  - Runs on: markdown file changes, manual trigger
  - Includes concurrency control

- **Docker Workflow** (`.github/workflows/docker.yml`):
  - Builds and validates Docker images
  - Pushes to GitHub Container Registry
  - Uses Docker layer caching for faster builds
  - Concurrency control prevents duplicate builds (except on tags)

- **Release Drafter Workflow** (`.github/workflows/release-drafter.yml`):
  - Automatically drafts release notes from merged PRs
  - Auto-labels PRs based on changed files
  - Groups changes by category in release notes
  - Runs on: push to main, PR label changes

**Local Pre-Push Validation:**

```bash
# Run the same checks as CI
npm run check:all  # Build + Lint + Format + Tests
npx markdownlint "**/*.md" --ignore node_modules --ignore dist
```

### PR Labeling Guidelines

The Release Drafter automatically labels PRs based on file patterns, but you can also manually apply labels:

- **Version Labels** (affect semantic versioning):
  - `major` or `breaking` - Breaking changes (v1.0.0 → v2.0.0)
  - `minor`, `feature`, `enhancement` - New features (v1.0.0 → v1.1.0)
  - `patch`, `bug`, `fix` - Bug fixes (v1.0.0 → v1.0.1)

- **Category Labels** (organize release notes):
  - `feature`, `enhancement` - New features
  - `bug`, `fix` - Bug fixes
  - `documentation` - Documentation changes
  - `dependencies` - Dependency updates
  - `test` - Test changes
  - `docker` - Docker-related changes
  - `github-actions` - CI/CD workflow changes
  - `chore`, `refactor` - Maintenance work

**Auto-labeling rules** (from `.github/release-drafter.yml`):

- Markdown files → `documentation`
- package.json changes → `dependencies`
- .github/workflows → `github-actions`
- `__tests__` directory → `test`
- Dockerfile → `docker`

## Task Completion Workflow

1. **Understand:** Read the issue/task completely
2. **Plan:** Create a minimal change plan
3. **Implement:** Make focused, surgical changes
4. **Test:** Write and run tests for new code
5. **Validate:** Run all quality checks
6. **Document:** Update relevant docs
7. **Verify:** Check Dockerfiles if dependencies changed
8. **Review:** Ensure markdown is valid
9. **Complete:** Only after all checks pass

## Never Skip These Steps

- ❌ Do not mark tasks complete without running quality checks
- ❌ Do not skip writing tests for new functionality
- ❌ Do not ignore linting or formatting errors
- ❌ Do not forget to update documentation for user-facing changes
- ❌ Do not bypass markdown linting for documentation changes
- ❌ Do not forget Dockerfile updates when dependencies change

---
If any section is unclear or missing (e.g., voice tracking internals, migration patterns), ask for refinement and specify which area to deepen.
