# KoolBot Developer Guide

Complete guide for developers extending or maintaining KoolBot.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [The `src/web/` Web UI](#the-srcweb-web-ui)
- [The "thin HTTP layer over services" goal](#the-thin-http-layer-over-services-goal)
- [Common Patterns](#common-patterns)
  - [Bot-Controlled Channel Header Posts](#bot-controlled-channel-header-posts)
  - [Service Singleton Pattern](#service-singleton-pattern)
  - [Configuration Management](#configuration-management)
- [Adding New Features](#adding-new-features)
- [Testing Guidelines](#testing-guidelines)
- [Code Style](#code-style)
- [Dependency Notes](#dependency-notes)

---

## Architecture Overview

KoolBot follows a service-oriented architecture where each service owns a specific domain:

```text
src/
├── index.ts              # Entry point, service initialization, Express bootstrap
├── commands/             # Discord slash commands (small surface from v1.0)
│   ├── achievements.ts
│   ├── config.ts         # Web UI launcher (the only admin command)
│   ├── help.ts
│   ├── ping.ts
│   ├── quote.ts
│   ├── seen.ts
│   └── voicestats.ts
├── services/             # Business logic services (single source of truth)
├── web/                  # Web UI router — mounted at /admin when WEBUI_ENABLED=true
│   ├── index.ts          # createWebRouter(client) — composes the router
│   ├── session.ts        # Cookie session middleware + permission revalidation
│   ├── csrf.ts           # CSRF (double-submit cookie)
│   ├── cookies.ts        # Signed cookie helpers
│   ├── rate-limit.ts     # In-memory rate limiter
│   ├── read-only-routes.ts  # Dashboard, Bootstrap, Settings, etc. (GET)
│   ├── write-routes.ts   # POST handlers (settings, permissions, wizard, etc.)
│   ├── admin-layout.ts   # Shared layout + escapeHtml/escapeJsInAttr helpers
│   ├── admin-views.ts    # Page renderers for the admin pages
│   └── views.ts          # Sign-in / sign-out / invalid-link views
├── models/               # MongoDB schemas
├── handlers/             # Event handlers
└── utils/                # Shared utilities
```

### Service Layer

Services follow the **Singleton Pattern** and are initialized in `src/index.ts`:

```typescript
// Service examples
ConfigService
CommandManager
VoiceChannelManager
WebSessionService          // magic-link tokens, used by /config and /admin/s/<token>
PermissionsService         // re-checked on every /admin/* request
```

- **ConfigService**: Configuration management with MongoDB persistence
- **CommandManager**: Discord command registration and routing
- **VoiceChannelManager**: Dynamic voice channel lifecycle
- **QuoteChannelManager**: Quote channel management and permissions
- **DiscordLogger**: Logging to Discord channels
- **WebSessionService**: Magic-link issuance, redemption, revocation
- **PermissionsService**: Per-command role gating (admins always bypass)

---

## The `src/web/` Web UI

The Web UI is the only admin surface from v1.0 onward. It mounts on the
**same Express server** that already exposes `/health` (port 3000 inside
the container). When `WEBUI_ENABLED=true` and the required `WEBUI_*` env
vars are set, `src/index.ts` calls `createWebRouter(client)` and
`app.use("/admin", router)`. When `WEBUI_ENABLED` is false, the router
is never created and `/admin/*` returns 404.

### Auth flow

1. `/config` Discord slash command → `WebSessionService.create(uid, gid)`
   inserts a `WebSession` row (token hashed with HMAC-SHA256 over
   `WEBUI_SESSION_SECRET`) and DMs the URL.
2. Browser hits `GET /admin/s/<token>` → `WebSessionService.redeem()`
   atomically `findOneAndUpdate({usedAt: null, ...}, {usedAt: now})`,
   the route sets a signed session cookie and redirects to `/admin/`.
3. Every subsequent request runs `createSessionMiddleware(client)` which:
   - Verifies the HMAC-signed cookie
   - Enforces the sliding inactivity window
   - Re-fetches the `WebSession` row to enforce server-side revocation
   - Hard-caps the session at `expiresAt`
   - **Re-checks `PermissionsService.checkCommandPermission(uid, gid, "config")`.**
     This returns `false` (and the middleware logs the user out) only
     when explicit role gating is configured for `config` on the Web UI's
     Permissions page and the user's roles no longer match. With no
     explicit gating, the check returns `true` and a demoted admin keeps
     their existing session — the magic-link gate at `/admin/s/<token>`
     is the primary defense, not this revalidation. If you want demotions
     to log existing sessions out, configure Permissions → `config` to
     an admin-only role.
4. `POST /admin/finish` revokes the session in MongoDB, clears the cookie.

The cookie value carries `sid`, `uid`, `gid`, `iat`, `act` — all
validated against the DB row on every request. Holding only the cookie
isn't enough; the DB row has to also be unrevoked, unexpired, and match.

### CSRF

All state-changing routes (POSTs in `write-routes.ts`) use the
double-submit cookie pattern via `csrf.ts`. The `ensureCsrfCookie`
middleware sets a `koolbot_csrf` cookie on every request; `requireCsrf`
checks that the form's hidden `_csrf` field matches.

### Rate limiting

`createRateLimiter({ windowMs, max, keyName })` is keyed by `req.ip`.
The `/admin/s/<token>` redemption endpoint is rate-limited to 10
attempts per minute per IP; `/admin/finish` to 30. To make this work
behind a reverse proxy, operators set `WEBUI_TRUST_PROXY` to the hop
count.

### Views

Pages are server-rendered HTML strings composed in `admin-views.ts` and
wrapped by `renderAdminPage` from `admin-layout.ts`. There is no SPA, no
JS bundle, no CDN. All values are escaped through `escapeHtml` /
`escapeJsInAttr` at the boundary.

The always-visible **session expires in X · [Finish]** banner is part of
the shared layout and reads `WebSessionContext.expiresAt` to render the
remaining time.

---

## The "thin HTTP layer over services" goal

The goal — not yet fully reached in the existing code — is to keep
`src/web/` as a thin HTTP layer over `src/services/`:

> **Push validation, side effects, and data writes into services.
> Routes should mostly read form fields, call a service method, and
> render the result.**

Current state of the code:

- `src/web/write-routes.ts` still owns some input coercion
  (`coerceConfigValue`, `normalizeCron`, `validCron`) and reads/writes
  to Mongoose models directly. Same for `read-only-routes.ts`, which
  imports several models for page data.
- These are *not* prohibited today, but new write paths should prefer
  pushing logic into a service so the slash-command surface and the
  Web UI surface share one validation path. If you're tempted to add a
  `if (input.length > 200)` check inside a write-route handler, add it
  to the service instead.

The reason: when both surfaces share one validation path, a setting
accepted in one place can never be silently rejected in the other.

### Adding a write route

`createWebRouter` mounts the router at `/admin`, so routes declared
inside `write-routes.ts` use **relative** paths — Express composes the
final `/admin/<your-path>` URL for you.

```typescript
// src/web/write-routes.ts (example)
router.post(
  "/myfeature/save",            // becomes /admin/myfeature/save
  requireCsrf,
  requireSession,
  async (req: AuthenticatedRequest, res: Response) => {
    const { name, value } = req.body;
    try {
      await MyFeatureService.getInstance().updateThing(name, value);
      res.redirect(303, "/admin/myfeature");
    } catch (err) {
      // Translate service errors → HTTP. Do not validate here.
      if (err instanceof ValidationError) {
        res.status(400).type("text/html").send(renderError(err.message));
        return;
      }
      throw err;
    }
  },
);
```

Service methods own:

- Input validation (throw a typed error on bad input)
- Authorization decisions beyond the basic "has a valid session"
- Persistence (MongoDB writes)
- Side effects (Discord API calls, cron job changes, log emission)

---

## Common Patterns

### Bot-Controlled Channel Header Posts

**Use Case**: Display informational headers in bot-managed channels (quotes, announcements, stats, achievements).

The header post pattern provides users with context about a channel's purpose and usage. It's implemented in
`QuoteChannelManager` and can be reused for any bot-controlled channel.

#### Pattern Overview

1. **Validate/Create**: Check if header exists, create if missing
2. **Store ID**: Persist message ID to config for validation
3. **Auto-Recreate**: Regenerate header if deleted (via cleanup job)
4. **Configurable**: Allow enable/disable and pin control

#### Implementation Steps

##### Step 1: Add Configuration Keys

Add to `src/services/config-schema.ts`:

```typescript
// In ConfigSchema interface
"feature.header_enabled": boolean;
"feature.header_pin_enabled": boolean;
"feature.header_message_id": string;

// In defaultConfig
"feature.header_enabled": true,
"feature.header_pin_enabled": true,
"feature.header_message_id": "",
```

##### Step 2: Add Header Management Methods

Add to your channel manager service:

```typescript
import { TextChannel, EmbedBuilder } from "discord.js";
import { ConfigService } from "./config-service.js";
import logger from "../utils/logger.js";

/**
 * Ensure the informational header post exists in the channel
 * Validates existing header by stored message ID, creates if missing
 * 
 * @param channel - The Discord text channel to manage
 * @example
 * // Call during initialization
 * await this.ensureHeaderPost(channel);
 */
private async ensureHeaderPost(channel: TextChannel): Promise<void> {
  try {
    // Check if header is enabled
    const headerEnabled = await this.configService.getBoolean(
      "feature.header_enabled",
      true,
    );
    if (!headerEnabled) {
      logger.debug("Feature channel header is disabled");
      return;
    }

    // Get stored header message ID
    const storedHeaderId = await this.configService.getString(
      "feature.header_message_id",
      "",
    );

    // Try to fetch existing header message
    let headerExists = false;
    if (storedHeaderId) {
      try {
        const existingMessage = await channel.messages.fetch(storedHeaderId);
        if (
          existingMessage &&
          existingMessage.author.id === this.client.user?.id
        ) {
          headerExists = true;
          logger.debug("Feature channel header post already exists");
          return;
        }
      } catch {
        logger.debug("Stored header message not found, will recreate");
      }
    }

    // Create header post if it doesn't exist
    if (!headerExists) {
      await this.createHeaderPost(channel);
    }
  } catch (error) {
    logger.error("Error ensuring header post:", error);
  }
}

/**
 * Create the header post with information about the channel
 * Generates an embedded message, pins it (if enabled), and stores the message ID
 * 
 * @param channel - The Discord text channel to post in
 * @example
 * // Called by ensureHeaderPost when header is missing
 * await this.createHeaderPost(channel);
 */
private async createHeaderPost(channel: TextChannel): Promise<void> {
  try {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2) // Discord blurple
      .setTitle("📝 Welcome to the Feature Channel!")
      .setDescription(
        "This channel is managed by KoolBot for [purpose description].",
      )
      .addFields(
        {
          name: "📥 How to Use",
          value: "Instructions for using this channel...",
          inline: false,
        },
        {
          name: "ℹ️ Information",
          value: "Additional context and guidelines...",
          inline: false,
        },
        {
          name: "🔒 Channel Rules",
          value:
            "• Only bot messages are allowed here\n" +
            "• Messages are automatically managed\n" +
            "• Browse content by scrolling up!",
          inline: false,
        },
      )
      .setFooter({ text: "KoolBot Feature System" })
      .setTimestamp();

    const headerMessage = await channel.send({ embeds: [embed] });
    logger.info(`Created feature channel header post: ${headerMessage.id}`);

    // Pin the message if enabled
    const pinEnabled = await this.configService.getBoolean(
      "feature.header_pin_enabled",
      true,
    );
    if (pinEnabled) {
      try {
        await headerMessage.pin();
        logger.info("Pinned feature channel header post");
      } catch (error) {
        logger.warn("Failed to pin header post (missing permissions?):", error);
      }
    }

    // Store the header message ID (persists across bot restarts)
    await this.configService.set(
      "feature.header_message_id",
      headerMessage.id,
      "Message ID of the feature channel header post",
      "feature",
    );
  } catch (error) {
    logger.error("Error creating header post:", error);
  }
}
```

##### Step 3: Integrate into Service Lifecycle

```typescript
// In your service's initialize() method
public async initialize(): Promise<void> {
  try {
    // ... existing initialization code ...
    
    // Get the channel
    const channel = await this.getChannel();
    if (!channel) {
      logger.warn("Feature channel not configured");
      return;
    }

    // Setup permissions (if needed)
    await this.setupChannelPermissions(channel);

    // Ensure header post exists
    await this.ensureHeaderPost(channel);

    // ... rest of initialization ...
  } catch (error) {
    logger.error("Error initializing feature manager:", error);
  }
}
```

##### Step 4: Add Auto-Recreation in Cleanup

If your service has a cleanup job, ensure header is recreated:

```typescript
private async cleanupUnauthorizedMessages(): Promise<void> {
  try {
    const channel = await this.getChannel();
    if (!channel) {
      return;
    }

    // Ensure header post exists (recreate if missing)
    await this.ensureHeaderPost(channel);

    // ... rest of cleanup logic ...
  } catch (error) {
    logger.error("Error during cleanup:", error);
  }
}
```

#### Example Implementations

**Voice Stats Channel**:

```typescript
// In voice-channel-announcer.ts
const embed = new EmbedBuilder()
  .setColor(0x5865f2)
  .setTitle("📊 Voice Channel Statistics")
  .setDescription("Weekly voice activity stats and leaderboards posted here.")
  .addFields(
    {
      name: "📈 What's Posted",
      value: "• Weekly activity summaries\n• Top participants\n• Trending channels",
      inline: false,
    },
    {
      name: "🏆 Leaderboards",
      value: "Rankings updated every Friday at 4 PM UTC",
      inline: false,
    },
  );
```

**Achievement Channel**:

```typescript
// In achievements-service.ts
const embed = new EmbedBuilder()
  .setColor(0xffd700) // Gold
  .setTitle("🏅 Achievement Announcements")
  .setDescription("Server member achievements and milestones.")
  .addFields(
    {
      name: "🎖️ Badges",
      value: "Earn badges for voice activity, contributions, and participation",
      inline: false,
    },
    {
      name: "🔔 Notifications",
      value: "Achievements are announced here and sent via DM",
      inline: false,
    },
  );
```

#### Configuration Examples

Users can manage headers from the Web UI's Settings page:

- `feature.header_enabled` → `false` to disable the header entirely.
- `feature.header_enabled` → `true` and `feature.header_pin_enabled` →
  `false` to keep the header but stop pinning it.

(No command reload required — these are pure config flags read by the
service on its next pass.)

#### Testing

Create tests for header functionality:

```typescript
describe('FeatureChannelManager - Header Post', () => {
  it('should create header when enabled', async () => {
    // Test header creation logic
  });

  it('should skip header when disabled', async () => {
    // Test disabled state
  });

  it('should recreate header if missing', async () => {
    // Test auto-recreation
  });
});
```

#### Documentation Checklist

When implementing header posts for a new channel:

- [ ] Add config keys to `config-schema.ts`
- [ ] Implement `ensureHeaderPost()` and `createHeaderPost()` methods
- [ ] Integrate into service initialization
- [ ] Add to cleanup job (if applicable)
- [ ] Write unit tests
- [ ] Document in `SETTINGS.md`
- [ ] Document in `COMMANDS.md` (if user-facing)
- [ ] Update this guide with your example

---

### Service Singleton Pattern

All services follow the singleton pattern to ensure single instance across the application:

```typescript
export class MyService {
  private static instance: MyService;
  private client: Client;
  private configService: ConfigService;

  private constructor(client: Client) {
    this.client = client;
    this.configService = ConfigService.getInstance();
  }

  public static getInstance(client: Client): MyService {
    if (!MyService.instance) {
      MyService.instance = new MyService(client);
    }
    return MyService.instance;
  }

  public async initialize(): Promise<void> {
    // Initialization logic
  }
}
```

**Usage**:

```typescript
// In src/index.ts
const myService = MyService.getInstance(client);
await myService.initialize();
```

---

### Configuration Management

Configuration uses a two-tier system:

| Tier                | Stored in | Who edits it          | Picked up                                                  |
| ------------------- | --------- | --------------------- | ---------------------------------------------------------- |
| Bootstrap / secrets | `.env`    | Operator (host shell) | Process restart                                            |
| Feature settings    | MongoDB   | Admin via Web UI      | Saved immediately to the `ConfigService` cache (see below) |

Some services (cron-driven schedules, channel managers) cache derived
state that does not refresh automatically when their config changes —
those have a per-page reload button on the Web UI. Plain feature
toggles take effect on the next read.

**Rule:** if a value is read at startup (Discord token, Mongo URI,
`WEBUI_*` secrets), it goes in `.env`. Anything else lives in MongoDB
and is edited through the Web UI's Settings page.

`process.env` is read at boot by a known set of modules — `src/index.ts`,
`src/web/index.ts`, `src/web/session.ts`, `src/web/csrf.ts`,
`src/web/admin-layout.ts`, `src/web/read-only-routes.ts` (bootstrap
page), `src/services/config-service.ts` (for the env→bootstrap-key
mappings), `src/services/web-session-service.ts`,
`src/services/discord-logger.ts`, `src/services/startup-migrator.ts`,
and `src/utils/logger.ts`. New service code should prefer reading
through `ConfigService` so the same lookup path serves both surfaces;
add new direct `process.env` reads only when the value is genuinely a
startup-only secret.

The protected-keys list lives at the top of `src/web/write-routes.ts`
(`PROTECTED_KEYS`). It is hand-maintained — when you add a new
**bootstrap** env var (something whose value should never round-trip
through YAML import/export), add it to that set so imports can't
overwrite it. Operational tuning vars like `WEBUI_TRUST_PROXY` don't
need to be there since they aren't represented as DB-backed keys.

#### Adding New Config Keys

**Step 1**: Define in `config-schema.ts`:

```typescript
export interface ConfigSchema {
  "myfeature.enabled": boolean;
  "myfeature.setting": string;
}

export const defaultConfig: ConfigSchema = {
  "myfeature.enabled": false,
  "myfeature.setting": "default-value",
};
```

**Step 2**: Access in code (only inside a service):

```typescript
const enabled = await configService.getBoolean("myfeature.enabled", false);
const setting = await configService.getString("myfeature.setting", "default");
```

**Step 3**: Document in `SETTINGS.md`.

**Step 4**: If the setting needs to appear on the Setup Wizard, add it to
`WIZARD_FEATURE_SETTINGS` in `src/web/write-routes.ts`. The Settings page
discovers settings from `defaultConfig` automatically.

#### Configuration Best Practices

- Use dot notation: `feature.subsetting`
- Group by domain: `voicechannels.*`, `quotes.*`, etc.
- Always provide defaults
- **Prefer `ConfigService` for runtime feature settings.** Direct
  `process.env` reads are expected at boot in `src/index.ts`,
  `src/web/`, and a small allowlist of services (see the
  "Configuration Management" section above for the current list). New
  runtime feature code should go through `ConfigService` so the slash
  command and Web UI surfaces see the same value.
- Use appropriate type methods: `getBoolean()`, `getString()`, `getNumber()`

---

## Adding New Features

### Feature Development Checklist

1. **Planning**
   - [ ] Define feature requirements
   - [ ] Identify affected services
   - [ ] Plan configuration keys

2. **Implementation**
   - [ ] Create/modify service files
   - [ ] Add configuration schema
   - [ ] Implement business logic
   - [ ] Add error handling

3. **Integration**
   - [ ] Register in `src/index.ts`
   - [ ] Add command (if needed)
   - [ ] Setup permissions

4. **Testing**
   - [ ] Write unit tests
   - [ ] Test manually in Discord
   - [ ] Verify edge cases

5. **Web UI surface** (if applicable)
   - [ ] Add a read-only view in `src/web/read-only-routes.ts` / `admin-views.ts`
   - [ ] Add write handlers in `src/web/write-routes.ts` (CSRF + session required)
   - [ ] Link the page from `NAV_ITEMS` in `admin-layout.ts`
   - [ ] Routes stay thin — no business logic outside services

6. **Documentation**
   - [ ] Update `COMMANDS.md` (only if there's a user-facing slash command — admin commands now live in the Web UI)
   - [ ] Update `SETTINGS.md` with new DB-backed keys
   - [ ] Update `WEBUI.md` if you added a new page or env var
   - [ ] Update `.env.example` if you added a bootstrap env var
   - [ ] Add to `DEVELOPER_GUIDE.md` if you established a reusable pattern

---

## Testing Guidelines

KoolBot uses Jest for testing with TypeScript support.

### Running Tests

```bash
# Run all tests
npm test

# Run specific test file
npm test -- path/to/test.test.ts

# Run with coverage
npm run test:coverage

# Watch mode
npm run test:watch
```

### Test Structure

```typescript
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

describe('MyService', () => {
  let mockClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = {
      // Mock Discord client
    };
  });

  it('should do something', () => {
    // Arrange
    const service = MyService.getInstance(mockClient);
    
    // Act
    const result = service.doSomething();
    
    // Assert
    expect(result).toBe(expectedValue);
  });
});
```

### Mocking

Global mocks are configured in `__tests__/setup.ts`:

- ConfigService (mocked globally)
- Mongoose (mocked globally)
- Discord.js (mock per test)

---

## Code Style

### TypeScript Standards

- **Strict Mode**: Enabled in `tsconfig.json`
- **ESLint**: Run `npm run lint` before committing
- **Prettier**: Run `npm run format` to auto-format

### Naming Conventions

- **Services**: `PascalCase` with `Service` suffix (e.g., `ConfigService`)
- **Methods**: `camelCase` (e.g., `getUserData()`)
- **Private Methods**: Prefix with underscore optional, use `private` keyword
- **Constants**: `UPPER_SNAKE_CASE` for true constants
- **Config Keys**: `lowercase.dot.notation`

### Comments

Use JSDoc for public methods:

```typescript
/**
 * Brief description of what the method does
 * 
 * @param paramName - Description of parameter
 * @returns Description of return value
 * @throws {ErrorType} When error occurs
 * @example
 * // Usage example
 * const result = await service.myMethod('value');
 */
public async myMethod(paramName: string): Promise<Result> {
  // Implementation
}
```

### Error Handling

Always handle errors gracefully:

```typescript
try {
  await riskyOperation();
} catch (error) {
  logger.error("Context about what failed:", error);
  // Don't crash the bot - degrade gracefully
}
```

---

## Dependency Notes

### Benign `glob` deprecation warning on install

`npm install` (and the Docker build) prints repeated deprecation warnings such as:

```text
npm warn deprecated glob@10.5.0: Old versions of glob are not supported, and contain widely
publicized security vulnerabilities, which have been fixed in the current version. Please update…
```

This is **build-log noise, not an audit finding.** The offending copies (`glob@10.5.0` and `glob@7.2.3`)
are transitive devDependencies pulled in by the Jest toolchain — `@jest/reporters`, `jest-config`,
`jest-runtime` pin `glob@^10.5.0`, and `test-exclude` (Istanbul coverage) pulls `glob@^7.1.4`. We do not
depend on `glob` directly. `npm audit` reports **0** glob vulnerabilities in our resolved tree; the
warning text is the blanket deprecation message glob's author attaches to all sub-latest versions, not an
advisory matching our pinned versions.

We intentionally **do not** force a newer `glob` via the `overrides` block. Jest's internals are written
against glob 10, and glob 11+ changed its API/defaults and raised its Node floor — overriding it risks
breaking `npm test`. The warning will disappear for free once a future `jest` release moves to a newer
glob; we take that via the normal dependency bump.

Tracked in [issue #605](https://github.com/lonix/koolbot/issues/605). See also
[#601](https://github.com/lonix/koolbot/issues/601) (`brace-expansion`, the actual audit finding) and
[#602](https://github.com/lonix/koolbot/issues/602) (direct-dependency bumps).

---

## Additional Resources

- [CONTRIBUTING.md](./CONTRIBUTING.md) — Contribution guidelines
- [WEBUI.md](./WEBUI.md) — Web UI setup, magic-link flow, reverse-proxy guidance
- [SETTINGS.md](./SETTINGS.md) — Configuration reference
- [COMMANDS.md](./COMMANDS.md) — Command documentation
- [TESTING.md](./TESTING.md) — Testing documentation

---

## Questions or Improvements?

Found an issue or have suggestions for this guide? Please open an issue or submit a pull request!
