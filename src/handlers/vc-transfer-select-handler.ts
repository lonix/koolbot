import {
  StringSelectMenuInteraction,
  ChannelType,
  MessageFlags,
} from "discord.js";
import logger from "../utils/logger.js";
import { safeReply } from "../utils/safe-reply.js";
import { VoiceChannelManager } from "../services/voice-channel-manager.js";

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

  // Verify user is the owner
  if (userId !== ownerId) {
    await interaction.reply({
      content: "❌ Only the channel owner can transfer ownership.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Get the selected user
  const targetUserId = interaction.values[0];

  if (!targetUserId) {
    await interaction.reply({
      content: "❌ Please select a user.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Get the voice channel
  const channel = await interaction.guild?.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildVoice) {
    await interaction.reply({
      content: "❌ Voice channel not found.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    // Get the target member
    const targetMember = await interaction.guild?.members.fetch(targetUserId);
    if (!targetMember) {
      await interaction.reply({
        content: "❌ Could not find the target user.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Check if target user is in the same voice channel
    if (targetMember.voice.channelId !== channelId) {
      await interaction.reply({
        content: "❌ The target user must be in the same voice channel!",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Transfer ownership
    const manager = VoiceChannelManager.getInstance(interaction.client);
    await manager.transferOwnership(channelId, ownerId, targetUserId);

    await interaction.update({
      content: `✅ Channel ownership transferred to ${targetMember.displayName}!`,
      components: [],
    });
  } catch (error) {
    logger.error("Error transferring ownership:", error);
    await safeReply(interaction, {
      content: "❌ Failed to transfer ownership. Please try again.",
      flags: MessageFlags.Ephemeral,
    });
  }
}
