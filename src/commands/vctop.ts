import { CommandInteraction, SlashCommandBuilder, SlashCommandIntegerOption } from 'discord.js';
import { Logger } from '../utils/logger';
import { VoiceChannelTracker } from '../services/voice-channel-tracker';

const logger = Logger.getInstance();

export const data = new SlashCommandBuilder()
  .setName('vctop')
  .setDescription('Show all-time voice channel rankings')
  .addIntegerOption((option: SlashCommandIntegerOption) =>
    option.setName('limit')
      .setDescription('Number of users to show (default: 10)')
      .setRequired(false)
      .setMinValue(1)
      .setMaxValue(25)
  );

export async function execute(interaction: CommandInteraction): Promise<void> {
  try {
    logger.info(`Executing vctop command for user ${interaction.user.tag}`);
    
    const limit = interaction.options.get('limit')?.value as number || 10;
    const tracker = VoiceChannelTracker.getInstance();
    const topUsers = await tracker.getTopUsers(limit);

    if (topUsers.length === 0) {
      await interaction.reply('No voice channel statistics available yet.');
      return;
    }

    const formatTime = (seconds: number): string => {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      return `${hours}h ${minutes}m`;
    };

    const response = [
      '**All-Time Voice Channel Rankings**',
      '```',
      ...topUsers.map((user, index) => {
        const rank = index + 1;
        const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${rank}.`;
        return `${medal} ${user.username}: ${formatTime(user.totalTime)}`;
      }),
      '```'
    ].join('\n');

    await interaction.reply(response);
    logger.info(`Vctop command completed for user ${interaction.user.tag}`);
  } catch (error) {
    logger.error('Error executing vctop command:', error);
    await interaction.reply({ content: 'An error occurred while fetching rankings.', ephemeral: true });
  }
} 