import { REST, Routes } from "discord.js";
import { config } from "dotenv";
import Logger from "../utils/logger.js";
import { data as ping } from "../commands/ping.js";
import { data as amikool } from "../commands/amikool.js";
import { data as plexprice } from "../commands/plexprice.js";
import { data as vctop } from "../commands/vctop.js";
import { data as vcstats } from "../commands/vcstats.js";
import { data as seen } from "../commands/seen.js";
import { data as requestOwnership } from "../commands/request-ownership.js";
import { data as transferOwnership } from "../commands/transfer-ownership.js";

config();
const logger = Logger.getInstance();

export class CommandManager {
  private static instance: CommandManager;
  private rest: REST;

  private constructor() {
    this.rest = new REST({ version: "10" }).setToken(
      process.env.DISCORD_TOKEN!,
    );
  }

  public static getInstance(): CommandManager {
    if (!CommandManager.instance) {
      CommandManager.instance = new CommandManager();
    }
    return CommandManager.instance;
  }

  private getEnabledCommands(): Array<{
    name: string;
    description: string;
    options?: Array<{
      name: string;
      description: string;
      type: number;
      required?: boolean;
    }>;
  }> {
    const commands = [];

    if (process.env.ENABLE_PING === "true") {
      commands.push(ping.toJSON());
    }

    if (process.env.ENABLE_AMIKOOL === "true") {
      commands.push(amikool.toJSON());
    }

    if (process.env.ENABLE_PLEXPRICE === "true") {
      commands.push(plexprice.toJSON());
    }

    if (process.env.ENABLE_VC_TRACKING === "true") {
      commands.push(vctop.toJSON());
      commands.push(vcstats.toJSON());
    }

    if (process.env.ENABLE_SEEN === "true") {
      commands.push(seen.toJSON());
    }

    if (process.env.ENABLE_VC_MANAGEMENT === "true") {
      commands.push(requestOwnership.toJSON());
      commands.push(transferOwnership.toJSON());
    }

    return commands;
  }

  public async unregisterAllCommands(): Promise<void> {
    try {
      logger.info("Starting command cleanup...");

      // Unregister global commands
      logger.info("Removing global commands...");
      await this.rest.put(Routes.applicationCommands(process.env.CLIENT_ID!), {
        body: [],
      });

      // Unregister guild commands
      if (process.env.GUILD_ID) {
        logger.info("Removing guild commands...");
        await this.rest.put(
          Routes.applicationGuildCommands(
            process.env.CLIENT_ID!,
            process.env.GUILD_ID,
          ),
          { body: [] },
        );
      }

      logger.info("Successfully removed all commands");
    } catch (error) {
      logger.error("Error during command cleanup:", error);
      throw error;
    }
  }

  public async registerCommands(): Promise<void> {
    try {
      logger.info("Starting command registration...");
      const commands = this.getEnabledCommands();

      if (commands.length === 0) {
        logger.info("No commands to register (all features disabled)");
        return;
      }

      // Register global commands
      logger.info("Registering global commands...");
      await this.rest.put(Routes.applicationCommands(process.env.CLIENT_ID!), {
        body: commands,
      });

      // Register guild commands
      if (process.env.GUILD_ID) {
        logger.info("Registering guild commands...");
        await this.rest.put(
          Routes.applicationGuildCommands(
            process.env.CLIENT_ID!,
            process.env.GUILD_ID,
          ),
          { body: commands },
        );
      }

      logger.info(`Successfully registered ${commands.length} commands`);
    } catch (error) {
      logger.error("Error during command registration:", error);
      throw error;
    }
  }
}
