import { CommandInteraction } from 'discord.js';
import { Logger } from '../utils/logger';

const logger = Logger.getInstance();

export async function handleCommands(interaction: CommandInteraction): Promise<void> {
  if (!interaction.isCommand()) return;

  logger.debug(`Received command: ${interaction.commandName}`);

  try {
    switch (interaction.commandName) {
      case 'ping':
        await interaction.reply('Pong!');
        break;
      case 'amikool':
        await interaction.reply('Yes, you are kool!');
        break;
      default:
        logger.error(`Unknown command: ${interaction.commandName}`);
        await interaction.reply({ content: 'Unknown command', ephemeral: true });
    }
  } catch (error) {
    logger.error('Error handling command:', error);
    await interaction.reply({ content: 'There was an error executing this command.', ephemeral: true });
  }
}
