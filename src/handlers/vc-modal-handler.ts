import { ModalSubmitInteraction, ChannelType } from "discord.js";
import logger from "../utils/logger.js";
import { VoiceChannelManager } from "../services/voice-channel-manager.js";
import { ConfigService } from "../services/config-service.js";
import { UserVoicePreferences } from "../models/user-voice-preferences.js";

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

  const presetName = interaction.fields.getTextInputValue("name").trim();
  if (presetName.length === 0 || presetName.length > 50) {
    await interaction.reply({
      content: "❌ Preset name must be 1–50 characters.",
      ephemeral: true,
    });
    return;
  }

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
  const prefs =
    (await UserVoicePreferences.findOne({ userId })) ??
    (await UserVoicePreferences.create({ userId, presets: [] }));

  const existingIndex = prefs.presets.findIndex(
    (p) => p.name.toLowerCase() === presetName.toLowerCase(),
  );

  if (existingIndex === -1 && prefs.presets.length >= max) {
    await interaction.reply({
      content: `❌ You already have ${max} presets (the configured maximum). Delete one first or rename an existing preset.`,
      ephemeral: true,
    });
    return;
  }

  const snapshot = {
    name: presetName,
    channelName: channel.name,
    userLimit: channel.userLimit ?? 0,
    bitrate: Math.round((channel.bitrate ?? 64000) / 1000),
    isDefault:
      existingIndex !== -1
        ? !!prefs.presets[existingIndex].isDefault
        : false,
  };

  if (existingIndex !== -1) {
    prefs.presets[existingIndex] = snapshot;
  } else {
    prefs.presets.push(snapshot);
  }
  prefs.markModified("presets");
  await prefs.save();

  logger.info(
    `User ${userId} saved preset "${presetName}" from channel ${channelId}`,
  );

  await interaction.reply({
    content:
      existingIndex !== -1
        ? `✅ Preset **${presetName}** updated from this channel's settings.`
        : `✅ Preset **${presetName}** saved.`,
    ephemeral: true,
  });
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

  const newName = interaction.fields.getTextInputValue("name").trim();
  if (newName.length === 0 || newName.length > 50) {
    await interaction.reply({
      content: "❌ Preset name must be 1–50 characters.",
      ephemeral: true,
    });
    return;
  }

  const prefs = await UserVoicePreferences.findOne({ userId });
  const preset = prefs?.presets?.[presetIndex];
  if (!prefs || !preset) {
    await interaction.reply({
      content: "❌ Preset no longer exists.",
      ephemeral: true,
    });
    return;
  }

  const collision = prefs.presets.findIndex(
    (p, i) =>
      i !== presetIndex && p.name.toLowerCase() === newName.toLowerCase(),
  );
  if (collision !== -1) {
    await interaction.reply({
      content: `❌ You already have a preset named **${newName}**.`,
      ephemeral: true,
    });
    return;
  }

  const oldName = preset.name;
  preset.name = newName;
  prefs.markModified("presets");
  await prefs.save();

  await interaction.reply({
    content: `✏️ Preset **${oldName}** renamed to **${newName}**.`,
    ephemeral: true,
  });
}
