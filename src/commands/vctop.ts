import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import {
  VoiceChannelTracker,
  TimePeriod,
} from "../services/voice-channel-tracker.js";
import logger from "../utils/logger.js";

export const data = new SlashCommandBuilder()
  .setName("vctop")
  .setDescription("Show top voice channel users")
  .addIntegerOption((option) =>
    option
      .setName("limit")
      .setDescription("Number of users to show")
      .setRequired(false)
      .setMinValue(1)
      .setMaxValue(50),
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
    const limit = interaction.options.getInteger("limit") || 10;
    const period = (interaction.options.getString("period") ||
      "week") as TimePeriod;
    const tracker = VoiceChannelTracker.getInstance(interaction.client);
    const topUsers = await tracker.getTopUsers(limit, period);

    if (!topUsers || topUsers.length === 0) {
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

    const response = topUsers
      .map((user, index) => {
        const rank = index + 1;
        const medal =
          rank === 1
            ? "🥇"
            : rank === 2
              ? "🥈"
              : rank === 3
                ? "🥉"
                : `${rank}.`;
        return `${medal} ${user.username}: ${formatTime(user.totalTime)}`;
      })
      .join("\n");

    await interaction.reply(
      `Top Voice Channel Users (${period}):\n${response}`,
    );
  } catch (error) {
    logger.error("Error in vctop command:", error);
    await interaction.reply({
      content: "There was an error while executing this command!",
      ephemeral: true,
    });
  }
}
