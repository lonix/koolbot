import { Client, REST, Routes } from 'discord.js';
import { logger } from '../utils/logger';
import { Command } from '../types/command';

export async function handleReady(client: Client) {
  try {
    logger.info(`Logged in as ${client.user?.tag}`);

    // Register commands
    const commands = Array.from(client.commands.values()).map((cmd: Command) => cmd.data.toJSON());
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN!);

    try {
      logger.info('Started refreshing application (/) commands.');

      const data = await rest.put(
        Routes.applicationCommands(process.env.CLIENT_ID!),
        { body: commands },
      ) as any[];

      logger.info(`Successfully reloaded ${data.length} application (/) commands.`);
    } catch (error) {
      logger.error('Error refreshing application commands:', error);
    }
  } catch (error) {
    logger.error('Error in ready event:', error);
  }
}
