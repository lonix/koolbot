import { CommandInteraction, SlashCommandBuilder } from 'discord.js';
import { Logger } from '../utils/logger';

const logger = Logger.getInstance();

export const data = new SlashCommandBuilder()
  .setName('amikool')
  .setDescription('Check if you are kool!');

export async function execute(interaction: CommandInteraction): Promise<void> {
  try {
    logger.debug('AmIKool command executed');

    if (!interaction.member || !interaction.guild) {
      throw new Error('Interaction missing member or guild information');
    }

    const coolRoleName = process.env.COOL_ROLE_NAME || 'Verifyed Kool Kid';
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const hasCoolRole = member.roles.cache.some((role) => role.name === coolRoleName);

    const response = hasCoolRole
      ? 'Yes, you are kool! 😎'
      : 'No, you are not kool... yet! 😢';

    await interaction.reply(response);
  } catch (error) {
    logger.error('Error checking cool status:', error);
    await interaction.reply({ content: 'Failed to check your cool status. Please try again later.', ephemeral: true });
  }
}
