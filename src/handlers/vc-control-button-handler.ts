import {
  ButtonInteraction,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  VoiceChannel,
  ChannelType,
  StringSelectMenuBuilder,
  MessageFlags,
} from "discord.js";
import logger from "../utils/logger.js";
import { safeReply } from "../utils/safe-reply.js";
import {
  replyWithError,
  replyWithUnexpectedError,
} from "../utils/error-reply.js";
import { VC_CHANNEL_GONE, VC_NOT_OWNER, VC_OUT_OF_DATE } from "./vc-errors.js";
import { NO_MENTIONS } from "../utils/allowed-mentions.js";
import { VoiceChannelManager } from "../services/voice-channel-manager.js";

/** Actions that mutate the room under the room lock (deferred up front). */
const LOCKED_ACTIONS = new Set(["privacy", "live", "waitingroom"]);

export async function handleVCControlButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const customId = interaction.customId;

  // Parse custom ID: vc_control_{action}_{channelId}_{ownerId}
  const parts = customId.split("_");
  if (parts.length < 5 || parts[0] !== "vc" || parts[1] !== "control") {
    await replyWithError(interaction, VC_OUT_OF_DATE);
    return;
  }

  const action = parts[2];

  // letin uses a different format: vc_control_letin_{mainChannelId}_{waitingUserId}_{ownerId}
  if (action === "letin") {
    const mainChannelId = parts[3];
    const waitingUserId = parts[4];
    const ownerId = parts[5];

    if (!mainChannelId || !waitingUserId || !ownerId) {
      await replyWithError(interaction, VC_OUT_OF_DATE);
      return;
    }

    if (interaction.user.id !== ownerId) {
      await replyWithError(interaction, {
        title: "Only the room owner can let people in",
        next: VC_NOT_OWNER.next,
      });
      return;
    }

    // Same deferral as the other locked actions (see below)
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await handleLetIn(interaction, mainChannelId, waitingUserId);
    return;
  }

  const channelId = parts[3];
  const ownerId = parts[4];
  const userId = interaction.user.id;

  // Verify user is the owner. The ownerId in the customId is only a hint (it
  // goes stale on transfer); authorise against live ownership (#1143).
  if (
    userId !== ownerId ||
    !VoiceChannelManager.getInstance(interaction.client).isRoomOwner(
      userId,
      channelId,
    )
  ) {
    await replyWithError(interaction, VC_NOT_OWNER);
    return;
  }

  // Acknowledge before any slow work: the room-mutating actions below can
  // queue behind an in-flight ownership transfer holding the room lock, which
  // can outlast Discord's 3-second window (10062). Replies after this point go
  // through safeReply, which edits the deferred response.
  if (LOCKED_ACTIONS.has(action)) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  // Get the voice channel
  const channel = await interaction.guild?.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildVoice) {
    await replyWithError(interaction, VC_CHANNEL_GONE);
    return;
  }

  // Room-mutating actions run under the room's lock with ownership re-checked
  // inside it, so a transfer that lands after the preflight above (during the
  // channel fetch or any Discord call) cannot let a former owner act (#1143).
  const manager = VoiceChannelManager.getInstance(interaction.client);
  const asOwner = async (work: () => Promise<void>): Promise<void> => {
    const ran = await manager.runAsRoomOwner(userId, channelId, work);
    if (!ran) {
      await replyWithError(interaction, VC_NOT_OWNER);
    }
  };

  try {
    switch (action) {
      case "name":
        await handleCustomizeName(interaction, channel as VoiceChannel);
        break;
      case "privacy":
        await asOwner(() =>
          handlePrivacy(interaction, channel as VoiceChannel, ownerId),
        );
        break;
      case "invite":
        await handleInvite(interaction);
        break;
      case "transfer":
        await handleTransfer(interaction, channel as VoiceChannel);
        break;
      case "live":
        await asOwner(() =>
          handleLive(interaction, channel as VoiceChannel, ownerId),
        );
        break;
      case "waitingroom":
        await asOwner(() =>
          handleWaitingRoom(interaction, channel as VoiceChannel, ownerId),
        );
        break;
      default:
        await replyWithError(interaction, VC_OUT_OF_DATE);
    }
  } catch (error) {
    logger.error("Error handling VC control button:", error);
    await replyWithUnexpectedError(interaction);
  }
}

async function handleCustomizeName(
  interaction: ButtonInteraction,
  channel: VoiceChannel,
): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId(`vc_modal_name_${channel.id}_${interaction.user.id}`)
    .setTitle("Customize Channel Name");

  const nameInput = new TextInputBuilder()
    .setCustomId("name")
    .setLabel("Channel Name")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("Enter new channel name")
    .setRequired(true)
    .setMaxLength(100)
    .setValue(channel.name);

  const row = new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput);
  modal.addComponents(row);

  await interaction.showModal(modal);
}

async function handlePrivacy(
  interaction: ButtonInteraction,
  channel: VoiceChannel,
  ownerId: string,
): Promise<void> {
  // Check current privacy state by looking at @everyone permissions
  const everyoneRole = interaction.guild?.roles.everyone;
  if (!everyoneRole) {
    logger.warn("Could not find the @everyone role for a privacy toggle");
    await replyWithError(interaction, {
      title: "Couldn't change the room's privacy",
      next: "Try again in a minute. If it keeps happening, tell an admin.",
    });
    return;
  }

  const permissions = channel.permissionOverwrites.cache.get(everyoneRole.id);
  const isPrivate = permissions?.deny.has(PermissionFlagsBits.Connect);

  if (isPrivate) {
    // Make public
    await channel.permissionOverwrites.delete(everyoneRole.id);

    await safeReply(interaction, {
      content: "✅ Channel is now public. Anyone can join!",
      flags: MessageFlags.Ephemeral,
    });

    // Update control panel
    await updateControlPanel(interaction, channel, ownerId);
  } else {
    // Make private
    await channel.permissionOverwrites.create(everyoneRole, {
      Connect: false,
      ViewChannel: false,
    });

    // Ensure owner has access. The @everyone deny above is already in place,
    // so a failure here is a half-finished toggle: never advise a retry (once
    // the deny is cached, the next click takes the make-public branch and
    // reopens the room). Say what state it is in and what to check.
    try {
      await channel.permissionOverwrites.create(ownerId, {
        Connect: true,
        ViewChannel: true,
      });
    } catch (error) {
      logger.error("Error giving the owner access to a private room:", error);
      await updateControlPanel(interaction, channel, ownerId);
      await replyWithError(interaction, {
        title: "Your room is private, but I couldn't confirm your access",
        next: "Check the room's permissions in Discord before using the privacy button again. The details are in the bot's log.",
      });
      return;
    }

    await safeReply(interaction, {
      content:
        "🔒 Channel is now invite-only! Use the Invite button to add users.",
      flags: MessageFlags.Ephemeral,
    });

    // Update control panel
    await updateControlPanel(interaction, channel, ownerId);
  }
}

async function handleInvite(interaction: ButtonInteraction): Promise<void> {
  // Show modal or user select for inviting
  await safeReply(interaction, {
    content:
      "💡 To invite someone to your private channel, grant them permission by right-clicking their name and selecting 'Edit Permissions' for this channel. They'll be notified when you do.",
    flags: MessageFlags.Ephemeral,
  });
}

async function handleTransfer(
  interaction: ButtonInteraction,
  channel: VoiceChannel,
): Promise<void> {
  // Get members in the channel (excluding the owner)
  const membersInChannel = Array.from(channel.members.values()).filter(
    (m) => m.id !== interaction.user.id && !m.user.bot,
  );

  if (membersInChannel.length === 0) {
    await replyWithError(interaction, {
      title: "No one else is in your room",
      next: "Ask someone to join your voice channel, then press Transfer again.",
    });
    return;
  }

  // Create a select menu with members in the channel
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`vc_transfer_select_${channel.id}_${interaction.user.id}`)
    .setPlaceholder("Select a user to transfer ownership to")
    .addOptions(
      membersInChannel.slice(0, 25).map((member) => ({
        label: member.displayName,
        description: `Transfer ownership to ${member.displayName}`,
        value: member.id,
      })),
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    selectMenu,
  );

  await safeReply(interaction, {
    content: "👑 Select a user to transfer channel ownership:",
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleLive(
  interaction: ButtonInteraction,
  channel: VoiceChannel,
  ownerId: string,
): Promise<void> {
  const manager = VoiceChannelManager.getInstance(interaction.client);
  const isNowLive = await manager.toggleLive(channel);

  await safeReply(interaction, {
    content: isNowLive
      ? "🔴 Channel marked as **LIVE**! A disclaimer has been posted."
      : "⬜ Channel is now marked as **offline**.",
    flags: MessageFlags.Ephemeral,
  });

  // Update the control panel
  if (interaction.message && "edit" in interaction.message) {
    await manager
      .rebuildControlPanel(channel, ownerId, interaction.message)
      .catch((err) => logger.error("Error rebuilding control panel:", err));
  }
}

async function handleWaitingRoom(
  interaction: ButtonInteraction,
  channel: VoiceChannel,
  ownerId: string,
): Promise<void> {
  const manager = VoiceChannelManager.getInstance(interaction.client);
  const existingWaitingRoom = manager.getWaitingRoom(channel.id);

  if (existingWaitingRoom) {
    // Remove waiting room
    await manager.removeWaitingRoom(channel.id);
    await safeReply(interaction, {
      content: "🗑️ Waiting room removed.",
      flags: MessageFlags.Ephemeral,
    });
  } else {
    // Create waiting room
    const waitingRoom = await manager.createWaitingRoom(channel, ownerId);
    if (waitingRoom) {
      await safeReply(interaction, {
        content: `⏳ Waiting room <#${waitingRoom.id}> created! Users who join it will notify you here.`,
        allowedMentions: NO_MENTIONS,
        flags: MessageFlags.Ephemeral,
      });
    } else {
      await replyWithError(interaction, {
        title: "Couldn't create the waiting room",
        next: "Check your channel list for a waiting room before trying again. If it keeps happening, tell an admin.",
      });
      return;
    }
  }

  // Update the control panel
  if (interaction.message && "edit" in interaction.message) {
    await manager
      .rebuildControlPanel(channel, ownerId, interaction.message)
      .catch((err) => logger.error("Error rebuilding control panel:", err));
  }
}

async function handleLetIn(
  interaction: ButtonInteraction,
  mainChannelId: string,
  waitingUserId: string,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await replyWithError(interaction, {
      title: "This control only works in a server",
      next: VC_OUT_OF_DATE.next,
    });
    return;
  }

  const mainChannel = (await guild.channels
    .fetch(mainChannelId)
    .catch(() => null)) as VoiceChannel | null;
  if (!mainChannel || mainChannel.type !== ChannelType.GuildVoice) {
    await replyWithError(interaction, VC_CHANNEL_GONE);
    return;
  }

  const manager = VoiceChannelManager.getInstance(interaction.client);

  // Ownership is checked, and the member moved, inside one locked operation:
  // a transfer landing during the waiting-room lookup or member fetch below
  // must not let a former owner move people into the new owner's room (#1143).
  const ran = await manager.runAsRoomOwner(
    interaction.user.id,
    mainChannelId,
    async () => {
      // Require the waiting room to still exist
      const waitingRoomId = manager.getWaitingRoom(mainChannelId);
      if (!waitingRoomId) {
        await replyWithError(interaction, {
          title: "The waiting room is gone",
          next: "Use the waiting room control to create a new one.",
        });
        return;
      }

      let waitingMember;
      try {
        waitingMember = await guild.members.fetch(waitingUserId);
      } catch (error) {
        logger.error("Could not fetch the waiting user:", error);
        await replyWithError(interaction, {
          title: "That member could not be found",
          next: "They may have left the server. Nothing was changed.",
        });
        return;
      }

      // Confirm user is still in the waiting room
      if (waitingMember.voice.channelId !== waitingRoomId) {
        await replyWithError(interaction, {
          title: "That member left the waiting room",
          next: `<@${waitingMember.id}> is no longer waiting. Nothing was changed.`,
        });
        return;
      }

      try {
        await waitingMember.voice.setChannel(mainChannel);
        await safeReply(interaction, {
          content: `✅ <@${waitingMember.id}> has been let into the channel!`,
          allowedMentions: NO_MENTIONS,
          flags: MessageFlags.Ephemeral,
        });
      } catch (error) {
        logger.error("Error letting user in from the waiting room:", error);
        await replyWithError(interaction, {
          title: "Couldn't move that member into your room",
          next: `Check that <@${waitingMember.id}> is still in the waiting room, then try again.`,
        });
      }
    },
  );
  if (!ran) {
    await replyWithError(interaction, {
      title: "Only the room owner can let people in",
      next: VC_NOT_OWNER.next,
    });
  }
}

async function updateControlPanel(
  interaction: ButtonInteraction,
  channel: VoiceChannel,
  ownerId: string,
): Promise<void> {
  try {
    if (interaction.message && "edit" in interaction.message) {
      const manager = VoiceChannelManager.getInstance(interaction.client);
      await manager.rebuildControlPanel(channel, ownerId, interaction.message);
    }
  } catch (error) {
    logger.error("Error updating control panel:", error);
  }
}
