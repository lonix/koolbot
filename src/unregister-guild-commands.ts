import { REST, Routes } from "discord.js";
import { config } from "dotenv";
import { Logger } from "./utils/logger";

config();
const logger = Logger.getInstance();

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN!);

interface DiscordCommand {
  id: string;
  name: string;
  description: string;
}

async function unregisterGuildCommands(): Promise<void> {
  if (!process.env.GUILD_ID) {
    logger.error("GUILD_ID environment variable is not set");
    process.exit(1);
  }

  try {
    logger.info(
      `Starting to unregister commands for guild ${process.env.GUILD_ID}...`,
    );

    // Get all commands for the guild
    const commands = (await rest.get(
      Routes.applicationGuildCommands(
        process.env.CLIENT_ID!,
        process.env.GUILD_ID,
      ),
    )) as DiscordCommand[];

    logger.info(`Found ${commands.length} commands to unregister`);

    // Delete each command
    for (const command of commands) {
      await rest.delete(
        Routes.applicationGuildCommand(
          process.env.CLIENT_ID!,
          process.env.GUILD_ID,
          command.id,
        ),
      );
      logger.info(`Unregistered command: ${command.name}`);
    }

    logger.info("Successfully unregistered all guild commands");
  } catch (error) {
    logger.error("Error unregistering guild commands:", error);
    process.exit(1);
  }
}

unregisterGuildCommands();
