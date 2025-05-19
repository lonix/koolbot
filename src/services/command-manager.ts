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

    if (await configService.get("ENABLE_PING")) {
      commands.push(ping.toJSON());
    }

    if (await configService.get("ENABLE_AMIKOOL")) {
      commands.push(amikool.toJSON());
    }

    if (await configService.get("ENABLE_PLEX_PRICE")) {
      commands.push(plexprice.toJSON());
    }

    if (await configService.get("ENABLE_VC_TRACKING")) {
      commands.push(vctop.toJSON());
      commands.push(vcstats.toJSON());
    }

    if (await configService.get("ENABLE_SEEN")) {
      commands.push(seen.toJSON());
    }

    if (await configService.get("ENABLE_VC_MANAGEMENT")) {
      commands.push(transferOwnership.toJSON());
    }

    if (await configService.get("ENABLE_VC_WEEKLY_ANNOUNCEMENT")) {
      commands.push(announceVcStats.toJSON());
    }

    if (await configService.get("quotes.enabled")) {
      commands.push(quoteCommand.toJSON());
    }

    commands.push(configCommand.toJSON());

    return commands;
  }

  public async registerCommands(): Promise<void> {
    if (!this.client) {
      throw new Error("Client not set");
    }

    try {
      const commands = await this.getEnabledCommands();
      const rest = new REST({ version: "10" }).setToken(
        process.env.DISCORD_TOKEN!,
      );

      // First, unregister any existing guild commands
      if (process.env.GUILD_ID) {
        logger.info("Cleaning up any existing guild commands...");
        await rest.put(
          Routes.applicationGuildCommands(
            process.env.CLIENT_ID!,
            process.env.GUILD_ID,
          ),
          { body: [] },
        );
        logger.info("Successfully cleaned up guild commands");
      }

      // Then register global commands
      logger.info("Registering global commands...");
      await rest.put(Routes.applicationCommands(process.env.CLIENT_ID!), {
        body: commands,
      });
      logger.info("Successfully registered global commands");
    } catch (error) {
      logger.error("Error registering commands:", error);
      throw error;
    }
  }

  public async unregisterAllCommands(): Promise<void> {
    if (!this.client) {
      throw new Error("Client not set");
    }

    try {
      const rest = new REST({ version: "10" }).setToken(
        process.env.DISCORD_TOKEN!,
      );

      logger.info("Unregistering all commands...");

      // Unregister global commands
      await rest.put(Routes.applicationCommands(process.env.CLIENT_ID!), {
        body: [],
      });
      logger.info("Successfully unregistered global commands");

      // Unregister guild commands if GUILD_ID is set
      if (process.env.GUILD_ID) {
        await rest.put(
          Routes.applicationGuildCommands(
            process.env.CLIENT_ID!,
            process.env.GUILD_ID,
          ),
          { body: [] },
        );
        logger.info("Successfully unregistered guild commands");
      }
    } catch (error) {
      logger.error("Error unregistering commands:", error);
      throw error;
    }
  }
}
