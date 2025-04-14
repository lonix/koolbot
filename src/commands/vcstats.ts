import {
  CommandInteraction,
  SlashCommandBuilder,
  SlashCommandUserOption,
  PermissionsBitField,
} from "discord.js";
import Logger from "../utils/logger.js";
import { VoiceChannelTracker, TimePeriod } from "../services/voice-channel-tracker.js";

const logger = Logger.getInstance();

export const data = new SlashCommandBuilder()
  .setName("vcstats")
  .setDescription("Show voice channel statistics for a user")
  .addUserOption((option: SlashCommandUserOption) =>
    option
      .setName("user")
      .setDescription("The user to check (defaults to yourself)")
      .setRequired(false),
  );

export async function execute(interaction: CommandInteraction): Promise<void> {
  try {
    logger.info(`Executing vcstats command for user ${interaction.user.tag}`);

    const targetUser = interaction.options.get("user")?.user;
    
    // Check if user is trying to view someone else's stats
    if (targetUser && targetUser.id !== interaction.user.id) {
      // Check if user has permission to view others' stats
      const member = interaction.member;
      if (!member) {
        await interaction.reply({
          content: "You don't have permission to view other users' statistics.",
          ephemeral: true,
        });
        return;
      }

      // Check if user has admin or moderator role
      const hasPermission = member.permissions instanceof PermissionsBitField && 
                          (member.permissions.has(PermissionsBitField.Flags.Administrator) || 
                           member.permissions.has(PermissionsBitField.Flags.ModerateMembers));
      
      if (!hasPermission) {
        await interaction.reply({
          content: "You don't have permission to view other users' statistics.",
          ephemeral: true,
        });
        return;
      }
    }

    const finalTargetUser = targetUser || interaction.user;
    const tracker = VoiceChannelTracker.getInstance();

    // Get stats for all time periods
    const [weekStats, monthStats, allTimeStats] = await Promise.all([
      tracker.getUserStats(finalTargetUser.id, "week"),
      tracker.getUserStats(finalTargetUser.id, "month"),
      tracker.getUserStats(finalTargetUser.id, "alltime"),
    ]);

    if (!allTimeStats) {
      await interaction.reply(
        `No voice channel statistics available for ${finalTargetUser.username}.`,
      );
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
      `**Voice Channel Statistics for ${finalTargetUser.username}**`,
      "```",
      `Last week: ${weekStats ? formatTime(weekStats.totalTime) : "0h 0m"}`,
      `Last 30days: ${monthStats ? formatTime(monthStats.totalTime) : "0h 0m"}`,
      `All time: ${formatTime(allTimeStats.totalTime)}`,
      "",
      `Last seen: ${allTimeStats.lastSeen ? formatDate(allTimeStats.lastSeen) : "Never"}`,
      "```",
    ].join("\n");

    await interaction.reply(response);
    logger.info(`Vcstats command completed for user ${interaction.user.tag}`);
  } catch (error) {
    logger.error("Error executing vcstats command:", error);
    await interaction.reply({
      content: "An error occurred while fetching statistics.",
      ephemeral: true,
    });
  }
}
