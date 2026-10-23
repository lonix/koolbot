import { URLSearchParams } from "node:url";
import {
  Routes,
  Client,
  Collection,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  DiscordAPIError,
  HTTPError,
  MessageFlags,
} from "discord.js";
import logger, { isDebugMode } from "../utils/logger.js";
import { getErrorMessage } from "../utils/error-guards.js";
import { getSharedRest } from "../utils/discord-rest.js";
import { commandListsMatch } from "../utils/command-diff.js";
import { recordCommandAudit } from "../utils/record-command-audit.js";
import { ConfigService } from "./config-service.js";
import { COMMAND_CONFIGS, isCommandEnabled } from "./command-registry.js";
import { MonitoringService } from "./monitoring-service.js";
import { recordCommandInvocation } from "../web/metrics.js";
import { CooldownManager } from "./cooldown-manager.js";
import { consumeBurst } from "../utils/member-cooldown.js";
import {
  PermissionCheckError,
  PermissionsService,
} from "./permissions-service.js";

interface CommandModule {
  data: SlashCommandBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

export class CommandManager {
  private static instance: CommandManager;
  private client: Client;
  private configService: ConfigService;
  private commands: Collection<string, CommandModule>;
  private cooldownManager: CooldownManager;
  private permissionsService: PermissionsService;

  private constructor(client: Client) {
    this.client = client;
    this.configService = ConfigService.getInstance();
    this.cooldownManager = new CooldownManager();
    this.permissionsService = PermissionsService.getInstance(client);
    this.commands = new Collection();

    // Configuration reload callback intentionally omitted (manual /config reload only)
  }

  public static getInstance(client: Client): CommandManager {
    if (!CommandManager.instance) {
      CommandManager.instance = new CommandManager(client);
    } else if (CommandManager.instance.client !== client) {
      throw new Error(
        "CommandManager already initialised with a different client",
      );
    }
    return CommandManager.instance;
  }

  /**
   * Rate limit for button, select-menu and modal interactions (#1147). They
   * are dispatched straight from `index.ts` and never pass through
   * `executeCommand`, so the command limiter does not see them. Governed by the
   * same switch, window and admin bypass (`ratelimit.*`) with its own, higher
   * ceiling (`ratelimit.max_components`), since several clicks in a row are
   * normal. Returns 0 when the interaction may proceed (and records it),
   * otherwise the seconds the member should wait.
   */
  public async componentRateLimitWait(interaction: {
    user: { id: string };
    memberPermissions?: { has(permission: "Administrator"): boolean } | null;
  }): Promise<number> {
    if (!(await this.configService.getBoolean("ratelimit.enabled", false))) {
      return 0;
    }
    const bypassAdmin = await this.configService.getBoolean(
      "ratelimit.bypass_admin",
      true,
    );
    if (bypassAdmin && interaction.memberPermissions?.has("Administrator")) {
      return 0;
    }
    const max = await this.configService.getNumber(
      "ratelimit.max_components",
      15,
    );
    const windowSeconds = await this.configService.getNumber(
      "ratelimit.window_seconds",
      10,
    );
    return consumeBurst("component", interaction.user.id, max, windowSeconds);
  }

  /**
   * Apply {@link componentRateLimitWait} and, when over the limit, answer with
   * a short ephemeral message. Returns true when the interaction must not be
   * handled. An over-limit interaction is refused even if the refusal message
   * cannot be delivered; only a failure of the limiter itself fails open.
   */
  public async refuseIfComponentRateLimited(
    interaction: Parameters<CommandManager["componentRateLimitWait"]>[0] & {
      reply(options: {
        content: string;
        flags: MessageFlags.Ephemeral;
      }): Promise<unknown>;
    },
  ): Promise<boolean> {
    let wait: number;
    try {
      wait = await this.componentRateLimitWait(interaction);
    } catch (error) {
      logger.error("Error applying the component rate limit:", error);
      return false;
    }
    if (wait <= 0) return false;
    try {
      await interaction.reply({
        content: `⏱️ You're clicking too quickly! Please wait ${wait} second${wait !== 1 ? "s" : ""} before trying again.`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      logger.warn("Could not deliver the component rate-limit notice:", error);
    }
    return true;
  }

  public static reset(): void {
    CommandManager.instance = undefined as unknown as CommandManager;
  }

  async initialize(): Promise<unknown[]> {
    try {
      // Load commands dynamically from the individual command modules.
      const commands = await this.loadCommandsDynamically();

      logger.info(`Loaded ${commands.length} commands`);
      return commands;
    } catch (error) {
      logger.error("Error initializing CommandManager:", error);
      throw error;
    }
  }

  private async loadCommandsDynamically(): Promise<unknown[]> {
    try {
      const commands = [];
      const enabledCommands = [];
      const debugModeEnabled = isDebugMode();

      // Process each command
      for (const config of COMMAND_CONFIGS) {
        try {
          const shouldEnable = await isCommandEnabled(config, (key, def) =>
            this.configService.getBoolean(key, def),
          );

          if (shouldEnable) {
            // Import the command data
            const commandModule = await import(`../commands/${config.file}.js`);
            const commandData = commandModule.data;

            commands.push(commandData.toJSON());
            enabledCommands.push(config.name);

            if (debugModeEnabled) {
              logger.debug(`✓ /${config.name} command enabled`);
            }
          } else if (debugModeEnabled) {
            logger.debug(`✗ /${config.name} command disabled`);
          }
        } catch (error) {
          logger.warn(`Failed to load command ${config.name}:`, error);
        }
      }

      if (debugModeEnabled) {
        logger.debug(`Enabled commands: ${enabledCommands.join(", ")}`);
      }

      return commands;
    } catch (error) {
      logger.error("Error loading commands dynamically:", error);
      throw error;
    }
  }

  private async getEnabledCommands(): Promise<unknown[]> {
    return this.loadCommandsDynamically();
  }

  // Helper function to make Discord API calls with timeout and retry logic.
  // Public so other services (e.g. ReactionRoleService's startup
  // reconciliation) can reuse the shared timeout + backoff behaviour for bulk
  // REST work, per CLAUDE.md's resilience guidance.
  public async makeDiscordApiCall<T>(
    apiCall: () => Promise<T>,
    operationName: string,
    timeoutMs: number = 30000,
    maxRetries: number = 3,
    // Pass false for non-idempotent creates/sends: the race below does not
    // cancel the original request, so retrying a timed-out call could run it
    // twice. Rate-limit retries are unaffected (a 429 means it did not run).
    retryOnTimeout: boolean = true,
    // Pass false when the caller reports a failure itself (best-effort calls
    // that would otherwise log the same error every scan).
    logErrors: boolean = true,
  ): Promise<T> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      // Track the timeout handle so it can be cleared once the race settles —
      // otherwise a fast-resolving apiCall leaves the timer pending, keeping
      // the event loop alive (and tripping Jest's open-handle warning).
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      try {
        // Create a timeout promise
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error(`Discord API timeout after ${timeoutMs}ms`)),
            timeoutMs,
          );
          timeoutHandle.unref?.();
        });

        // Race the API call against the timeout
        const result = await Promise.race([apiCall(), timeoutPromise]);

        if (attempt > 1) {
          logger.info(`✅ ${operationName} succeeded on attempt ${attempt}`);
        }
        return result;
      } catch (error: unknown) {
        const message = getErrorMessage(error);

        // HTTP 429 surfaces as DiscordAPIError or HTTPError with status 429.
        // The retry delay is in `rawError.retry_after` (seconds) on
        // DiscordAPIError; HTTPError doesn't expose it, so fall back to a
        // conservative default.
        const httpStatus =
          error instanceof DiscordAPIError || error instanceof HTTPError
            ? error.status
            : undefined;
        const isRateLimit =
          httpStatus === 429 || message.toLowerCase().includes("rate limit");
        const isTimeout = message.toLowerCase().includes("timeout");

        if (isRateLimit) {
          let retryAfter = 5;
          if (error instanceof DiscordAPIError) {
            const raw = error.rawError as { retry_after?: number } | undefined;
            if (typeof raw?.retry_after === "number") {
              retryAfter = raw.retry_after;
            }
          }
          // Nothing is retried after the last attempt, so nothing is waited
          // for either: a caller that passes one attempt (a fail-fast write
          // that holds a lock) gets the rate-limit error at once.
          if (attempt < maxRetries) {
            logger.warn(
              `⚠️ Discord rate limited for ${operationName}, retrying in ${retryAfter}s (attempt ${attempt}/${maxRetries})`,
            );
            await new Promise((resolve) =>
              setTimeout(resolve, retryAfter * 1000),
            );
          }
        } else if (isTimeout && !retryOnTimeout) {
          logger.warn(
            `⏰ Discord API timeout for ${operationName}, not retrying (non-idempotent)`,
          );
          throw new Error(
            `Discord API timeout for ${operationName}; not retried because it may still complete`,
            { cause: error },
          );
        } else if (isTimeout) {
          logger.warn(
            `⏰ Discord API timeout for ${operationName} (attempt ${attempt}/${maxRetries})`,
          );
          if (attempt < maxRetries) {
            await new Promise((resolve) => setTimeout(resolve, 2000 * attempt)); // Exponential backoff
          }
        } else {
          if (logErrors) {
            logger.error(`❌ Discord API error for ${operationName}:`, error);
          }
          throw error;
        }

        if (attempt === maxRetries) {
          throw new Error(
            `Failed to ${operationName} after ${maxRetries} attempts`,
            { cause: error },
          );
        }
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      }
    }

    throw new Error(`Unexpected error in ${operationName}`);
  }

  /**
   * True only when a GET of the guild's commands matches `commands`. Any
   * failure (GET error, timeout, odd shape) returns false so the caller sends
   * the PUT: the skip is an optimisation, never a correctness risk.
   */
  private async isRegistrationUpToDate(
    rest: ReturnType<typeof getSharedRest>,
    route: `/${string}`,
    commands: unknown[],
  ): Promise<boolean> {
    try {
      const registered = await this.makeDiscordApiCall(
        async () =>
          // Without with_localizations Discord omits the translation
          // dictionaries, which would hide added/removed translations.
          rest.get(route, {
            query: new URLSearchParams({ with_localizations: "true" }),
          }),
        "fetch registered commands",
        15000,
        1,
      );
      const same = commandListsMatch(commands, registered);
      if (!same) {
        logger.debug(
          "Registered guild commands differ; sending bulk overwrite",
        );
      }
      return same;
    } catch (error) {
      logger.debug(
        "Could not compare registered commands; sending bulk overwrite:",
        error,
      );
      return false;
    }
  }

  /**
   * Registration runs one at a time (#1307). Each run loads the desired list
   * when it starts, compares and overwrites; if two overlapped, both could
   * read the same registered list, one would skip as "unchanged" and the
   * other's older PUT would then land last, leaving Discord outdated. The
   * queue means the last request always sees the previous run's result. A
   * failed run rejects its own caller only; it never blocks later runs.
   */
  private registrationQueue: Promise<void> = Promise.resolve();

  public registerCommands(): Promise<void> {
    const run = this.registrationQueue.then(() => this.registerCommandsOnce());
    this.registrationQueue = run.catch(() => undefined);
    return run;
  }

  private async registerCommandsOnce(): Promise<void> {
    try {
      if (!this.client) {
        throw new Error("Client not set");
      }

      const guildId = await this.configService.getString("GUILD_ID");
      if (!guildId) {
        throw new Error("GUILD_ID not set in configuration");
      }

      const rest = getSharedRest(
        await this.configService.getString("DISCORD_TOKEN"),
      );

      const commands = await this.getEnabledCommands();
      logger.debug(
        `Attempting to register ${commands.length} commands with Discord API for guild ${guildId}...`,
      );

      try {
        // One bulk overwrite (PUT) replaces the guild's whole command list
        // atomically: commands that are no longer in `commands` (a disabled
        // feature, a retired command such as /event) are deleted by Discord in
        // the same call, and unchanged ones are left as they are. Do NOT clear
        // with `PUT []` first (#1293): that deleted and re-created every command
        // on each start, spent the per-day command-create budget, and added a
        // second request on a route Discord rate limits. Discord's client cache
        // picks up an overwrite on its own, so no clear is needed for that. The
        // bot's own lookup table is rebuilt by populateClientCommands().
        const clientId = await this.configService.getString("CLIENT_ID");
        const route = Routes.applicationGuildCommands(clientId, guildId);

        // Skip the PUT when Discord already has exactly this list (#1307), so
        // a plain restart sends no write. Any doubt or error sends the PUT.
        if (await this.isRegistrationUpToDate(rest, route, commands)) {
          logger.debug(
            `Guild commands unchanged (${commands.length}); skipping bulk overwrite`,
          );
          logger.info("Guild commands already up to date");
          return;
        }

        logger.debug("Registering commands with Discord API...");
        const data = await this.makeDiscordApiCall(
          async () => rest.put(route, { body: commands }),
          "register new commands",
          30000, // 30 second timeout for registration
          3, // 3 retries for registration
        );

        logger.debug("Discord API response:", data);
        logger.info("Successfully registered guild commands");
      } catch (error) {
        logger.error("Error registering commands:", error);
        throw error;
      }
    } catch (error) {
      logger.error("Error in registerCommands:", error);
      throw error;
    }
  }

  public async populateClientCommands(): Promise<void> {
    try {
      if (!this.client) {
        throw new Error("Client not set");
      }
      const debugModeEnabled = isDebugMode();

      // Clear existing commands
      this.client.commands.clear();

      // Process each command
      for (const config of COMMAND_CONFIGS) {
        try {
          const shouldEnable = await isCommandEnabled(config, (key, def) =>
            this.configService.getBoolean(key, def),
          );

          if (shouldEnable) {
            // Import the command execute function
            const commandModule = await import(`../commands/${config.file}.js`);
            let executeFunction;
            let autocompleteFunction;

            // Handle different export patterns
            if (commandModule.execute) {
              executeFunction = commandModule.execute;
            } else if (commandModule.command && commandModule.command.execute) {
              executeFunction = commandModule.command.execute;
            } else {
              logger.warn(`Command ${config.name} has no execute function`);
              continue;
            }

            // Check for autocomplete function
            if (commandModule.autocomplete) {
              autocompleteFunction = commandModule.autocomplete;
            }

            this.client.commands.set(config.name, {
              execute: executeFunction,
              autocomplete: autocompleteFunction,
            });

            if (debugModeEnabled) {
              logger.debug(`✓ /${config.name} command loaded`);
            }
          } else if (debugModeEnabled) {
            logger.debug(`✗ /${config.name} command disabled`);
          }
        } catch (error) {
          logger.warn(`Failed to load command ${config.name}:`, error);
        }
      }

      logger.info(
        `Populated client.commands with ${this.client.commands.size} commands`,
      );
      const availableCommandNames = Array.from(
        this.client.commands.keys(),
      ).sort();
      logger.info(`Available commands: ${availableCommandNames.join(", ")}`);
    } catch (error) {
      logger.error("Error populating client commands:", error);
      throw error;
    }
  }

  public async unregisterCommands(): Promise<void> {
    try {
      if (!this.client) {
        throw new Error("Client not set");
      }

      const guildId = await this.configService.getString("GUILD_ID");
      if (!guildId) {
        throw new Error("GUILD_ID not set in configuration");
      }

      const rest = getSharedRest(
        await this.configService.getString("DISCORD_TOKEN"),
      );

      try {
        await rest.put(
          Routes.applicationGuildCommands(
            await this.configService.getString("CLIENT_ID"),
            guildId,
          ),
          { body: [] },
        );

        logger.info("Successfully unregistered all guild commands");
      } catch (error) {
        logger.error("Error unregistering commands:", error);
        throw error;
      }
    } catch (error) {
      logger.error("Error in unregisterCommands:", error);
      throw error;
    }
  }

  /**
   * Execute a command with monitoring and rate limiting
   */
  public async executeCommand(
    commandName: string,
    interaction: ChatInputCommandInteraction,
    executeFunction: () => Promise<void>,
  ): Promise<void> {
    const monitoringService = MonitoringService.getInstance();
    const startTime = Date.now();
    const trackingId = monitoringService.trackCommandStart(commandName);
    // `getSubcommand(false)` returns null when the command has no
    // subcommand group rather than throwing — safe to call on every
    // chat-input interaction.
    let subcommand: string | null;
    try {
      subcommand = interaction.options.getSubcommand(false) ?? null;
    } catch {
      subcommand = null;
    }

    const auditCommon = {
      commandName,
      subcommand,
      channelId: interaction.channelId ?? null,
      discordUserId: interaction.user.id,
    };
    const recordAudit = async (
      result: "success" | "error" | "denied",
      errorMessage: string | null,
    ): Promise<void> => {
      if (!interaction.guildId) return;
      const enabled = await this.configService
        .getBoolean("core.command_audit.enabled", true)
        .catch(() => true);
      if (!enabled) return;
      await recordCommandAudit({
        ...auditCommon,
        guildId: interaction.guildId,
        result,
        errorMessage,
        durationMs: Date.now() - startTime,
      });
    };

    try {
      // Check permissions (admins bypass this check inside the service)
      const guildId = interaction.guildId;
      const userId = interaction.user.id;

      if (guildId && userId) {
        let hasPermission: boolean;
        try {
          // `onUnavailable: "throw"` keeps "couldn't check" distinct from
          // "checked and denied": without it a failed permissions-cache
          // load would fall through to the service's default-open branch
          // and run every role-gated command ungated (#836).
          hasPermission = await this.permissionsService.checkCommandPermission(
            userId,
            guildId,
            commandName,
            { onUnavailable: "throw" },
          );
        } catch (error) {
          if (!(error instanceof PermissionCheckError)) {
            throw error;
          }

          logger.error(
            `Permission check for ${commandName} unavailable, refusing execution:`,
            error,
          );
          await interaction.reply({
            content:
              "⚠️ Permissions can't be verified right now. Please try again in a moment.",
            flags: MessageFlags.Ephemeral,
          });

          monitoringService.trackCommandEnd(
            commandName,
            trackingId,
            startTime,
            false,
          );
          await recordAudit("denied", "Permission check unavailable");
          return;
        }

        if (!hasPermission) {
          await interaction.reply({
            content: "❌ You don't have permission to use this command.",
            flags: MessageFlags.Ephemeral,
          });

          monitoringService.trackCommandEnd(
            commandName,
            trackingId,
            startTime,
            false,
          );
          await recordAudit("denied", "Permission denied");
          return;
        }
      }

      // Check rate limiting if enabled
      const rateLimitEnabled = await this.configService.getBoolean(
        "ratelimit.enabled",
        false,
      );

      if (rateLimitEnabled) {
        const maxCommands = await this.configService.getNumber(
          "ratelimit.max_commands",
          5,
        );
        const windowSeconds = await this.configService.getNumber(
          "ratelimit.window_seconds",
          10,
        );
        const bypassAdmin = await this.configService.getBoolean(
          "ratelimit.bypass_admin",
          true,
        );

        const userId = interaction.user.id;
        const isAdmin =
          interaction.memberPermissions?.has("Administrator") || false;

        // Check if user should be rate limited
        if (!(bypassAdmin && isAdmin)) {
          const isRateLimited = this.cooldownManager.isRateLimited(
            userId,
            maxCommands,
            windowSeconds,
          );

          if (isRateLimited) {
            const resetTime = this.cooldownManager.getRateLimitReset(
              userId,
              maxCommands,
              windowSeconds,
            );
            const errorMessage = `⏱️ You're using commands too quickly! Please wait ${resetTime} second${resetTime !== 1 ? "s" : ""} before trying again.`;

            await interaction.reply({
              content: errorMessage,
              flags: MessageFlags.Ephemeral,
            });

            monitoringService.trackCommandEnd(
              commandName,
              trackingId,
              startTime,
              false,
            );
            await recordAudit("denied", "Rate limited");
            return;
          }

          // Track this command execution
          this.cooldownManager.trackCommandExecution(userId, windowSeconds);
        }
      }

      await executeFunction();
      monitoringService.trackCommandEnd(
        commandName,
        trackingId,
        startTime,
        true,
        interaction.guildId,
      );
      recordCommandInvocation(commandName, "ok");
      await recordAudit("success", null);
    } catch (error) {
      monitoringService.trackCommandEnd(
        commandName,
        trackingId,
        startTime,
        false,
        interaction.guildId,
      );
      monitoringService.trackError(commandName, error as Error);
      recordCommandInvocation(commandName, "error");
      await recordAudit("error", getErrorMessage(error).slice(0, 500));
      throw error;
    }
  }
}
