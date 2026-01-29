import { ModalSubmitInteraction, ChannelType } from "discord.js";
import logger from "../utils/logger.js";
import { VoiceChannelManager } from "../services/voice-channel-manager.js";

export async function handleVCModal(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  const customId = interaction.customId;

  // Parse custom ID: vc_modal_{action}_{channelId}_{userId}
  const parts = customId.split("_");
  if (parts.length < 5 || parts[0] !== "vc" || parts[1] !== "modal") {
    await interaction.reply({
      content: "❌ Invalid modal interaction.",
      ephemeral: true,
    });
    return;
  }

  const action = parts[2];
  const channelId = parts[3];
  const userId = parts[4];

  // Verify user
  if (userId !== interaction.user.id) {
    await interaction.reply({
      content: "❌ This modal belongs to another user.",
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
        await handleNameModal(interaction, channelId);
        break;
      default:
        await interaction.reply({
          content: "❌ Unknown modal action.",
          ephemeral: true,
        });
    }
  } catch (error) {
    logger.error("Error handling VC modal:", error);
    await interaction.reply({
      content: "❌ An error occurred while processing your request.",
      ephemeral: true,
    });
  }
}

async function handleNameModal(
  interaction: ModalSubmitInteraction,
  channelId: string,
): Promise<void> {
  const newName = interaction.fields.getTextInputValue("name");

  // Validate name length
  if (newName.length > 100) {
    await interaction.reply({
      content: "❌ Channel name must be 100 characters or less.",
      ephemeral: true,
    });
    return;
  }

  if (newName.length < 1) {
    await interaction.reply({
      content: "❌ Channel name cannot be empty.",
      ephemeral: true,
    });
    return;
  }

  try {
    const channel = await interaction.guild?.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) {
      await interaction.reply({
        content: "❌ Voice channel not found.",
        ephemeral: true,
      });
      return;
    }

    await channel.setName(newName);

    // Mark this channel as having a custom name
    const manager = VoiceChannelManager.getInstance(interaction.client);
    manager.setCustomChannelName(channelId, newName);

    await interaction.reply({
      content: `✅ Channel renamed to: **${newName}**`,
      ephemeral: true,
    });
  } catch (error) {
    logger.error("Error renaming channel:", error);
    await interaction.reply({
      content: "❌ Failed to rename channel. Please try again.",
      ephemeral: true,
    });
  }
}
