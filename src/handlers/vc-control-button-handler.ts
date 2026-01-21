import {
  ButtonInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  VoiceChannel,
  ChannelType,
} from "discord.js";
import logger from "../utils/logger.js";
import { VoiceChannelManager } from "../services/voice-channel-manager.js";
import { ChannelInvite } from "../models/channel-invite.js";

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
        await handlePrivacy(
          interaction,
          channel as VoiceChannel,
          ownerId,
          channelId,
        );
        break;
      case "invite":
        await handleInvite(interaction, channel as VoiceChannel);
        break;
      case "transfer":
        await handleTransfer(interaction, channel as VoiceChannel);
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
  channelId: string,
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
    await updateControlPanel(interaction, channel, ownerId, false);
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
    await updateControlPanel(interaction, channel, ownerId, true);
  }
}

async function handleInvite(
  interaction: ButtonInteraction,
  channel: VoiceChannel,
): Promise<void> {
  await interaction.reply({
    content:
      "💡 To invite someone, use the command `/vc invite user:<@user>` while in this channel.",
    ephemeral: true,
  });
}

async function handleTransfer(
  interaction: ButtonInteraction,
  channel: VoiceChannel,
): Promise<void> {
  await interaction.reply({
    content:
      "💡 To transfer ownership, use the `/transfer-ownership` command while in this channel.",
    ephemeral: true,
  });
}

async function updateControlPanel(
  interaction: ButtonInteraction,
  channel: VoiceChannel,
  ownerId: string,
  isPrivate: boolean,
): Promise<void> {
  try {
    // Find the original message and update it
    if (interaction.message && "edit" in interaction.message) {
      const embed = new EmbedBuilder()
        .setTitle("🎮 Voice Channel Controls")
        .setDescription(
          `Manage your voice channel: **${channel.name}**\n\n` +
            `Privacy: ${isPrivate ? "🔒 Invite-Only" : "🌐 Public"}`,
        )
        .setColor(isPrivate ? 0xff0000 : 0x00ff00)
        .setFooter({ text: "Only you can see and use these controls" });

      const privacyButton = new ButtonBuilder()
        .setCustomId(`vc_control_privacy_${channel.id}_${ownerId}`)
        .setLabel(isPrivate ? "Make Public" : "Make Private")
        .setStyle(isPrivate ? ButtonStyle.Success : ButtonStyle.Danger)
        .setEmoji(isPrivate ? "🌐" : "🔒");

      const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`vc_control_name_${channel.id}_${ownerId}`)
          .setLabel("Rename")
          .setStyle(ButtonStyle.Primary)
          .setEmoji("✏️"),
        privacyButton,
        new ButtonBuilder()
          .setCustomId(`vc_control_invite_${channel.id}_${ownerId}`)
          .setLabel("Invite")
          .setStyle(ButtonStyle.Secondary)
          .setEmoji("👥")
          .setDisabled(!isPrivate),
        new ButtonBuilder()
          .setCustomId(`vc_control_transfer_${channel.id}_${ownerId}`)
          .setLabel("Transfer")
          .setStyle(ButtonStyle.Secondary)
          .setEmoji("👑"),
      );

      await interaction.message.edit({
        embeds: [embed],
        components: [buttons],
      });
    }
  } catch (error) {
    logger.error("Error updating control panel:", error);
  }
}
