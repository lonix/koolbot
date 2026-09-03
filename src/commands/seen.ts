import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  SlashCommandUserOption,
} from "discord.js";
import { VoiceChannelTracker } from "../services/voice-channel-tracker.js";
import { formatTimeAgo } from "../utils/time.js";
import logger from "../utils/logger.js";
import { safeReply } from "../utils/safe-reply.js";

export const data = new SlashCommandBuilder()
  .setName("seen")
  .setDescription("Shows when a user was last seen in a voice channel")
  .addUserOption((option: SlashCommandUserOption) =>
    option
      .setName("user")
      .setDescription("The user to check")
      .setRequired(true),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    const targetUser = interaction.options.getUser("user");
    if (!targetUser) {
      await interaction.reply("Please specify a user to check.");
      return;
    }

    // Acknowledge before the DB lookup so a slow query cannot miss Discord's
    // 3-second ACK window (`10062 Unknown interaction`, #842).
    await interaction.deferReply();

    const tracker = VoiceChannelTracker.getInstance(interaction.client);

    // Check if user is currently in a voice channel
    const activeSession = tracker.getActiveSession(targetUser.id);
    if (activeSession) {
      await interaction.editReply(
        `${targetUser.username} is currently in the voice channel "${activeSession.channelName}".`,
      );
      return;
    }

    const lastSeen = await tracker.getUserLastSeen(targetUser.id);

    if (!lastSeen) {
      await interaction.editReply(
        `${targetUser.username} has never been seen in a voice channel.`,
      );
      return;
    }

    const timeAgo = formatTimeAgo(lastSeen);
    await interaction.editReply(
      `${targetUser.username} was last seen in a voice channel ${timeAgo}.`,
    );
  } catch (error) {
    logger.error("Error in seen command:", error);
    // Public on purpose: once deferred, visibility is fixed and safeReply
    // edits the public placeholder, so an ephemeral flag would be a lie.
    await safeReply(interaction, {
      content: "There was an error while executing this command!",
    });
  }
}
