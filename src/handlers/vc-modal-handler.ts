import { ModalSubmitInteraction, ChannelType } from "discord.js";
import logger from "../utils/logger.js";
import { VoiceChannelManager } from "../services/voice-channel-manager.js";
import { ConfigService } from "../services/config-service.js";
import {
  UserVoicePrefsService,
  VoicePrefsValidationError,
} from "../services/user-voice-prefs-service.js";

const configService = ConfigService.getInstance();

export async function handleVCModal(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  const customId = interaction.customId;

  // Forms:
  //   vc_modal_{action}_{channelId}_{userId}              (5 parts)
  //   vc_modal_{action}_{presetIndex}_{channelId}_{userId} (6 parts, preset-targeting actions)
  const parts = customId.split("_");
  if (parts.length < 5 || parts[0] !== "vc" || parts[1] !== "modal") {
    await interaction.reply({
      content: "❌ Invalid modal interaction.",
      ephemeral: true,
    });
    return;
  }

  const action = parts[2];
  const usesPresetIndex = parts.length === 6;
  const presetIndex = usesPresetIndex ? Number(parts[3]) : null;
  const channelId = usesPresetIndex ? parts[4] : parts[3];
  const userId = usesPresetIndex ? parts[5] : parts[4];

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
      case "savepreset":
        await handleSavePresetModal(interaction, channelId, userId);
        break;
      case "renamepreset":
        if (presetIndex === null || !Number.isInteger(presetIndex)) {
          await interaction.reply({
            content: "❌ Invalid preset reference.",
            ephemeral: true,
          });
          return;
        }
        await handleRenamePresetModal(interaction, presetIndex, userId);
        break;
      default:
        await interaction.reply({
          content: "❌ Unknown modal action.",
          ephemeral: true,
        });
    }
  } catch (error) {
    logger.error("Error handling VC modal:", error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "❌ An error occurred while processing your request.",
        ephemeral: true,
      });
    }
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

    const oldName = channel.name;
    await channel.setName(newName);

    // Mark this channel as having a custom name
    const manager = VoiceChannelManager.getInstance(interaction.client);
    manager.setCustomChannelName(channelId, newName);

    logger.info(
      `User ${interaction.user.displayName || interaction.user.username} (${interaction.user.id}) renamed channel "${oldName}" → "${newName}" (${channelId})`,
    );

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

async function handleSavePresetModal(
  interaction: ModalSubmitInteraction,
  channelId: string,
  userId: string,
): Promise<void> {
  const enabled = await configService.getBoolean(
    "voicechannels.presets.enabled",
    false,
  );
  if (!enabled) {
    await interaction.reply({
      content: "❌ Presets are disabled on this server.",
      ephemeral: true,
    });
    return;
  }

  const presetName = interaction.fields.getTextInputValue("name");

  const channel = await interaction.guild?.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildVoice) {
    await interaction.reply({
      content: "❌ Voice channel not found.",
      ephemeral: true,
    });
    return;
  }

  const max = await configService.getNumber(
    "voicechannels.presets.max_per_user",
    3,
  );

  try {
    const { updated, name } =
      await UserVoicePrefsService.getInstance().savePreset(
        userId,
        presetName,
        {
          channelName: channel.name,
          userLimit: channel.userLimit ?? 0,
          bitrate: Math.round((channel.bitrate ?? 64000) / 1000),
        },
        max,
      );

    logger.info(
      `User ${userId} saved preset "${name}" from channel ${channelId}`,
    );

    await interaction.reply({
      content: updated
        ? `✅ Preset **${name}** updated from this channel's settings.`
        : `✅ Preset **${name}** saved.`,
      ephemeral: true,
    });
  } catch (error) {
    if (error instanceof VoicePrefsValidationError) {
      await interaction.reply({
        content: `❌ ${error.message}`,
        ephemeral: true,
      });
      return;
    }
    throw error;
  }
}

async function handleRenamePresetModal(
  interaction: ModalSubmitInteraction,
  presetIndex: number,
  userId: string,
): Promise<void> {
  const enabled = await configService.getBoolean(
    "voicechannels.presets.enabled",
    false,
  );
  if (!enabled) {
    await interaction.reply({
      content: "❌ Presets are disabled on this server.",
      ephemeral: true,
    });
    return;
  }

  const newName = interaction.fields.getTextInputValue("name");

  try {
    const { oldName, newName: savedName } =
      await UserVoicePrefsService.getInstance().renamePreset(
        userId,
        presetIndex,
        newName,
      );

    await interaction.reply({
      content: `✏️ Preset **${oldName}** renamed to **${savedName}**.`,
      ephemeral: true,
    });
  } catch (error) {
    if (error instanceof VoicePrefsValidationError) {
      await interaction.reply({
        content: `❌ ${error.message}`,
        ephemeral: true,
      });
      return;
    }
    throw error;
  }
}
