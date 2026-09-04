# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

KoolBot is a modular Discord bot (TypeScript, ESM, Node >= 22) with voice-channel management, activity
tracking, quotes, stats, polls, achievements, and an optional Express-based web UI. Persistence is MongoDB
via Mongoose. Discord interactions use discord.js v14.

## Commands

```bash
npm run dev          # Run from source via ts-node ESM loader (src/loader.js) — no build step
npm run build        # tsc -> dist/ (also the typecheck gate; tsconfig is strict)
npm start            # Run the compiled bot (node dist/index.js)
npm run watch        # tsc --watch

npm test             # Jest (uses --experimental-vm-modules for ESM)
npm run test:watch
npm run test:coverage
npm run test:ci      # CI mode: --ci --coverage --maxWorkers=2 (enforces coverage thresholds)

npm run lint         # ESLint
npm run lint:fix
npm run format       # Prettier write (src/**/*.ts)
npm run format:check # Prettier check — CI gate

npm run check        # build + lint + format:check
npm run check:all    # build + lint + format:check + test  (run before pushing)
```

Run a single test file or test by name:

```bash
node --experimental-vm-modules node_modules/jest/bin/jest.js __tests__/services/poll-service.test.ts
node --experimental-vm-modules node_modules/jest/bin/jest.js -t "creates a header post"
```

Markdown is linted in CI (max line length 160, code blocks/tables excluded):

```bash
npx markdownlint "**/*.md" --ignore node_modules --ignore dist
```

Operational scripts (run against compiled output in `dist/`, so `npm run build` first): `validate-config`,
`migrate-config`, `cleanup-global-commands`, `unregister-guild-commands`, `seed-sample-data` (dev/test only —
populates a non-prod DB with deterministic fake activity; guarded by `--yes`, namespaced behind a `seed-` id
prefix so `--clean` removes only seeded rows; see `DEVELOPER_GUIDE.md`).

## Architecture

**Entry point — `src/index.ts`** validates env, connects Mongo, wires up every service, registers the
Discord client event handlers, and starts the voice/web/metrics subsystems. It is the one place that
constructs services and routes raw Discord events to them.

**Services (`src/services/`, ~30 of them)** each own one domain (config, command lifecycle, voice
management/tracking/announcing/truncation, quotes, notices, polls, achievements, reaction roles,
leaderboard roles, digests, monitoring, logging, migration). Services are singletons constructed with a
`getInstance(client)` pattern and own their own timers/intervals for periodic work (e.g. cleanup ~5m,
health ~15m). Periodic jobs store their interval handle, log errors, and must never crash the process.

**Cron-driven services extend `ScheduledService` (`services/scheduled-service.ts`, #851)** — birthdays,
digest, rewind nudge, events, reminders and leaderboard roles all do. The base class owns the whole
`start` / `runNow` / `reload` / `destroy` lifecycle: the enablement gate, cron sanitising/validation,
arming and stopping the `CronJob`, coalescing concurrent runs, swallowing tick failures, and the
`/config reload` callback. A subclass supplies only `isEnabled()`, `resolveSchedule()` and `runOnce()`
(plus its own `getInstance`/`reset`). Do not hand-roll the skeleton again, and do not re-add an
`isRunning` guard inside a `runOnce` — the base class already guarantees runs never overlap.

**Configuration is the backbone.** All runtime config flows through `ConfigService`, which merges
environment variables with values stored in Mongo (`models/config.ts`) and caches them. Read config via
`ConfigService.getBoolean | getString | getNumber` — never read `process.env` directly mid-runtime. Keys
use dot notation grouped by feature (`voicechannels.*`, `voicetracking.*`, `quotes.*`, `core.*`). Every
key must be declared with a default in `services/config-schema.ts`; when renaming a key, keep a
backward-compat fallback (see `voice-channel-manager.ts`). A key whose `category` is new must also be
added to `CONFIG_CATEGORIES` in `models/config.ts`, or the startup cleanup sweep deletes its rows as
"unknown" on every restart (#609, #834). `/config reload` calls
`ConfigService.triggerReload()` (clears cache + fires registered reload callbacks) — do not reintroduce
implicit reload logic into `CommandManager`.

**Feature gating:** most features (and their commands) only activate when their `*.enabled` config key is
true. Copy the gating pattern from the voice manager's `initialize()` when adding a feature.

**Data flow:** Discord event → handler in `src/index.ts` → specialized service → Mongo model. Voice
presence specifically fans out to `VoiceChannelManager` (channel lifecycle & cleanup) and
`VoiceChannelTracker` (session/stat persistence, append-only session objects in
`models/voice-channel-tracking.ts`).

**Resilience:** wrap Discord REST calls in `CommandManager.makeDiscordApiCall` (timeout race + backoff);
reuse it for any new bulk REST work.

**Shared service helpers (#851):** cron parsing (`utils/cron.ts` —
`sanitizeCronExpression` / `validateCronExpression`), the gateway-readiness wait
(`utils/discord.ts` — `waitForClientReady`), Mongo reconnects (`utils/mongo.ts` —
`MongoConnectionGuard`, which owns the connection flag and defaults to
`DEFAULT_MONGODB_URI` from `config/env.ts`) and HTML escaping (`web/html.ts` — `escapeHtml` /
`escapeJsInAttr`) each live in exactly one module. Import them; do not re-add a per-service copy.
Tests stub the Mongo guard with `stubMongoGuard(service)` from `__tests__/test-utils.ts`.

**Web UI (`src/web/`)** is an optional Express app (admin + user routers, sessions, CSRF, rate limiting,
Prometheus metrics at `src/web/metrics.ts`). It is gated by env/config — see `validateWebUIEnvVars` /
`isWebUIEnabled`. Substantial feature docs live in `WEBUI.md`.

**Static content (`src/content/`)** holds achievement/accolade/status/notice definitions; `examples/`
holds example poll libraries.

### Admin surface: Web UI only (design decision — read before proposing a new command)

**From v1.0 onward the Web UI is the _only_ admin surface.** Slash commands are reserved for day-to-day
moderation and member self-service (e.g. `/warn`, `/modlog`, `/quote`, `/seen`, `/voicestats`,
`/achievements`, plus `/config`, which just DMs a one-time Web UI sign-in link). Everything that
_configures or manages_ a feature lives in `src/web/` — the admin management commands that used to exist
(`/permissions`, `/setup`, `/announce`, `/poll`, `/reactrole`, `/notice`, `/dbtrunk`, `/vc`, `/botstats`)
were **deliberately retired** in the Web UI migration, not lost. See `WEBUI.md` and the "Replaces (legacy
slash command)" table in `COMMANDS.md`.

Do **not** re-add an admin management command as a slash command "for parity" — that reverses the
decision. If a config-schema description, doc, or UI string still advertises a retired command, the fix is
to correct the stale text, not to ship the command. (This is why issue #812, "add `/reactrole`", was closed
as not-planned: reaction-role management is configuration and belongs to the Reaction Roles Web UI page.)
New slash commands are appropriate only when the interaction is genuinely day-to-day
moderation/self-service that a member or moderator runs in Discord — not admin setup.

### The command pattern (read before adding a command)

Each file in `src/commands/` exports `data: SlashCommandBuilder` and `execute(interaction)`. Registration
is automatic through `CommandManager` — never push to client command collections manually. To add a
command:

1. Create `src/commands/mycmd.ts` exporting `data` + `execute`.
2. **Add a `{ name, configKey, file }` entry to `COMMAND_CONFIGS` in `src/services/command-registry.ts`.**
   That list is the single source of truth: `CommandManager` reads it in both `loadCommandsDynamically()`
   (registers with the Discord API) and `populateClientCommands()` (loads the execute handler), and `/help`
   derives its command list, descriptions and usage lines from it plus each command's `SlashCommandBuilder`.
   Do not add a per-method copy of the list, and do not hand-maintain command metadata in `help.ts`.
3. Add the enablement key `mycmd.enabled` (with default) to `config-schema.ts`.
4. Document user-facing commands in `COMMANDS.md`.
5. Call `await interaction.deferReply()` (with `{ flags: MessageFlags.Ephemeral }` when the final reply is ephemeral)
   **before** the first DB query or other slow await, then finish with `editReply`. Discord invalidates
   an interaction that is not acknowledged within 3 seconds, and the resulting `10062 Unknown
   interaction` cannot be recovered (#842). Cheap synchronous guards may still `reply` directly.

Multi-setting features should also be wired into the `/setup wizard` (`src/commands/setup-wizard.ts`
`FEATURES` constant + handlers in `src/handlers/wizard-*`); single settings stay on `/config set`.

### Logging

Use `src/utils/logger.ts` (Winston). Discord-channel logging flows through `DiscordLogger`, governed by
`core.*` config keys (e.g. `core.errors.enabled` + a channel id). Mirror the `core.startup.*` naming when
adding a category. Sanitize untrusted values with `utils/log-sanitize.ts`.

## CI / release chain

CI runs on PRs to `main` and pushes to `main`. The relevant workflows in `.github/workflows/`:

- **`ci.yml`** — the core gate. Parallel jobs: `lint` (ESLint + Prettier), `typecheck` (`npm run build`),
  and `test` (matrix Node 22 & 24, `npm run test:ci`). The `ci-success` aggregator job is the single
  required status check — it fails if any job failed or was cancelled.
- **`markdown-lint.yml`** — markdownlint on `**/*.md` changes.
- **`actionlint.yml`** / **`zizmor`** — lint + security-audit workflow YAML when `.github/workflows/**`
  changes.
- **`codeql.yml`** — CodeQL scan (PRs, pushes, weekly cron).
- **`dependency-review.yml`** — flags risky dependency changes on PRs.
- **`docker.yml`** — on push to `main` and `v*.*.*` tags: hadolint, then build/scan (Trivy)/sign
  (cosign)/push the image to GHCR.
- **`pr-title-lint.yml`** — see below.
- **`auto-label.yml`** — labels issues and PRs (path map in `.github/labeler.yml`, plus type and
  release-impact labels derived from the Conventional Commit PR title). Runs on
  `pull_request_target` so fork PRs get a write token, and therefore must never check out or run PR
  code — see the `dangerous-triggers` exemption in `.github/zizmor.yml`.
- **`release-please.yml`** — release automation on push to `main`.

Coverage thresholds are enforced by `coverageThreshold.global` in `jest.config.js`, which is the
single source of truth for the numbers — read them there (`TESTING.md` carries the same table for
contributors) rather than restating them here, so this file cannot drift out of date (#920). The
floors sit a few points under measured coverage, so a real regression fails the `test` job. Do not
ratchet them by hand on a schedule — that is how they drifted ~33 points out of date (#848).
`npm run coverage:drift` (`scripts/check-coverage-drift.mjs`, run in CI on the Node 22 matrix leg)
fails once actual coverage climbs more than 10 points above any floor, and writes the actual-vs-floor
table to the run summary on every PR; raising the numbers in `jest.config.js` is then the fix.

### Conventional Commits are mandatory

This repo **squash-merges** PRs, using the **PR title** as the commit subject. release-please only counts
commits whose subject parses as a Conventional Commit; a non-conforming title is silently dropped from the
changelog and version bump. `pr-title-lint.yml` therefore rejects non-conforming PR titles.

Allowed types (kept in sync with `release-please-config.json` changelog sections):
`feat, fix, perf, revert, refactor, docs, deps, test, build, ci, chore`. Format:
`<type>(<optional scope>): <subject>`, with `!` or a `BREAKING CHANGE` footer for breaking changes.
`feat` → minor bump, `fix`/`perf` → patch, `!`/breaking → major. release-please opens/maintains a
"chore(main): release x.y.z" PR; merging it tags the release and updates `CHANGELOG.md` and
`.release-please-manifest.json`.

### Pull request workflow

- **Always rebase onto the latest `main` before creating a PR** — run `git fetch origin main && git rebase origin/main`,
  resolve any conflicts, so the PR is up to date and merges cleanly.
- **Always resolve review comments once they are handled** — after addressing a reviewer's comment, mark
  the conversation as resolved so the thread reflects what is still outstanding.

## Conventions & pitfalls

- ESM throughout: relative imports must use `.js` extensions even from `.ts` sources (NodeNext resolution).
- `dist/`, `node_modules/`, `__tests__/`, and `coverage/` are excluded from the `tsc` build; tests are run
  by Jest/ts-jest, not compiled by the build.
- Tests live in `__tests__/` mirroring `src/` structure (`commands/`, `services/`, `utils/`, `web/`,
  `models/`, `handlers/`). Mock Discord.js, MongoDB, and network/fs in tests; shared helpers are in
  `__tests__/test-utils.ts` and `__tests__/setup.ts`. ESLint relaxes return-type/`no-explicit-any` rules
  in test files but keeps `no-unused-vars` an error.
- ESLint flags `@typescript-eslint/no-explicit-any` and missing return types as **warnings** but
  `no-unused-vars`, `no-duplicate-imports`, and `prefer-const` as **errors**.
- Update `SETTINGS.md` when adding/changing config keys and `COMMANDS.md` for user-facing commands.
  `__tests__/config/settings-doc-drift.test.ts` enforces the first half in both directions: every
  key in `defaultConfig` must appear in `SETTINGS.md`, and every key `SETTINGS.md` names must exist
  in the schema (#846).
- Update `Dockerfile` / `Dockerfile.dev` when dependencies or the build process change.

## Key reference files

`src/index.ts` (wiring) · `services/command-manager.ts` · `services/config-service.ts` +
`services/config-schema.ts` · `services/voice-channel-manager.ts` + `services/voice-channel-tracker.ts` ·
`services/discord-logger.ts` · `models/config.ts` · `web/index.ts` + `web/metrics.ts`. Deeper guides:
`DEVELOPER_GUIDE.md`, `WEBUI.md`, `COMMANDS.md`, `SETTINGS.md`, `CONTRIBUTING.md`, `TESTING.md`,
`TROUBLESHOOTING.md`.
