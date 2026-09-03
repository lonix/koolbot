import { ModalSubmitInteraction, ChannelType, MessageFlags } from "discord.js";
import logger from "../utils/logger.js";
import { safeReply } from "../utils/safe-reply.js";
import { VoiceChannelManager } from "../services/voice-channel-manager.js";
import { ConfigService } from "../services/config-service.js";
import {
  UserVoicePrefsService,
  VoicePrefsValidationError,
} from "../services/user-voice-prefs-service.js";
import { presetNameTag } from "./vc-preset-handler.js";

const configService = ConfigService.getInstance();

export async function handleVCModal(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  const customId = interaction.customId;

  // Forms:
  //   vc_modal_{action}_{channelId}_{userId}                          (5 parts)
  //   vc_modal_{action}_{presetIndex}_{channelId}_{userId}            (6 parts, legacy in-flight modals)
  //   vc_modal_{action}_{presetIndex}_{nameTag}_{channelId}_{userId}  (7 parts, preset-targeting actions)
  const parts = customId.split("_");
  if (parts.length < 5 || parts[0] !== "vc" || parts[1] !== "modal") {
    await interaction.reply({
      content: "❌ Invalid modal interaction.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const action = parts[2];
  const usesPresetIndex = parts.length >= 6;
  const hasNameTag = parts.length === 7;
  const presetIndex = usesPresetIndex ? Number(parts[3]) : null;
  const nameTag = hasNameTag ? parts[4] : null;
  const channelId = hasNameTag
    ? parts[5]
    : usesPresetIndex
      ? parts[4]
      : parts[3];
  const userId = hasNameTag ? parts[6] : usesPresetIndex ? parts[5] : parts[4];

  // Verify user
  if (userId !== interaction.user.id) {
    await interaction.reply({
      content: "❌ This modal belongs to another user.",
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
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        await handleRenamePresetModal(
          interaction,
          presetIndex,
          nameTag,
          userId,
        );
        break;
      default:
        await interaction.reply({
          content: "❌ Unknown modal action.",
          flags: MessageFlags.Ephemeral,
        });
    }
  } catch (error) {
    logger.error("Error handling VC modal:", error);
    await safeReply(interaction, {
      content: "❌ An error occurred while processing your request.",
      flags: MessageFlags.Ephemeral,
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
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (newName.length < 1) {
    await interaction.reply({
      content: "❌ Channel name cannot be empty.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    const channel = await interaction.guild?.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) {
      await interaction.reply({
        content: "❌ Voice channel not found.",
        flags: MessageFlags.Ephemeral,
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
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    logger.error("Error renaming channel:", error);
    await safeReply(interaction, {
      content: "❌ Failed to rename channel. Please try again.",
      flags: MessageFlags.Ephemeral,
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
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const presetName = interaction.fields.getTextInputValue("name");

  const channel = await interaction.guild?.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildVoice) {
    await interaction.reply({
      content: "❌ Voice channel not found.",
      flags: MessageFlags.Ephemeral,
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
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    if (error instanceof VoicePrefsValidationError) {
      await safeReply(interaction, {
        content: `❌ ${error.message}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    throw error;
  }
}

async function handleRenamePresetModal(
  interaction: ModalSubmitInteraction,
  presetIndex: number,
  nameTag: string | null,
  userId: string,
): Promise<void> {
  const enabled = await configService.getBoolean(
    "voicechannels.presets.enabled",
    false,
  );
  if (!enabled) {
    await interaction.reply({
      content: "❌ Presets are disabled on this server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const newName = interaction.fields.getTextInputValue("name");
  const service = UserVoicePrefsService.getInstance();

  // Staleness guard: the modal's custom ID carries a fingerprint of the
  // preset name shown when the modal opened. If the list shifted before
  // submit (delete/rename from another panel, device, or the web UI), the
  // index would now point at a different preset — refuse instead of
  // renaming the wrong one.
  const prefs = await service.getPrefs(userId);
  const target = prefs.presets[presetIndex];
  if (!target || (nameTag !== null && presetNameTag(target.name) !== nameTag)) {
    await interaction.reply({
      content:
        "❌ Your presets changed since this dialog was opened — reopen the panel and try again.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    const { oldName, newName: savedName } = await service.renamePreset(
      userId,
      presetIndex,
      newName,
      target.name,
    );

    await interaction.reply({
      content: `✏️ Preset **${oldName}** renamed to **${savedName}**.`,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    if (error instanceof VoicePrefsValidationError) {
      await safeReply(interaction, {
        content: `❌ ${error.message}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    throw error;
  }
}
