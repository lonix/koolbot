import { CommandInteraction } from 'discord.js';
import { Logger } from '../utils/logger';
import { handlePing } from './ping';
import { handlePlexPrice } from './plexprice';
import { handleAmIKool } from './amikool';

const logger = Logger.getInstance();

export async function handleCommands(interaction: CommandInteraction) {
  const { commandName } = interaction;
  logger.info(`Command received: ${commandName} from ${interaction.user.tag}`);

  switch (commandName) {
    case 'ping':
      await handlePing(interaction);
      break;
    case 'plexprice':
      await handlePlexPrice(interaction);
      break;
    case 'amikool':
      await handleAmIKool(interaction);
      break;
    default:
      logger.error(`Unknown command: ${commandName}`);
      await interaction.reply({ content: 'Unknown command!', ephemeral: true });
  }
}
