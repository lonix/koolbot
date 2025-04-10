import { CommandInteraction } from 'discord.js';
import { Logger } from '../utils/logger';

const logger = Logger.getInstance();

export async function handleAmIKool(interaction: CommandInteraction) {
  try {
    logger.debug('AmIKool command executed');

    if (!interaction.member || !interaction.guild) {
      throw new Error('Interaction missing member or guild information');
    }

    const coolRoleName = process.env.COOL_ROLE_NAME || 'Verifyed Kool Kid';
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const hasCoolRole = member.roles.cache.some(role => role.name === coolRoleName);

    const response = hasCoolRole
      ? 'Yes, you are kool! 😎'
      : 'No, you are not kool... yet! 😢';

    await interaction.reply(response);
  } catch (error) {
    logger.error('Error checking cool status:', error);
    await interaction.reply({ content: 'Failed to check your cool status. Please try again later.', ephemeral: true });
  }
}
