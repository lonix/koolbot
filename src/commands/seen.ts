import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  SlashCommandUserOption,
} from "discord.js";
import { VoiceChannelTracker } from "../services/voice-channel-tracker.js";
import { discordTimestamp } from "../utils/discord-time.js";
import { NO_MENTIONS } from "../utils/allowed-mentions.js";
import logger from "../utils/logger.js";
import { safeReply } from "../utils/safe-reply.js";
import {
  HIDDEN_CHANNEL_LABEL,
  visibleChannelName,
} from "../utils/channel-visibility.js";

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
      // Name the channel only if the caller could see it themselves; a locked
      // or hidden room's name is not theirs to learn from /seen (#1153).
      const channelName = visibleChannelName(
        interaction,
        activeSession.channelId,
      );
      await interaction.editReply({
        content:
          channelName === HIDDEN_CHANNEL_LABEL
            ? `<@${targetUser.id}> is currently in ${HIDDEN_CHANNEL_LABEL}.`
            : `<@${targetUser.id}> is currently in <#${activeSession.channelId}>.`,
        allowedMentions: NO_MENTIONS,
      });
      return;
    }

    const lastSeen = await tracker.getUserLastSeen(targetUser.id);

    if (!lastSeen) {
      await interaction.editReply({
        content: `<@${targetUser.id}> has never been seen in a voice channel.`,
        allowedMentions: NO_MENTIONS,
      });
      return;
    }

    await interaction.editReply({
      content: `<@${targetUser.id}> was last seen in a voice channel ${discordTimestamp(lastSeen, "R")}.`,
      allowedMentions: NO_MENTIONS,
    });
  } catch (error) {
    logger.error("Error in seen command:", error);
    // Public on purpose: once deferred, visibility is fixed and safeReply
    // edits the public placeholder, so an ephemeral flag would be a lie.
    await safeReply(interaction, {
      content: "There was an error while executing this command!",
    });
  }
}
