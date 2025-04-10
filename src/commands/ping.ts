import { CommandInteraction } from 'discord.js';
import { Logger } from '../utils/logger';

const logger = Logger.getInstance();

export async function handlePing(interaction: CommandInteraction): Promise<void> {
  try {
    logger.debug('Ping command executed');
    await interaction.reply('Pong!');
  } catch (error) {
    logger.error('Error in Ping command:', error);
    await interaction.reply({ content: 'There was an error executing this command.', ephemeral: true });
  }
}
