import { ModalSubmitInteraction, ChannelType, MessageFlags } from "discord.js";
import logger from "../utils/logger.js";
import { safeReply } from "../utils/safe-reply.js";
import {
  replyWithError,
  replyWithUnexpectedError,
} from "../utils/error-reply.js";
import { escapeDisplayText } from "../utils/allowed-mentions.js";
import { VoiceChannelManager } from "../services/voice-channel-manager.js";
import { ConfigService } from "../services/config-service.js";
import {
  UserVoicePrefsService,
  VoicePrefsValidationError,
} from "../services/user-voice-prefs-service.js";
import { presetNameTag } from "./vc-preset-handler.js";
import {
  VC_CHANNEL_GONE,
  VC_NOT_OWNER,
  VC_OUT_OF_DATE,
  VC_PRESETS_OFF,
} from "./vc-errors.js";

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
    await replyWithError(interaction, VC_OUT_OF_DATE);
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
    await replyWithError(interaction, {
      title: "This form belongs to someone else",
      next: "Open your own from the controls in your channel.",
    });
    return;
  }

  // Acknowledge before any slow work: the room-mutating actions can queue
  // behind an in-flight ownership transfer holding the room lock, which can
  // outlast Discord's 3-second window (10062). Every reply below goes through
  // safeReply, which edits the deferred response.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Get the voice channel
  const channel = await interaction.guild?.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildVoice) {
    await replyWithError(interaction, VC_CHANNEL_GONE);
    return;
  }

  try {
    switch (action) {
      case "name":
        await asLiveOwner(interaction, channelId, () =>
          handleNameModal(interaction, channelId),
        );
        break;
      case "savepreset":
        await asLiveOwner(interaction, channelId, () =>
          handleSavePresetModal(interaction, channelId, userId),
        );
        break;
      case "renamepreset":
        if (presetIndex === null || !Number.isInteger(presetIndex)) {
          await replyWithError(interaction, VC_OUT_OF_DATE);
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
        await replyWithError(interaction, VC_OUT_OF_DATE);
    }
  } catch (error) {
    logger.error("Error handling VC modal:", error);
    await replyWithUnexpectedError(interaction);
  }
}

/**
 * The userId in a modal's customId only proves the modal was opened by this
 * user, not that they still own the room (a transfer can happen while the
 * modal is open). Re-check live ownership before touching the room (#1143).
 */
async function asLiveOwner(
  interaction: ModalSubmitInteraction,
  channelId: string,
  work: () => Promise<void>,
): Promise<void> {
  // Authorise and mutate inside one serialised, ownership-checked operation:
  // a transfer cannot land between the check and the rename (#1143).
  const manager = VoiceChannelManager.getInstance(interaction.client);
  const ran = await manager.runAsRoomOwner(
    interaction.user.id,
    channelId,
    work,
  );
  if (!ran) {
    await replyWithError(interaction, {
      title: "Only the room owner can do this",
      next: VC_NOT_OWNER.next,
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
    await replyWithError(interaction, {
      title: "That channel name is too long",
      next: "Use 100 characters or fewer, then submit again.",
    });
    return;
  }

  if (newName.length < 1) {
    await replyWithError(interaction, {
      title: "The channel name is empty",
      next: "Type a name, then submit again.",
    });
    return;
  }

  // The lobby's name (and the offline lobby / "New Channel" names) are
  // reserved: a room carrying one could be mistaken for the lobby (#1148).
  const manager = VoiceChannelManager.getInstance(interaction.client);
  if (await manager.isReservedChannelName(newName)) {
    await replyWithError(interaction, {
      title: "That channel name is reserved",
      next: "Choose a different name, then submit again.",
    });
    return;
  }

  try {
    const channel = await interaction.guild?.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) {
      await replyWithError(interaction, VC_CHANNEL_GONE);
      return;
    }

    const oldName = channel.name;
    await channel.setName(newName);

    // Mark this channel as having a custom name
    manager.setCustomChannelName(channelId, newName);

    logger.info(
      `User ${interaction.user.displayName || interaction.user.username} (${interaction.user.id}) renamed channel "${oldName}" → "${newName}" (${channelId})`,
    );

    await safeReply(interaction, {
      content: `✅ Channel renamed to: **${escapeDisplayText(newName)}**`,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    logger.error("Error renaming channel:", error);
    await replyWithUnexpectedError(interaction);
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
    await replyWithError(interaction, VC_PRESETS_OFF);
    return;
  }

  const presetName = interaction.fields.getTextInputValue("name");

  const channel = await interaction.guild?.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildVoice) {
    await replyWithError(interaction, VC_CHANNEL_GONE);
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

    await safeReply(interaction, {
      content: updated
        ? `✅ Preset **${escapeDisplayText(name)}** updated from this channel's settings.`
        : `✅ Preset **${escapeDisplayText(name)}** saved.`,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    if (error instanceof VoicePrefsValidationError) {
      // Only VoicePrefsValidationError reaches here: its messages are
      // written for members. Any other error is rethrown to the catch-all.
      await replyWithError(interaction, {
        title: "Couldn't save the preset",
        next: escapeDisplayText(error.message),
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
    await replyWithError(interaction, VC_PRESETS_OFF);
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
    await replyWithError(interaction, {
      title: "Your presets changed",
      next: "Reopen the presets panel and try again.",
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

    await safeReply(interaction, {
      content: `✏️ Preset **${escapeDisplayText(oldName)}** renamed to **${escapeDisplayText(savedName)}**.`,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    if (error instanceof VoicePrefsValidationError) {
      // Only VoicePrefsValidationError reaches here: its messages are
      // written for members. Any other error is rethrown to the catch-all.
      await replyWithError(interaction, {
        title: "Couldn't rename the preset",
        next: escapeDisplayText(error.message),
      });
      return;
    }
    throw error;
  }
}
