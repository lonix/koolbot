import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import {
  VoiceChannelTracker,
  TimePeriod,
} from "../services/voice-channel-tracker.js";
import logger from "../utils/logger.js";

export const data = new SlashCommandBuilder()
  .setName("vcstats")
  .setDescription("Show voice channel statistics for a user")
  .addUserOption((option) =>
    option
      .setName("user")
      .setDescription("The user to show statistics for")
      .setRequired(false),
  )
  .addStringOption((option) =>
    option
      .setName("period")
      .setDescription("Time period to show stats for")
      .setRequired(false)
      .addChoices(
        { name: "This Week", value: "week" },
        { name: "This Month", value: "month" },
        { name: "All Time", value: "alltime" },
      ),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    const user = interaction.options.getUser("user") || interaction.user;
    const period = (interaction.options.getString("period") ||
      "week") as TimePeriod;
    const tracker = VoiceChannelTracker.getInstance(interaction.client);
    const stats = await tracker.getUserStats(user.id, period);

    if (!stats) {
      await interaction.reply(
        "No voice channel activity found for the selected period.",
      );
      return;
    }

    const formatTime = (minutes: number): string => {
      const hours = Math.floor(minutes / 60);
      const remainingMinutes = minutes % 60;
      return `${hours}h ${remainingMinutes}m`;
    };

    const response = [
      `**Voice Channel Statistics for ${user.username} (${period})**`,
      `Total Time: ${formatTime(stats.totalTime)}`,
      `Last Seen: ${stats.lastSeen.toLocaleString()}`,
      "",
      "**Recent Sessions:**",
      ...stats.sessions.slice(0, 5).map((session) => {
        const duration = session.duration
          ? formatTime(session.duration)
          : "ongoing";
        return `• ${session.channelName}: ${duration}`;
      }),
    ].join("\n");

    await interaction.reply(response);
  } catch (error) {
    logger.error("Error in vcstats command:", error);
    await interaction.reply({
      content: "There was an error while executing this command!",
      ephemeral: true,
    });
  }
}
