import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { VoiceChannelTracker } from "../services/voice-channel-tracker.js";
import { formatTimeAgo } from "../utils/time.js";
import logger from "../utils/logger.js";

export const data = new SlashCommandBuilder()
  .setName("seen")
  .setDescription("Shows when a user was last seen in a voice channel")
  .addUserOption((option: SlashCommandUserOption) =>
    option
      .setName("user")
      .setDescription("The user to check")
      .setRequired(true),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    const targetUser = interaction.options.getUser("user");
    if (!targetUser) {
      await interaction.reply("Please specify a user to check.");
      return;
    }

    const tracker = VoiceChannelTracker.getInstance(interaction.client);

    // Check if user is currently in a voice channel
    const activeSession = tracker.getActiveSession(targetUser.id);
    if (activeSession) {
      await interaction.reply(
        `${targetUser.username} is currently in the voice channel "${activeSession.channelName}".`,
      );
      return;
    }

    const lastSeen = await tracker.getUserLastSeen(targetUser.id);

    if (!lastSeen) {
      await interaction.reply(
        `${targetUser.username} has never been seen in a voice channel.`,
      );
      return;
    }

    const timeAgo = formatTimeAgo(lastSeen);
    await interaction.reply(
      `${targetUser.username} was last seen in a voice channel ${timeAgo}.`,
    );
  } catch (error) {
    logger.error("Error in seen command:", error);
    await interaction.reply({
      content: "There was an error while executing this command!",
      ephemeral: true,
    });
  }
}
