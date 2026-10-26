import { StringSelectMenuInteraction, ChannelType } from "discord.js";
import logger from "../utils/logger.js";
import { safeReply } from "../utils/safe-reply.js";
import {
  replyWithError,
  replyWithUnexpectedError,
} from "../utils/error-reply.js";
import { VC_CHANNEL_GONE, VC_NOT_OWNER, VC_OUT_OF_DATE } from "./vc-errors.js";
import { NO_MENTIONS } from "../utils/allowed-mentions.js";
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
    await replyWithError(interaction, VC_OUT_OF_DATE);
    return;
  }

  const channelId = parts[3];
  const ownerId = parts[4];
  const userId = interaction.user.id;

  // Verify user is the owner: the customId's ownerId is only a hint, so also
  // require live ownership (an ephemeral select can outlive a transfer) (#1143).
  const manager = VoiceChannelManager.getInstance(interaction.client);
  if (userId !== ownerId || !manager.isRoomOwner(userId, channelId)) {
    await replyWithError(interaction, {
      title: "Only the room owner can transfer ownership",
      next: VC_NOT_OWNER.next,
    });
    return;
  }

  // Acknowledge before the fetches and the (possibly queued) locked transfer,
  // which can outlast Discord's 3-second window (10062). Everything below
  // edits the deferred message, dropping the select menu.
  await interaction.deferUpdate();
  const done = async (content: string): Promise<void> => {
    await safeReply(interaction, {
      content,
      components: [],
      allowedMentions: NO_MENTIONS,
    });
  };

  // Get the selected user
  const targetUserId = interaction.values[0];

  if (!targetUserId) {
    await replyWithError(interaction, {
      title: "No member was selected",
      next: "Open the menu again and pick a member from your room.",
    });
    return;
  }

  // Get the voice channel
  const channel = await interaction.guild?.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildVoice) {
    await replyWithError(interaction, VC_CHANNEL_GONE);
    return;
  }

  try {
    // Get the target member
    const targetMember = await interaction.guild?.members.fetch(targetUserId);
    if (!targetMember) {
      await replyWithError(interaction, {
        title: "That member could not be found",
        next: "Pick someone who is in your room, then try again.",
      });
      return;
    }

    // Check if target user is in the same voice channel
    if (targetMember.voice.channelId !== channelId) {
      await replyWithError(interaction, {
        title: "That member is not in your room",
        next: "Ask them to join your voice channel, then pick them again.",
      });
      return;
    }

    // Transfer ownership
    await manager.transferOwnership(channelId, ownerId, targetUserId);

    await done(`✅ Channel ownership transferred to <@${targetMember.id}>!`);
  } catch (error) {
    // transferOwnership re-checks ownership under the room lock; a transfer
    // that landed after our preflight makes this request stale (#1143).
    if (error instanceof NotRoomOwnerError) {
      await replyWithError(interaction, {
        title: "Only the room owner can transfer ownership",
        next: VC_NOT_OWNER.next,
      });
      return;
    }
    logger.error("Error transferring ownership:", error);
    await replyWithUnexpectedError(interaction);
  }
}
