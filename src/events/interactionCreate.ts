import { Interaction } from 'discord.js';
import { logger } from '../utils/logger';

export async function handleInteractionCreate(interaction: Interaction) {
  try {
    if (!interaction.isCommand()) return;

    if (process.env.DEBUG === 'true') {
      logger.debug(`Command received: ${interaction.commandName} from ${interaction.user.tag}`);
    }

    const command = interaction.client.commands.get(interaction.commandName);
    if (!command) {
      logger.warn(`Command ${interaction.commandName} not found`);
      return;
    }

    await command.execute(interaction);
  } catch (error) {
    logger.error('Error handling interaction:', error);
    if (interaction.isRepliable()) {
      await interaction.reply({ content: 'There was an error executing this command!', ephemeral: true });
    }
  }
}
