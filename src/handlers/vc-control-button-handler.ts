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
} from "discord.js";
import logger from "../utils/logger.js";
import { VoiceChannelManager } from "../services/voice-channel-manager.js";

export async function handleVCControlButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const customId = interaction.customId;

  // Parse custom ID: vc_control_{action}_{channelId}_{ownerId}
  const parts = customId.split("_");
  if (parts.length < 5 || parts[0] !== "vc" || parts[1] !== "control") {
    await interaction.reply({
      content: "❌ Invalid button interaction.",
      ephemeral: true,
    });
    return;
  }

  const action = parts[2];

  // letin uses a different format: vc_control_letin_{mainChannelId}_{waitingUserId}_{ownerId}
  if (action === "letin") {
    const mainChannelId = parts[3];
    const waitingUserId = parts[4];
    const ownerId = parts[5];

    if (!mainChannelId || !waitingUserId || !ownerId) {
      await interaction.reply({
        content: "❌ Invalid let-in button interaction.",
        ephemeral: true,
      });
      return;
    }

    if (interaction.user.id !== ownerId) {
      await interaction.reply({
        content: "❌ Only the channel owner can let users in.",
        ephemeral: true,
      });
      return;
    }

    await handleLetIn(interaction, mainChannelId, waitingUserId);
    return;
  }

  const channelId = parts[3];
  const ownerId = parts[4];
  const userId = interaction.user.id;

  // Verify user is the owner
  if (userId !== ownerId) {
    await interaction.reply({
      content: "❌ Only the channel owner can use these controls.",
      ephemeral: true,
    });
    return;
  }

  // Get the voice channel
  const channel = await interaction.guild?.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildVoice) {
    await interaction.reply({
      content: "❌ Voice channel not found.",
      ephemeral: true,
    });
    return;
  }

  try {
    switch (action) {
      case "name":
        await handleCustomizeName(interaction, channel as VoiceChannel);
        break;
      case "privacy":
        await handlePrivacy(interaction, channel as VoiceChannel, ownerId);
        break;
      case "invite":
        await handleInvite(interaction);
        break;
      case "transfer":
        await handleTransfer(interaction, channel as VoiceChannel);
        break;
      case "live":
        await handleLive(interaction, channel as VoiceChannel, ownerId);
        break;
      case "waitingroom":
        await handleWaitingRoom(interaction, channel as VoiceChannel, ownerId);
        break;
      default:
        await interaction.reply({
          content: "❌ Unknown action.",
          ephemeral: true,
        });
    }
  } catch (error) {
    logger.error("Error handling VC control button:", error);
    await interaction.reply({
      content: "❌ An error occurred while processing your request.",
      ephemeral: true,
    });
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
    await interaction.reply({
      content: "❌ Could not find @everyone role.",
      ephemeral: true,
    });
    return;
  }

  const permissions = channel.permissionOverwrites.cache.get(everyoneRole.id);
  const isPrivate = permissions?.deny.has(PermissionFlagsBits.Connect);

  if (isPrivate) {
    // Make public
    await channel.permissionOverwrites.delete(everyoneRole.id);

    await interaction.reply({
      content: "✅ Channel is now public. Anyone can join!",
      ephemeral: true,
    });

    // Update control panel
    await updateControlPanel(interaction, channel, ownerId);
  } else {
    // Make private
    await channel.permissionOverwrites.create(everyoneRole, {
      Connect: false,
      ViewChannel: false,
    });

    // Ensure owner has access
    await channel.permissionOverwrites.create(ownerId, {
      Connect: true,
      ViewChannel: true,
    });

    await interaction.reply({
      content:
        "🔒 Channel is now invite-only! Use the Invite button to add users.",
      ephemeral: true,
    });

    // Update control panel
    await updateControlPanel(interaction, channel, ownerId);
  }
}

async function handleInvite(interaction: ButtonInteraction): Promise<void> {
  // Show modal or user select for inviting
  await interaction.reply({
    content:
      "💡 To invite someone to your private channel, grant them permission by right-clicking their name and selecting 'Edit Permissions' for this channel. They'll be notified when you do.",
    ephemeral: true,
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
    await interaction.reply({
      content:
        "❌ There are no other users in the channel to transfer ownership to. Invite someone to the channel first!",
      ephemeral: true,
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

  await interaction.reply({
    content: "👑 Select a user to transfer channel ownership:",
    components: [row],
    ephemeral: true,
  });
}

async function handleLive(
  interaction: ButtonInteraction,
  channel: VoiceChannel,
  ownerId: string,
): Promise<void> {
  const manager = VoiceChannelManager.getInstance(interaction.client);
  const isNowLive = !manager.isLive(channel.id);

  manager.setLiveStatus(channel.id, isNowLive);

  // Apply or remove 🔴 prefix from channel name
  const livePrefix = "🔴 ";
  const currentName = channel.name;
  try {
    if (isNowLive && !currentName.startsWith(livePrefix)) {
      await channel.setName(`${livePrefix}${currentName}`);
    } else if (!isNowLive && currentName.startsWith(livePrefix)) {
      await channel.setName(currentName.slice(livePrefix.length));
    }
  } catch {
    // Name change may fail due to rate limits; continue anyway
  }

  // Send live/offline announcement in the channel text chat
  try {
    if ("send" in channel && typeof channel.send === "function") {
      if (isNowLive) {
        await channel.send(
          "🔴 **This channel is now LIVE!** The host may be streaming on " +
            "Twitch, YouTube, or another platform. Be mindful of their " +
            "platform's Terms of Service while in this channel.",
        );
      } else {
        await channel.send("⬜ The channel is no longer live.");
      }
    }
  } catch {
    // Ignore send errors
  }

  await interaction.reply({
    content: isNowLive
      ? "🔴 Channel marked as **LIVE**! A disclaimer has been posted."
      : "⬜ Channel is now marked as **offline**.",
    ephemeral: true,
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
    await interaction.reply({
      content: "🗑️ Waiting room removed.",
      ephemeral: true,
    });
  } else {
    // Create waiting room
    const waitingRoom = await manager.createWaitingRoom(channel, ownerId);
    if (waitingRoom) {
      await interaction.reply({
        content: `⏳ Waiting room **${waitingRoom.name}** created! Users who join it will notify you here.`,
        ephemeral: true,
      });
    } else {
      await interaction.reply({
        content: "❌ Failed to create waiting room.",
        ephemeral: true,
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
    await interaction.reply({
      content: "❌ Guild not found.",
      ephemeral: true,
    });
    return;
  }

  const mainChannel = (await guild.channels
    .fetch(mainChannelId)
    .catch(() => null)) as VoiceChannel | null;
  if (!mainChannel || mainChannel.type !== ChannelType.GuildVoice) {
    await interaction.reply({
      content: "❌ Main channel not found.",
      ephemeral: true,
    });
    return;
  }

  const manager = VoiceChannelManager.getInstance(interaction.client);
  const waitingRoomId = manager.getWaitingRoom(mainChannelId);

  let waitingMember;
  try {
    waitingMember = await guild.members.fetch(waitingUserId);
  } catch {
    await interaction.reply({
      content: "❌ Could not find the waiting user.",
      ephemeral: true,
    });
    return;
  }

  // Check if user is in the waiting room
  if (waitingRoomId && waitingMember.voice.channelId !== waitingRoomId) {
    await interaction.reply({
      content: `⚠️ **${waitingMember.displayName}** is no longer in the waiting room.`,
      ephemeral: true,
    });
    return;
  }

  try {
    await waitingMember.voice.setChannel(mainChannel);
    await interaction.reply({
      content: `✅ **${waitingMember.displayName}** has been let into the channel!`,
      ephemeral: true,
    });
  } catch {
    await interaction.reply({
      content: `❌ Failed to move **${waitingMember.displayName}** into the channel.`,
      ephemeral: true,
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
