import { CommandInteraction } from 'discord.js';
import { Logger } from '../utils/logger';

const logger = Logger.getInstance();

export async function handlePing(interaction: CommandInteraction) {
  logger.debug('Ping command executed');
  await interaction.reply('Pong!');
}
