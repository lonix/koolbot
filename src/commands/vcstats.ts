import {
  CommandInteraction,
  SlashCommandBuilder,
  SlashCommandUserOption,
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

    const targetUser =
      interaction.options.get("user")?.user || interaction.user;
    const tracker = VoiceChannelTracker.getInstance();

    // Get stats for all time periods
    const [weekStats, monthStats, allTimeStats] = await Promise.all([
      tracker.getUserStats(targetUser.id, "week"),
      tracker.getUserStats(targetUser.id, "month"),
      tracker.getUserStats(targetUser.id, "alltime"),
    ]);

    if (!allTimeStats) {
      await interaction.reply(
        `No voice channel statistics available for ${targetUser.username}.`,
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
      `**Voice Channel Statistics for ${targetUser.username}**`,
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
