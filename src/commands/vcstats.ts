import { CommandInteraction, SlashCommandBuilder, User, SlashCommandUserOption } from 'discord.js';
import { Logger } from '../utils/logger';
import { VoiceChannelTracker } from '../services/voice-channel-tracker';

const logger = Logger.getInstance();

export const data = new SlashCommandBuilder()
  .setName('vcstats')
  .setDescription('Show voice channel statistics for a user')
  .addUserOption((option: SlashCommandUserOption) =>
    option.setName('user')
      .setDescription('The user to check (defaults to yourself)')
      .setRequired(false)
  );

export async function execute(interaction: CommandInteraction) {
  try {
    logger.info(`Executing vcstats command for user ${interaction.user.tag}`);
    
    const targetUser = interaction.options.get('user')?.user || interaction.user;
    const tracker = VoiceChannelTracker.getInstance();
    const stats = await tracker.getUserStats(targetUser.id);

    if (!stats) {
      await interaction.reply(`No voice channel statistics available for ${targetUser.username}.`);
      return;
    }

    const formatTime = (seconds: number): string => {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      return `${hours}h ${minutes}m`;
    };

    const formatDate = (date: Date): string => {
      return date.toLocaleString();
    };

    const response = [
      `**Voice Channel Statistics for ${targetUser.username}**`,
      `\`\`\``,
      `Total Time: ${formatTime(stats.totalTime)}`,
      `Last Seen: ${stats.lastSeen ? formatDate(stats.lastSeen) : 'Never'}`,
      `\`\`\``
    ].join('\n');

    await interaction.reply(response);
    logger.info(`Vcstats command completed for user ${interaction.user.tag}`);
  } catch (error) {
    logger.error('Error executing vcstats command:', error);
    await interaction.reply({ content: 'An error occurred while fetching statistics.', ephemeral: true });
  }
} 