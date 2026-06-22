import {
  ButtonInteraction,
  StringSelectMenuInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  VoiceChannel,
  ChannelType,
  MessageFlags,
} from "discord.js";
import logger from "../utils/logger.js";
import { ConfigService } from "../services/config-service.js";
import {
  UserVoicePreferences,
  IChannelPreset,
  IUserVoicePreferences,
} from "../models/user-voice-preferences.js";
import {
  UserVoicePrefsService,
  VoicePrefsValidationError,
} from "../services/user-voice-prefs-service.js";

const configService = ConfigService.getInstance();

type ParsedId = {
  action: string;
  presetIndex: number | null;
  channelId: string;
  ownerId: string;
};

function parseCustomId(customId: string): ParsedId | null {
  // Forms:
  //   vc_preset_{action}_{channelId}_{ownerId}                    (5 parts)
  //   vc_preset_{action}_{presetIndex}_{channelId}_{ownerId}      (6 parts)
  const parts = customId.split("_");
  if (parts[0] !== "vc" || parts[1] !== "preset") return null;

  const action = parts[2];
  if (!action) return null;

  if (parts.length === 5) {
    return {
      action,
      presetIndex: null,
      channelId: parts[3],
      ownerId: parts[4],
    };
  }
  if (parts.length === 6) {
    const idx = Number(parts[3]);
    if (!Number.isInteger(idx) || idx < 0) return null;
    return {
      action,
      presetIndex: idx,
      channelId: parts[4],
      ownerId: parts[5],
    };
  }
  return null;
}

async function presetsEnabled(): Promise<boolean> {
  return await configService.getBoolean("voicechannels.presets.enabled", false);
}

async function maxPerUser(): Promise<number> {
  return await configService.getNumber("voicechannels.presets.max_per_user", 3);
}

async function loadPrefs(userId: string): Promise<IUserVoicePreferences> {
  return (
    (await UserVoicePreferences.findOne({ userId })) ??
    (await UserVoicePreferences.create({ userId, presets: [] }))
  );
}

function presetSummary(p: IChannelPreset): string {
  const bits: string[] = [];
  if (p.channelName) bits.push(`name "${p.channelName}"`);
  if (typeof p.userLimit === "number")
    bits.push(p.userLimit === 0 ? "no limit" : `limit ${p.userLimit}`);
  if (typeof p.bitrate === "number") bits.push(`${p.bitrate}kbps`);
  return bits.length ? bits.join(" · ") : "(empty)";
}

function buildApplyPanel(
  presets: IChannelPreset[],
  channelId: string,
  ownerId: string,
): {
  embed: EmbedBuilder;
  components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[];
} {
  const embed = new EmbedBuilder()
    .setTitle("🎛️ Voice Channel Presets")
    .setColor(0x5865f2)
    .setDescription(
      presets.length === 0
        ? "You have no saved presets yet. Configure your channel and click **Save current as preset** below."
        : presets
            .map(
              (p, i) =>
                `**${i + 1}. ${p.name}** ${p.isDefault ? "⭐" : ""}\n  ${presetSummary(p)}`,
            )
            .join("\n"),
    )
    .setFooter({
      text: "⭐ default preset auto-applies when you spawn a new channel",
    });

  const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];

  if (presets.length > 0) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`vc_preset_apply_${channelId}_${ownerId}`)
      .setPlaceholder("Apply a preset to this channel…")
      .addOptions(
        presets.slice(0, 25).map((p, i) => ({
          label: p.isDefault ? `⭐ ${p.name}` : p.name,
          description: presetSummary(p).slice(0, 100),
          value: String(i),
        })),
      );
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
    );
  }

  const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`vc_preset_save_${channelId}_${ownerId}`)
      .setLabel("Save current as preset")
      .setStyle(ButtonStyle.Success)
      .setEmoji("💾"),
    new ButtonBuilder()
      .setCustomId(`vc_preset_manage_${channelId}_${ownerId}`)
      .setLabel("Manage…")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("🗑️")
      .setDisabled(presets.length === 0),
  );
  rows.push(actionRow);

  return { embed, components: rows };
}

function buildManagePanel(
  presets: IChannelPreset[],
  channelId: string,
  ownerId: string,
  selectedIndex: number | null,
): {
  embed: EmbedBuilder;
  components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[];
} {
  const selected =
    selectedIndex !== null && selectedIndex >= 0
      ? presets[selectedIndex]
      : null;

  const embed = new EmbedBuilder()
    .setTitle("🎛️ Manage Presets")
    .setColor(0xed4245)
    .setDescription(
      selected
        ? `Selected: **${selected.name}** ${selected.isDefault ? "⭐" : ""}\n${presetSummary(selected)}`
        : "Pick a preset below to rename, delete, or set as default.",
    );

  const select = new StringSelectMenuBuilder()
    .setCustomId(`vc_preset_pick_${channelId}_${ownerId}`)
    .setPlaceholder("Choose a preset to manage…")
    .addOptions(
      presets.slice(0, 25).map((p, i) => ({
        label: p.isDefault ? `⭐ ${p.name}` : p.name,
        description: presetSummary(p).slice(0, 100),
        value: String(i),
        default: i === selectedIndex,
      })),
    );

  const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
  ];

  const idx = selectedIndex ?? 0;
  const disabled = selected === null;
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`vc_preset_default_${idx}_${channelId}_${ownerId}`)
        .setLabel(selected?.isDefault ? "Unset default" : "Set as default")
        .setStyle(ButtonStyle.Primary)
        .setEmoji("⭐")
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`vc_preset_rename_${idx}_${channelId}_${ownerId}`)
        .setLabel("Rename")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("✏️")
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`vc_preset_delete_${idx}_${channelId}_${ownerId}`)
        .setLabel("Delete")
        .setStyle(ButtonStyle.Danger)
        .setEmoji("🗑️")
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`vc_preset_back_${channelId}_${ownerId}`)
        .setLabel("Back")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("⬅️"),
    ),
  );

  return { embed, components: rows };
}

async function ensureOwnership(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  parsed: ParsedId,
): Promise<VoiceChannel | null> {
  if (interaction.user.id !== parsed.ownerId) {
    await interaction.reply({
      content: "❌ Only the channel owner can use these controls.",
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }
  const channel = await interaction.guild?.channels.fetch(parsed.channelId);
  if (!channel || channel.type !== ChannelType.GuildVoice) {
    await interaction.reply({
      content: "❌ Voice channel not found.",
      flags: MessageFlags.Ephemeral,
    });
    return null;
  }
  return channel as VoiceChannel;
}

export async function handleVCPresetButton(
  interaction: ButtonInteraction,
): Promise<void> {
  if (!(await presetsEnabled())) {
    await interaction.reply({
      content: "❌ Presets are disabled on this server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const parsed = parseCustomId(interaction.customId);
  if (!parsed) {
    await interaction.reply({
      content: "❌ Invalid preset interaction.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channel = await ensureOwnership(interaction, parsed);
  if (!channel) return;

  try {
    switch (parsed.action) {
      case "open":
        return await openPanel(interaction, parsed);
      case "save":
        return await openSaveModal(interaction, parsed, channel);
      case "manage":
        return await switchToManage(interaction, parsed, null);
      case "back":
        return await switchToApply(interaction, parsed);
      case "default":
        return await toggleDefault(interaction, parsed);
      case "rename":
        return await openRenameModal(interaction, parsed);
      case "delete":
        return await deletePreset(interaction, parsed);
      default:
        await interaction.reply({
          content: "❌ Unknown preset action.",
          flags: MessageFlags.Ephemeral,
        });
    }
  } catch (error) {
    logger.error("Error handling VC preset button:", error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "❌ An error occurred while processing your request.",
        flags: MessageFlags.Ephemeral,
      });
    }
  }
}

export async function handleVCPresetSelect(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  if (!(await presetsEnabled())) {
    await interaction.reply({
      content: "❌ Presets are disabled on this server.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const parsed = parseCustomId(interaction.customId);
  if (!parsed) {
    await interaction.reply({
      content: "❌ Invalid preset interaction.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const channel = await ensureOwnership(interaction, parsed);
  if (!channel) return;

  try {
    const idx = Number(interaction.values[0]);
    if (!Number.isInteger(idx) || idx < 0) {
      await interaction.reply({
        content: "❌ Invalid preset selected.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (parsed.action === "apply") {
      return await applyPreset(interaction, parsed, channel, idx);
    }
    if (parsed.action === "pick") {
      return await switchToManage(interaction, parsed, idx);
    }

    await interaction.reply({
      content: "❌ Unknown preset action.",
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    logger.error("Error handling VC preset select:", error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "❌ An error occurred while processing your request.",
        flags: MessageFlags.Ephemeral,
      });
    }
  }
}

async function openPanel(
  interaction: ButtonInteraction,
  parsed: ParsedId,
): Promise<void> {
  const prefs = await loadPrefs(parsed.ownerId);
  const { embed, components } = buildApplyPanel(
    prefs.presets,
    parsed.channelId,
    parsed.ownerId,
  );
  await interaction.reply({
    embeds: [embed],
    components,
    flags: MessageFlags.Ephemeral,
  });
}

async function switchToApply(
  interaction: ButtonInteraction,
  parsed: ParsedId,
): Promise<void> {
  const prefs = await loadPrefs(parsed.ownerId);
  const { embed, components } = buildApplyPanel(
    prefs.presets,
    parsed.channelId,
    parsed.ownerId,
  );
  await interaction.update({ embeds: [embed], components });
}

async function switchToManage(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  parsed: ParsedId,
  selectedIndex: number | null,
): Promise<void> {
  const prefs = await loadPrefs(parsed.ownerId);
  if (prefs.presets.length === 0) {
    await interaction.reply({
      content: "❌ You don't have any presets yet.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const { embed, components } = buildManagePanel(
    prefs.presets,
    parsed.channelId,
    parsed.ownerId,
    selectedIndex,
  );
  await interaction.update({ embeds: [embed], components });
}

async function openSaveModal(
  interaction: ButtonInteraction,
  parsed: ParsedId,
  channel: VoiceChannel,
): Promise<void> {
  const prefs = await loadPrefs(parsed.ownerId);
  const max = await maxPerUser();
  if (prefs.presets.length >= max) {
    await interaction.reply({
      content: `❌ You already have ${max} presets (the configured maximum). Delete one first.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`vc_modal_savepreset_${parsed.channelId}_${parsed.ownerId}`)
    .setTitle("Save preset");
  const nameInput = new TextInputBuilder()
    .setCustomId("name")
    .setLabel("Preset name")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("e.g. Squad night")
    .setRequired(true)
    .setMaxLength(50)
    .setValue(channel.name.slice(0, 50));

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput),
  );
  await interaction.showModal(modal);
}

async function openRenameModal(
  interaction: ButtonInteraction,
  parsed: ParsedId,
): Promise<void> {
  if (parsed.presetIndex === null) {
    await interaction.reply({
      content: "❌ No preset selected.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const prefs = await loadPrefs(parsed.ownerId);
  const preset = prefs.presets[parsed.presetIndex];
  if (!preset) {
    await interaction.reply({
      content: "❌ Preset no longer exists.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(
      `vc_modal_renamepreset_${parsed.presetIndex}_${parsed.channelId}_${parsed.ownerId}`,
    )
    .setTitle("Rename preset");
  const nameInput = new TextInputBuilder()
    .setCustomId("name")
    .setLabel("New preset name")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(50)
    .setValue(preset.name);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput),
  );
  await interaction.showModal(modal);
}

async function toggleDefault(
  interaction: ButtonInteraction,
  parsed: ParsedId,
): Promise<void> {
  if (parsed.presetIndex === null) return;
  let result: { name: string; isDefault: boolean };
  try {
    result = await UserVoicePrefsService.getInstance().setDefault(
      parsed.ownerId,
      parsed.presetIndex,
    );
  } catch (error) {
    // Only the known "missing preset" validation case becomes a friendly
    // reply here; unexpected errors (DB/Discord) propagate to the outer
    // handler so they're logged and surfaced generically.
    if (error instanceof VoicePrefsValidationError) {
      await interaction.reply({
        content: `❌ ${error.message}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    throw error;
  }

  await switchToManage(interaction, parsed, parsed.presetIndex);
  await interaction.followUp({
    content: result.isDefault
      ? `⭐ **${result.name}** will auto-apply on your next channel.`
      : `⭐ **${result.name}** is no longer the default.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function deletePreset(
  interaction: ButtonInteraction,
  parsed: ParsedId,
): Promise<void> {
  if (parsed.presetIndex === null) return;
  let removed: { name: string; remaining: number };
  try {
    removed = await UserVoicePrefsService.getInstance().deletePreset(
      parsed.ownerId,
      parsed.presetIndex,
    );
  } catch (error) {
    // As in toggleDefault: translate only the known validation/missing case;
    // rethrow unexpected errors for the outer handler to log and report.
    if (error instanceof VoicePrefsValidationError) {
      await interaction.reply({
        content: `❌ ${error.message}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    throw error;
  }

  if (removed.remaining === 0) {
    await switchToApply(interaction, parsed);
  } else {
    await switchToManage(interaction, parsed, null);
  }
  await interaction.followUp({
    content: `🗑️ Deleted preset **${removed.name}**.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function applyPreset(
  interaction: StringSelectMenuInteraction,
  parsed: ParsedId,
  channel: VoiceChannel,
  index: number,
): Promise<void> {
  const prefs = await loadPrefs(parsed.ownerId);
  const preset = prefs.presets[index];
  if (!preset) {
    await interaction.reply({
      content: "❌ Preset no longer exists.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await applyPresetToChannel(channel, preset);

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setTitle("✅ Preset applied")
        .setColor(0x57f287)
        .setDescription(
          `**${preset.name}** applied to this channel.\n${presetSummary(preset)}`,
        ),
    ],
    components: [],
  });
}

export async function applyPresetToChannel(
  channel: VoiceChannel,
  preset: IChannelPreset,
): Promise<void> {
  if (preset.channelName && preset.channelName !== channel.name) {
    try {
      await channel.setName(preset.channelName.slice(0, 100));
    } catch (error) {
      logger.warn(
        `Failed to set channel name from preset on ${channel.id}:`,
        error,
      );
    }
  }
  if (typeof preset.userLimit === "number") {
    try {
      await channel.setUserLimit(preset.userLimit);
    } catch (error) {
      logger.warn(
        `Failed to set user limit from preset on ${channel.id}:`,
        error,
      );
    }
  }
  if (typeof preset.bitrate === "number") {
    try {
      await channel.setBitrate(preset.bitrate * 1000);
    } catch (error) {
      logger.warn(`Failed to set bitrate from preset on ${channel.id}:`, error);
    }
  }
}

export async function getDefaultPreset(
  userId: string,
): Promise<IChannelPreset | null> {
  const prefs = await UserVoicePreferences.findOne({ userId }).lean();
  if (!prefs?.presets) return null;
  return prefs.presets.find((p) => p.isDefault) ?? null;
}
