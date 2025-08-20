import { REST, Routes, Client, Collection } from "discord.js";
import { config as dotenvConfig } from "dotenv";
import logger from "../utils/logger.js";
import { data as ping } from "../commands/ping.js";
import { data as amikool } from "../commands/amikool.js";
import { data as plexprice } from "../commands/plexprice.js";
import { data as vctop } from "../commands/vctop.js";
import { data as vcstats } from "../commands/vcstats.js";
import { data as seen } from "../commands/seen.js";
import { data as transferOwnership } from "../commands/transfer-ownership.js";
import { data as announceVcStats } from "../commands/announce-vc-stats.js";
import { data as configCommand } from "../commands/config/index.js";
import { data as quoteCommand } from "../commands/quote.js";
import { data as botstatsCommand } from "../commands/botstats.js";
import { ConfigService } from "./config-service.js";
import { MonitoringService } from "./monitoring-service.js";

dotenvConfig();
const isDebug = process.env.DEBUG === "true";

export class CommandManager {
  private static instance: CommandManager;
  private client: Client;
  private configService: ConfigService;
  private commands: Collection<string, any>;

  private constructor(client: Client) {
    this.client = client;
    this.configService = ConfigService.getInstance();
    this.commands = new Collection();

    // No automatic reloads - users must manually trigger via /config reload
    // this.configService.registerReloadCallback(async () => {
    //   try {
    //     logger.info("🔄 Configuration change detected, reloading commands...");
    //     await this.registerCommands();
    //     await this.populateClientCommands();
    //     logger.info("✅ Commands reloaded after configuration change");
    //   } catch (error) {
    //     logger.error(
    //       "❌ Error reloading commands after configuration change:",
    //       error,
    //     );
    //   }
    // });
  }

  public static getInstance(client: Client): CommandManager {
    if (!CommandManager.instance) {
      CommandManager.instance = new CommandManager(client);
    }
    return CommandManager.instance;
  }

  async initialize() {
    try {
      // Load commands
      const commands = [];

      // Debug: Check the actual value of ping.enabled
      const pingEnabled = await this.configService.get("ping.enabled");
      logger.debug(
        `DEBUG: ping.enabled = ${pingEnabled} (type: ${typeof pingEnabled})`,
      );

      if (await this.configService.get("ping.enabled")) {
        commands.push(ping.toJSON());
        if (isDebug) logger.debug("✓ /ping command enabled");
      }

      if (await this.configService.get("amikool.enabled")) {
        commands.push(amikool.toJSON());
        if (isDebug) logger.debug("✓ /amikool command enabled");
      }

      if (await this.configService.get("plexprice.enabled")) {
        commands.push(plexprice.toJSON());
        if (isDebug) logger.debug("✓ /plexprice command enabled");
      }

      if (await this.configService.get("voicetracking.enabled")) {
        commands.push(vctop.toJSON());
        commands.push(vcstats.toJSON());
        if (isDebug) logger.debug("✓ Voice channel tracking commands enabled");
      }

      if (await this.configService.get("voicetracking.seen.enabled")) {
        commands.push(seen.toJSON());
        if (isDebug) logger.debug("✓ /seen command enabled");
      }

      if (await this.configService.get("voicechannels.enabled")) {
        commands.push(transferOwnership.toJSON());
        if (isDebug) logger.debug("✓ /transfer-ownership command enabled");
      }

      if (await this.configService.get("voicetracking.announcements.enabled")) {
        commands.push(announceVcStats.toJSON());
        if (isDebug) logger.debug("✓ /announce-vc-stats command enabled");
      }

      if (await this.configService.get("quotes.enabled")) {
        commands.push(quoteCommand.toJSON());
        if (isDebug) logger.debug("✓ /quote command enabled");
      }

      // Always add botstats command
      commands.push(botstatsCommand.toJSON());
      if (isDebug) logger.debug("✓ /botstats command enabled");

      logger.info(`Loaded ${commands.length} commands`);
      return commands;
    } catch (error) {
      logger.error("Error initializing CommandManager:", error);
      throw error;
    }
  }

  private async getEnabledCommands(): Promise<
    Array<{
      name: string;
      description: string;
      options?: Array<{
        name: string;
        description: string;
        type: number;
        required?: boolean;
      }>;
    }>
  > {
    const commands = [];

    if (isDebug) {
      logger.debug("Checking command registration status:");
    }

    const pingEnabled = await this.configService.get("ping.enabled");
    logger.debug(
      `🔍 DEBUG: ping.enabled = ${pingEnabled} (type: ${typeof pingEnabled})`,
    );

    if (pingEnabled) {
      commands.push(ping.toJSON());
      if (isDebug) logger.debug("✓ /ping command enabled");
    } else if (isDebug) {
      logger.debug("✗ /ping command disabled");
    }

    if (await this.configService.get("amikool.enabled")) {
      commands.push(amikool.toJSON());
      if (isDebug) logger.debug("✓ /amikool command enabled");
    } else if (isDebug) {
      logger.debug("✗ /amikool command disabled");
    }

    if (await this.configService.get("plexprice.enabled")) {
      commands.push(plexprice.toJSON());
      if (isDebug) logger.debug("✓ /plexprice command enabled");
    } else if (isDebug) {
      logger.debug("✗ /plexprice command disabled");
    }

    if (await this.configService.get("voicetracking.enabled")) {
      commands.push(vctop.toJSON());
      commands.push(vcstats.toJSON());
      if (isDebug) logger.debug("✓ /vctop and /vcstats commands enabled");
    } else if (isDebug) {
      logger.debug("✗ /vctop and /vcstats commands disabled");
    }

    if (await this.configService.get("voicetracking.seen.enabled")) {
      commands.push(seen.toJSON());
      if (isDebug) logger.debug("✓ /seen command enabled");
    } else if (isDebug) {
      logger.debug("✗ /seen command disabled");
    }

    if (await this.configService.get("voicechannels.enabled")) {
      commands.push(transferOwnership.toJSON());
      if (isDebug) logger.debug("✓ /transfer-ownership command enabled");
    } else if (isDebug) {
      logger.debug("✗ /transfer-ownership command disabled");
    }

    if (await this.configService.get("voicetracking.announcements.enabled")) {
      commands.push(announceVcStats.toJSON());
      if (isDebug) logger.debug("✓ /announce-vc-stats command enabled");
    } else if (isDebug) {
      logger.debug("✗ /announce-vc-stats command disabled");
    }

    if (await this.configService.get("quotes.enabled")) {
      commands.push(quoteCommand.toJSON());
      if (isDebug) logger.debug("✓ /quote command enabled");
    } else if (isDebug) {
      logger.debug("✗ /quote command disabled");
    }

    commands.push(configCommand.toJSON());
    if (isDebug) logger.debug("✓ /config command enabled (always)");

    // Always add botstats command
    commands.push(botstatsCommand.toJSON());
    if (isDebug) logger.debug("✓ /botstats command enabled (always)");

    if (isDebug) {
      logger.debug("Command registration summary:");
      logger.debug(`Total commands to register: ${commands.length}`);
      logger.debug("Commands to be registered:");
      commands.forEach((cmd) => {
        logger.debug(`- /${cmd.name}: ${cmd.description}`);
        if (cmd.options) {
          cmd.options.forEach((opt) => {
            logger.debug(
              `  └─ ${opt.name}${opt.required ? " (required)" : ""}: ${opt.description}`,
            );
          });
        }
      });
    }

    return commands;
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
      } catch (error: any) {
        const isRateLimit =
          error.code === 429 || error.message?.includes("rate limit");
        const isTimeout = error.message?.includes("timeout");

        if (isRateLimit) {
          const retryAfter = error.retry_after || 5;
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
          logger.error(`❌ Discord API error for ${operationName}:`, error);
          throw error;
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

      // Import command handlers
      const { execute: ping } = await import("../commands/ping.js");
      const { execute: amikool } = await import("../commands/amikool.js");
      const { execute: plexprice } = await import("../commands/plexprice.js");
      const { execute: vctop } = await import("../commands/vctop.js");
      const { execute: vcstats } = await import("../commands/vcstats.js");
      const { execute: seen } = await import("../commands/seen.js");
      const { execute: transferOwnership } = await import(
        "../commands/transfer-ownership.js"
      );
      const { execute: announceVcStats } = await import(
        "../commands/announce-vc-stats.js"
      );
      const { execute: configCommand } = await import(
        "../commands/config/index.js"
      );
      const { execute: quoteCommand } = await import("../commands/quote.js");
      const { execute: excludeChannel } = await import(
        "../commands/exclude-channel.js"
      );
      const { command: setupLobbyCommand } = await import(
        "../commands/setup-lobby.js"
      );
      const { execute: botstatsCommand } = await import(
        "../commands/botstats.js"
      );

      // Clear existing commands
      this.client.commands.clear();

      // Add commands based on configuration
      if (await this.configService.get("ping.enabled")) {
        this.client.commands.set("ping", { execute: ping });
      }

      if (await this.configService.get("amikool.enabled")) {
        this.client.commands.set("amikool", { execute: amikool });
      }

      if (await this.configService.get("plexprice.enabled")) {
        this.client.commands.set("plexprice", { execute: plexprice });
      }

      if (await this.configService.get("voicetracking.enabled")) {
        this.client.commands.set("vctop", { execute: vctop });
        this.client.commands.set("vcstats", { execute: vcstats });
      }

      if (await this.configService.get("voicetracking.seen.enabled")) {
        this.client.commands.set("seen", { execute: seen });
      }

      if (await this.configService.get("voicechannels.enabled")) {
        this.client.commands.set("transfer-ownership", {
          execute: transferOwnership,
        });
      }

      if (await this.configService.get("voicetracking.announcements.enabled")) {
        this.client.commands.set("announce-vc-stats", {
          execute: announceVcStats,
        });
      }

      if (await this.configService.get("quotes.enabled")) {
        this.client.commands.set("quote", { execute: quoteCommand });
      }

      // Always add config command
      this.client.commands.set("config", { execute: configCommand });

      // Always add exclude-channel command
      this.client.commands.set("exclude-channel", { execute: excludeChannel });

      // Always add setup-lobby command
      this.client.commands.set("setup-lobby", {
        execute: setupLobbyCommand.execute,
      });

      // Always add botstats command
      this.client.commands.set("botstats", { execute: botstatsCommand });

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
   * Execute a command with monitoring
   */
  public async executeCommand(
    commandName: string,
    executeFunction: () => Promise<void>,
  ): Promise<void> {
    const monitoringService = MonitoringService.getInstance();
    const startTime = Date.now();
    const trackingId = monitoringService.trackCommandStart(commandName);

    try {
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
