import { REST, Routes } from "discord.js";
import { env, requireEnv } from "./config/env.js";
import logger from "./utils/logger.js";

const rest = new REST({ version: "10" }).setToken(requireEnv("DISCORD_TOKEN"));

interface DiscordCommand {
  id: string;
  name: string;
  description: string;
}

async function unregisterGuildCommands(): Promise<void> {
  const guildId = env.guildId;
  if (!guildId) {
    logger.error("GUILD_ID environment variable is not set");
    process.exit(1);
  }
  const clientId = requireEnv("CLIENT_ID");

  try {
    logger.info(`Starting to unregister commands for guild ${guildId}...`);

    // Get all commands for the guild
    const commands = (await rest.get(
      Routes.applicationGuildCommands(clientId, guildId),
    )) as DiscordCommand[];

    logger.info(`Found ${commands.length} commands to unregister`);

    // Delete each command
    for (const command of commands) {
      await rest.delete(
        Routes.applicationGuildCommand(clientId, guildId, command.id),
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
