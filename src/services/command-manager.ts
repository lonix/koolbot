import { REST, Routes, Client } from "discord.js";
import { config as dotenvConfig } from "dotenv";
import Logger from "../utils/logger.js";
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
import { ConfigService } from "./config-service.js";

dotenvConfig();
const logger = Logger.getInstance();
const configService = ConfigService.getInstance();
const isDebug = process.env.DEBUG === "true";

export class CommandManager {
  private static instance: CommandManager;
  private client: Client | null = null;

  private constructor() {}

  public static getInstance(): CommandManager {
    if (!CommandManager.instance) {
      CommandManager.instance = new CommandManager();
    }
    return CommandManager.instance;
  }

  public setClient(client: Client): void {
    this.client = client;
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

    if (await configService.get("ENABLE_PING")) {
      commands.push(ping.toJSON());
      if (isDebug) logger.debug("✓ /ping command enabled");
    } else if (isDebug) {
      logger.debug("✗ /ping command disabled");
    }

    if (await configService.get("ENABLE_AMIKOOL")) {
      commands.push(amikool.toJSON());
      if (isDebug) logger.debug("✓ /amikool command enabled");
    } else if (isDebug) {
      logger.debug("✗ /amikool command disabled");
    }

    if (await configService.get("ENABLE_PLEX_PRICE")) {
      commands.push(plexprice.toJSON());
      if (isDebug) logger.debug("✓ /plexprice command enabled");
    } else if (isDebug) {
      logger.debug("✗ /plexprice command disabled");
    }

    if (await configService.get("ENABLE_VC_TRACKING")) {
      commands.push(vctop.toJSON());
      commands.push(vcstats.toJSON());
      if (isDebug) logger.debug("✓ /vctop and /vcstats commands enabled");
    } else if (isDebug) {
      logger.debug("✗ /vctop and /vcstats commands disabled");
    }

    if (await configService.get("ENABLE_SEEN")) {
      commands.push(seen.toJSON());
      if (isDebug) logger.debug("✓ /seen command enabled");
    } else if (isDebug) {
      logger.debug("✗ /seen command disabled");
    }

    if (await configService.get("ENABLE_VC_MANAGEMENT")) {
      commands.push(transferOwnership.toJSON());
      if (isDebug) logger.debug("✓ /transfer-ownership command enabled");
    } else if (isDebug) {
      logger.debug("✗ /transfer-ownership command disabled");
    }

    if (await configService.get("ENABLE_VC_WEEKLY_ANNOUNCEMENT")) {
      commands.push(announceVcStats.toJSON());
      if (isDebug) logger.debug("✓ /announce-vc-stats command enabled");
    } else if (isDebug) {
      logger.debug("✗ /announce-vc-stats command disabled");
    }

    if (await configService.get("quotes.enabled")) {
      commands.push(quoteCommand.toJSON());
      if (isDebug) logger.debug("✓ /quote command enabled");
    } else if (isDebug) {
      logger.debug("✗ /quote command disabled");
    }

    commands.push(configCommand.toJSON());
    if (isDebug) logger.debug("✓ /config command enabled (always)");

    if (isDebug) {
      logger.debug("Command registration summary:");
      logger.debug(`Total commands to register: ${commands.length}`);
      logger.debug("Commands to be registered:");
      commands.forEach(cmd => {
        logger.debug(`- /${cmd.name}: ${cmd.description}`);
        if (cmd.options) {
          cmd.options.forEach(opt => {
            logger.debug(`  └─ ${opt.name}${opt.required ? ' (required)' : ''}: ${opt.description}`);
          });
        }
      });
    }

    return commands;
  }

  public async registerCommands(): Promise<void> {
    if (!this.client) {
      throw new Error("Client not set");
    }

    if (!process.env.GUILD_ID) {
      throw new Error("GUILD_ID is required for guild command registration");
    }

    try {
      const commands = await this.getEnabledCommands();
      const rest = new REST({ version: "10" }).setToken(
        process.env.DISCORD_TOKEN!,
      );

      // Register guild commands
      logger.info("Registering guild commands...");
      if (isDebug) {
        logger.debug(`Attempting to register ${commands.length} commands with Discord API for guild ${process.env.GUILD_ID}...`);
      }

      const response = await rest.put(
        Routes.applicationGuildCommands(
          process.env.CLIENT_ID!,
          process.env.GUILD_ID,
        ),
        { body: commands },
      );

      if (isDebug) {
        logger.debug("Discord API response:", response);
      }

      logger.info("Successfully registered guild commands");
    } catch (error) {
      logger.error("Error registering commands:", error);
      throw error;
    }
  }

  public async unregisterAllCommands(): Promise<void> {
    if (!this.client) {
      throw new Error("Client not set");
    }

    if (!process.env.GUILD_ID) {
      throw new Error("GUILD_ID is required for guild command registration");
    }

    try {
      const rest = new REST({ version: "10" }).setToken(
        process.env.DISCORD_TOKEN!,
      );

      logger.info("Unregistering all guild commands...");

      await rest.put(
        Routes.applicationGuildCommands(
          process.env.CLIENT_ID!,
          process.env.GUILD_ID,
        ),
        { body: [] },
      );
      logger.info("Successfully unregistered guild commands");
    } catch (error) {
      logger.error("Error unregistering commands:", error);
      throw error;
    }
  }
}
