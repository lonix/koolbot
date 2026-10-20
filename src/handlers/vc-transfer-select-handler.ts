import {
  StringSelectMenuInteraction,
  ChannelType,
  MessageFlags,
} from "discord.js";
import logger from "../utils/logger.js";
import { safeReply } from "../utils/safe-reply.js";
import {
  VoiceChannelManager,
  NotRoomOwnerError,
} from "../services/voice-channel-manager.js";

export async function handleVCTransferSelect(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const customId = interaction.customId;

  // Parse custom ID: vc_transfer_select_{channelId}_{ownerId}
  const parts = customId.split("_");
  if (parts.length < 5 || parts[0] !== "vc" || parts[1] !== "transfer") {
    await interaction.reply({
      content: "❌ Invalid select menu interaction.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channelId = parts[3];
  const ownerId = parts[4];
  const userId = interaction.user.id;

  // Verify user is the owner: the customId's ownerId is only a hint, so also
  // require live ownership (an ephemeral select can outlive a transfer) (#1143).
  const manager = VoiceChannelManager.getInstance(interaction.client);
  if (userId !== ownerId || !manager.isRoomOwner(userId, channelId)) {
    await interaction.reply({
      content: "❌ Only the current channel owner can transfer ownership.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Acknowledge before the fetches and the (possibly queued) locked transfer,
  // which can outlast Discord's 3-second window (10062). Everything below
  // edits the deferred message, dropping the select menu.
  await interaction.deferUpdate();
  const done = async (content: string): Promise<void> => {
    await safeReply(interaction, { content, components: [] });
  };

  // Get the selected user
  const targetUserId = interaction.values[0];

  if (!targetUserId) {
    await done("❌ Please select a user.");
    return;
  }

  // Get the voice channel
  const channel = await interaction.guild?.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildVoice) {
    await done("❌ Voice channel not found.");
    return;
  }

  try {
    // Get the target member
    const targetMember = await interaction.guild?.members.fetch(targetUserId);
    if (!targetMember) {
      await done("❌ Could not find the target user.");
      return;
    }

    // Check if target user is in the same voice channel
    if (targetMember.voice.channelId !== channelId) {
      await done("❌ The target user must be in the same voice channel!");
      return;
    }

    // Transfer ownership
    await manager.transferOwnership(channelId, ownerId, targetUserId);

    await done(`✅ Channel ownership transferred to <@${targetMember.id}>!`);
  } catch (error) {
    // transferOwnership re-checks ownership under the room lock; a transfer
    // that landed after our preflight makes this request stale (#1143).
    if (error instanceof NotRoomOwnerError) {
      await done("❌ Only the current channel owner can transfer ownership.");
      return;
    }
    logger.error("Error transferring ownership:", error);
    await done("❌ Failed to transfer ownership. Please try again.");
  }
}
