import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import {
  VoiceChannelTracker,
  TimePeriod,
} from "../services/voice-channel-tracker.js";
import { ConfigService } from "../services/config-service.js";
import logger from "../utils/logger.js";

// Helper function to format time in hours and minutes
function formatTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const remainingMinutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${remainingMinutes}m`;
}

export const data = new SlashCommandBuilder()
  .setName("voicestats")
  .setDescription("Voice channel statistics and leaderboards")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("top")
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
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("user")
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
      ),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "top") {
    await executeTop(interaction);
  } else if (subcommand === "user") {
    await executeUser(interaction);
  }
}

async function executeTop(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    const configService = ConfigService.getInstance();
    const topEnabled = await configService.getBoolean(
      "voicetracking.stats.top.enabled",
      false,
    );

    if (!topEnabled) {
      await interaction.reply({
        content:
          "The voice statistics leaderboard feature is currently disabled.",
        ephemeral: true,
      });
      return;
    }

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
    logger.error("Error in voicestats top command:", error);

    // Check if interaction was already replied to
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({
        content: "There was an error while executing this command!",
        ephemeral: true,
      });
    } else {
      await interaction.reply({
        content: "There was an error while executing this command!",
        ephemeral: true,
      });
    }
  }
}

async function executeUser(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    const configService = ConfigService.getInstance();
    const userEnabled = await configService.getBoolean(
      "voicetracking.stats.user.enabled",
      false,
    );

    if (!userEnabled) {
      await interaction.reply({
        content: "The voice statistics feature is currently disabled.",
        ephemeral: true,
      });
      return;
    }

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
    logger.error("Error in voicestats user command:", error);

    // Check if interaction was already replied to
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({
        content: "There was an error while executing this command!",
        ephemeral: true,
      });
    } else {
      await interaction.reply({
        content: "There was an error while executing this command!",
        ephemeral: true,
      });
    }
  }
}
