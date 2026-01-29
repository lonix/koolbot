# KoolBot Developer Guide

Complete guide for developers extending or maintaining KoolBot.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Common Patterns](#common-patterns)
  - [Bot-Controlled Channel Header Posts](#bot-controlled-channel-header-posts)
  - [Service Singleton Pattern](#service-singleton-pattern)
  - [Configuration Management](#configuration-management)
- [Adding New Features](#adding-new-features)
- [Testing Guidelines](#testing-guidelines)
- [Code Style](#code-style)

---

## Architecture Overview

KoolBot follows a service-oriented architecture where each service owns a specific domain:

```text
src/
├── index.ts              # Entry point, service initialization
├── commands/             # Discord slash commands
├── services/             # Business logic services
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
```

- **ConfigService**: Configuration management with MongoDB persistence
- **CommandManager**: Discord command registration and routing
- **VoiceChannelManager**: Dynamic voice channel lifecycle
- **QuoteChannelManager**: Quote channel management and permissions
- **DiscordLogger**: Logging to Discord channels

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

Users can manage headers via Discord commands:

```bash
# Disable header
/config set key:feature.header_enabled value:false
/config reload

# Enable without pinning
/config set key:feature.header_enabled value:true
/config set key:feature.header_pin_enabled value:false
/config reload
```

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

Configuration uses a two-tier system: environment variables for secrets, MongoDB for runtime config.

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

**Step 2**: Access in code:

```typescript
const enabled = await configService.getBoolean("myfeature.enabled", false);
const setting = await configService.getString("myfeature.setting", "default");
```

**Step 3**: Document in `SETTINGS.md`.

#### Configuration Best Practices

- Use dot notation: `feature.subsetting`
- Group by domain: `voicechannels.*`, `quotes.*`, etc.
- Always provide defaults
- Never access `process.env` directly (except in config service)
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

5. **Documentation**
   - [ ] Update `COMMANDS.md`
   - [ ] Update `SETTINGS.md`
   - [ ] Add to `DEVELOPER_GUIDE.md`
   - [ ] Update `DOCS_SUMMARY.md`

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

## Additional Resources

- [CONTRIBUTING.md](./CONTRIBUTING.md) - Contribution guidelines
- [SETTINGS.md](./SETTINGS.md) - Configuration reference
- [COMMANDS.md](./COMMANDS.md) - Command documentation
- [TESTING.md](./TESTING.md) - Testing documentation

---

## Questions or Improvements?

Found an issue or have suggestions for this guide? Please open an issue or submit a pull request!
