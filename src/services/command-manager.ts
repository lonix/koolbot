import { REST, Routes } from "discord.js";
import { config } from "dotenv";
import { Logger } from "../utils/logger";
import { data as pingCommand } from "../commands/ping";
import { data as amikoolCommand } from "../commands/amikool";
import { data as plexpriceCommand } from "../commands/plexprice";
import { data as vctopCommand } from "../commands/vctop";
import { data as vcstatsCommand } from "../commands/vcstats";
import { data as seenCommand } from "../commands/seen";

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
      commands.push(pingCommand.toJSON());
    }

    if (process.env.ENABLE_AMIKOOL === "true") {
      commands.push(amikoolCommand.toJSON());
    }

    if (process.env.ENABLE_PLEXPRICE === "true") {
      commands.push(plexpriceCommand.toJSON());
    }

    if (process.env.ENABLE_VC_TRACKING === "true") {
      commands.push(vctopCommand.toJSON());
      commands.push(vcstatsCommand.toJSON());
    }

    if (process.env.ENABLE_SEEN === "true") {
      commands.push(seenCommand.toJSON());
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
