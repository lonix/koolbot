import {
  CommandInteraction,
  SlashCommandBuilder,
  SlashCommandUserOption,
  SlashCommandStringOption,
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
  )
  .addStringOption((option: SlashCommandStringOption) =>
    option
      .setName("period")
      .setDescription("Time period to show statistics for")
      .setRequired(false)
      .addChoices(
        { name: "Last Week", value: "week" },
        { name: "Last Month", value: "month" },
        { name: "All Time", value: "alltime" },
      ),
  );

export async function execute(interaction: CommandInteraction): Promise<void> {
  try {
    logger.info(`Executing vcstats command for user ${interaction.user.tag}`);

    const targetUser =
      interaction.options.get("user")?.user || interaction.user;
    const period = (interaction.options.get("period")?.value as TimePeriod) || "alltime";
    const tracker = VoiceChannelTracker.getInstance();
    const stats = await tracker.getUserStats(targetUser.id, period);

    if (!stats) {
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

    const periodTitle = period === "week" ? "Last Week" : period === "month" ? "Last Month" : "All Time";

    const response = [
      `**${periodTitle} Voice Channel Statistics for ${targetUser.username}**`,
      "```",
      `Total Time: ${formatTime(stats.totalTime)}`,
      `Last Seen: ${stats.lastSeen ? formatDate(stats.lastSeen) : "Never"}`,
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
