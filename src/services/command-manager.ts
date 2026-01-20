import {
  REST,
  Routes,
  Client,
  Collection,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from "discord.js";
import { config as dotenvConfig } from "dotenv";
import logger from "../utils/logger.js";
import { ConfigService } from "./config-service.js";
import { MonitoringService } from "./monitoring-service.js";
import { CooldownManager } from "./cooldown-manager.js";
import { PermissionsService } from "./permissions-service.js";

dotenvConfig();
const isDebug = process.env.DEBUG === "true";

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
    }
    return CommandManager.instance;
  }

  async initialize(): Promise<unknown[]> {
    try {
      // Load commands dynamically from commands/index.ts
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

      // Define command configurations with their requirements
      const commandConfigs = [
        { name: "ping", configKey: "ping.enabled", file: "ping" },
        { name: "help", configKey: "help.enabled", file: "help" },
        { name: "amikool", configKey: "amikool.enabled", file: "amikool" },
        { name: "vctop", configKey: "voicetracking.enabled", file: "vctop" },
        {
          name: "vcstats",
          configKey: "voicetracking.enabled",
          file: "vcstats",
        },
        { name: "seen", configKey: "voicetracking.seen.enabled", file: "seen" },
        {
          name: "transfer-ownership",
          configKey: "voicechannels.enabled",
          file: "transfer-ownership",
        },
        {
          name: "announce-vc-stats",
          configKey: "voicetracking.announcements.enabled",
          file: "announce-vc-stats",
        },
        {
          name: "achievements",
          configKey: "gamification.enabled",
          file: "achievements",
        },
        { name: "quote", configKey: "quotes.enabled", file: "quote" },
        {
          name: "announce",
          configKey: "announcements.enabled",
          file: "announce",
        },
        { name: "dbtrunk", configKey: null, file: "dbtrunk" }, // Always enabled for admins
        { name: "vc", configKey: "voicechannels.enabled", file: "vc" },
        { name: "config", configKey: null, file: "config/index" }, // Always enabled
        { name: "botstats", configKey: null, file: "botstats" }, // Always enabled
        { name: "permissions", configKey: null, file: "permissions" }, // Always enabled for admins
        {
          name: "reactrole",
          configKey: "reactionroles.enabled",
          file: "reactrole",
        },
      ];

      // Process each command
      for (const config of commandConfigs) {
        try {
          let shouldEnable = true;

          // Check configuration if required
          if (config.configKey) {
            shouldEnable = await this.configService.getBoolean(
              config.configKey,
              false,
            );
          }

          if (shouldEnable) {
            // Import the command data
            const commandModule = await import(`../commands/${config.file}.js`);
            const commandData = commandModule.data;

            commands.push(commandData.toJSON());
            enabledCommands.push(config.name);

            if (isDebug) {
              logger.debug(`✓ /${config.name} command enabled`);
            }
          } else if (isDebug) {
            logger.debug(`✗ /${config.name} command disabled`);
          }
        } catch (error) {
          logger.warn(`Failed to load command ${config.name}:`, error);
        }
      }

      if (isDebug) {
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

  // Helper function to make Discord API calls with timeout and retry logic
  private async makeDiscordApiCall<T>(
    apiCall: () => Promise<T>,
    operationName: string,
    timeoutMs: number = 30000,
    maxRetries: number = 3,
  ): Promise<T> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Create a timeout promise
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error(`Discord API timeout after ${timeoutMs}ms`)),
            timeoutMs,
          );
        });

        // Race the API call against the timeout
        const result = await Promise.race([apiCall(), timeoutPromise]);

        if (attempt > 1) {
          logger.info(`✅ ${operationName} succeeded on attempt ${attempt}`);
        }
        return result;
      } catch (error: unknown) {
        const err = error as {
          code?: number;
          message?: string;
          retry_after?: number;
        };
        const isRateLimit =
          err.code === 429 || err.message?.includes("rate limit");
        const isTimeout = err.message?.includes("timeout");

        if (isRateLimit) {
          const retryAfter = err.retry_after || 5;
          logger.warn(
            `⚠️ Discord rate limited for ${operationName}, retrying in ${retryAfter}s (attempt ${attempt}/${maxRetries})`,
          );
          await new Promise((resolve) =>
            setTimeout(resolve, retryAfter * 1000),
          );
        } else if (isTimeout) {
          logger.warn(
            `⏰ Discord API timeout for ${operationName} (attempt ${attempt}/${maxRetries})`,
          );
          if (attempt < maxRetries) {
            await new Promise((resolve) => setTimeout(resolve, 2000 * attempt)); // Exponential backoff
          }
        } else {
          logger.error(`❌ Discord API error for ${operationName}:`, err);
          throw err;
        }

        if (attempt === maxRetries) {
          throw new Error(
            `Failed to ${operationName} after ${maxRetries} attempts`,
          );
        }
      }
    }

    throw new Error(`Unexpected error in ${operationName}`);
  }

  public async registerCommands(): Promise<void> {
    try {
      if (!this.client) {
        throw new Error("Client not set");
      }

      const guildId = await this.configService.getString("GUILD_ID");
      if (!guildId) {
        throw new Error("GUILD_ID not set in configuration");
      }

      const rest = new REST({ version: "10" }).setToken(
        await this.configService.getString("DISCORD_TOKEN"),
      );

      const commands = await this.getEnabledCommands();
      logger.debug(
        `Attempting to register ${commands.length} commands with Discord API for guild ${guildId}...`,
      );

      try {
        // First, clear all existing commands to force Discord to refresh its cache
        logger.debug(
          "Clearing all existing commands to force Discord cache refresh...",
        );
        await this.makeDiscordApiCall(
          async () =>
            rest.put(
              Routes.applicationGuildCommands(
                await this.configService.getString("CLIENT_ID"),
                guildId,
              ),
              { body: [] },
            ),
          "clear existing commands",
          15000, // 15 second timeout for clear operation
          2, // 2 retries for clear operation
        );

        // Wait a moment for Discord to process the clear
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Now register the new command list
        logger.debug("Registering new commands with Discord API...");
        const data = await this.makeDiscordApiCall(
          async () =>
            rest.put(
              Routes.applicationGuildCommands(
                await this.configService.getString("CLIENT_ID"),
                guildId,
              ),
              { body: commands },
            ),
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

      // Clear existing commands
      this.client.commands.clear();

      // Define command configurations with their requirements
      const commandConfigs = [
        { name: "ping", configKey: "ping.enabled", file: "ping" },
        { name: "amikool", configKey: "amikool.enabled", file: "amikool" },
        { name: "vctop", configKey: "voicetracking.enabled", file: "vctop" },
        {
          name: "vcstats",
          configKey: "voicetracking.enabled",
          file: "vcstats",
        },
        { name: "seen", configKey: "voicetracking.seen.enabled", file: "seen" },
        {
          name: "transfer-ownership",
          configKey: "voicechannels.enabled",
          file: "transfer-ownership",
        },
        {
          name: "announce-vc-stats",
          configKey: "voicetracking.announcements.enabled",
          file: "announce-vc-stats",
        },
        { name: "quote", configKey: "quotes.enabled", file: "quote" },
        { name: "dbtrunk", configKey: null, file: "dbtrunk" }, // Always enabled for admins
        { name: "vc", configKey: "voicechannels.enabled", file: "vc" },
        { name: "config", configKey: null, file: "config/index" }, // Always enabled
        { name: "botstats", configKey: null, file: "botstats" }, // Always enabled
        { name: "permissions", configKey: null, file: "permissions" }, // Always enabled for admins
        { name: "setup-lobby", configKey: null, file: "setup-lobby" }, // Always enabled
      ];

      // Process each command
      for (const config of commandConfigs) {
        try {
          let shouldEnable = true;

          // Check configuration if required
          if (config.configKey) {
            const configValue = await this.configService.get(config.configKey);
            shouldEnable = configValue === true;
          }

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

            if (isDebug) {
              logger.debug(`✓ /${config.name} command loaded`);
            }
          } else if (isDebug) {
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

      const rest = new REST({ version: "10" }).setToken(
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

    try {
      // Check permissions (admins bypass this check inside the service)
      const guildId = interaction.guildId;
      const userId = interaction.user.id;

      if (guildId && userId) {
        const hasPermission =
          await this.permissionsService.checkCommandPermission(
            userId,
            guildId,
            commandName,
          );

        if (!hasPermission) {
          await interaction.reply({
            content: "❌ You don't have permission to use this command.",
            ephemeral: true,
          });

          monitoringService.trackCommandEnd(
            commandName,
            trackingId,
            startTime,
            false,
          );
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
              ephemeral: true,
            });

            monitoringService.trackCommandEnd(
              commandName,
              trackingId,
              startTime,
              false,
            );
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
      );
    } catch (error) {
      monitoringService.trackCommandEnd(
        commandName,
        trackingId,
        startTime,
        false,
      );
      monitoringService.trackError(commandName, error as Error);
      throw error;
    }
  }
}
