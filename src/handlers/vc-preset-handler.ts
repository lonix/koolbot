import { createHash } from "node:crypto";
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
import { escapeDisplayText } from "../utils/allowed-mentions.js";
import { safeReply } from "../utils/safe-reply.js";
import { VoiceChannelManager } from "../services/voice-channel-manager.js";
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
import { embedColor } from "../utils/embed-style.js";

const configService = ConfigService.getInstance();

/**
 * Short fingerprint of a preset name, embedded in preset-targeting custom
 * IDs. The full name can't ride in the ID itself — it may contain the `_`
 * delimiter, and 50 name chars next to two snowflakes would overflow
 * Discord's 100-char custom-ID limit — so panels embed this tag at render
 * time and action handlers verify it against the preset currently at the
 * index. This is the Discord-surface counterpart of the `expectedName`
 * guard the web forms thread through `UserVoicePrefsService`.
 */
export function presetNameTag(name: string): string {
  return createHash("sha256").update(name).digest("hex").slice(0, 8);
}

type ParsedId = {
  action: string;
  presetIndex: number | null;
  nameTag: string | null;
  channelId: string;
  ownerId: string;
};

function parseCustomId(customId: string): ParsedId | null {
  // Forms:
  //   vc_preset_{action}_{channelId}_{ownerId}                            (5 parts)
  //   vc_preset_{action}_{presetIndex}_{channelId}_{ownerId}              (6 parts, legacy in-flight panels)
  //   vc_preset_{action}_{presetIndex}_{nameTag}_{channelId}_{ownerId}    (7 parts)
  const parts = customId.split("_");
  if (parts[0] !== "vc" || parts[1] !== "preset") return null;

  const action = parts[2];
  if (!action) return null;

  if (parts.length === 5) {
    return {
      action,
      presetIndex: null,
      nameTag: null,
      channelId: parts[3],
      ownerId: parts[4],
    };
  }
  if (parts.length === 6 || parts.length === 7) {
    const idx = Number(parts[3]);
    if (!Number.isInteger(idx) || idx < 0) return null;
    const hasTag = parts.length === 7;
    return {
      action,
      presetIndex: idx,
      nameTag: hasTag ? parts[4] : null,
      channelId: parts[hasTag ? 5 : 4],
      ownerId: parts[hasTag ? 6 : 5],
    };
  }
  return null;
}

async function presetsEnabled(): Promise<boolean> {
  return await configService.getBoolean("voicechannels.presets.enabled", false);
}

async function loadPrefs(userId: string): Promise<IUserVoicePreferences> {
  return (
    (await UserVoicePreferences.findOne({ userId })) ??
    (await UserVoicePreferences.create({ userId, presets: [] }))
  );
}

/**
 * One-line description of a preset. `markdown: true` for embed text, where the
 * member-chosen channel name must not render as a mention or link; leave it off
 * for select-menu descriptions, which are plain text.
 */
function presetSummary(p: IChannelPreset, markdown = false): string {
  const bits: string[] = [];
  if (p.channelName) {
    bits.push(
      `name "${markdown ? escapeDisplayText(p.channelName) : p.channelName}"`,
    );
  }
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
    .setColor(embedColor("brand"))
    .setDescription(
      presets.length === 0
        ? "You have no saved presets yet. Configure your channel and click **Save current as preset** below."
        : presets
            .map(
              (p, i) =>
                `**${i + 1}. ${escapeDisplayText(p.name)}** ${p.isDefault ? "⭐" : ""}\n  ${presetSummary(p, true)}`,
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
    .setColor(embedColor("danger"))
    .setDescription(
      selected
        ? `Selected: **${escapeDisplayText(selected.name)}** ${selected.isDefault ? "⭐" : ""}\n${presetSummary(selected, true)}`
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
  // The tag pins each action button to the preset name shown when this
  // panel rendered; "0" is a placeholder for the disabled (no selection)
  // state and never reaches an action handler.
  const tag = selected ? presetNameTag(selected.name) : "0";
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`vc_preset_default_${idx}_${tag}_${channelId}_${ownerId}`)
        .setLabel(selected?.isDefault ? "Unset default" : "Set as default")
        .setStyle(ButtonStyle.Primary)
        .setEmoji("⭐")
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`vc_preset_rename_${idx}_${tag}_${channelId}_${ownerId}`)
        .setLabel("Rename")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("✏️")
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`vc_preset_delete_${idx}_${tag}_${channelId}_${ownerId}`)
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

/**
 * Live-ownership check that needs no I/O: the customId's ownerId is only a
 * hint, so require the in-memory room owner too (#1143). Safe to answer with a
 * direct `reply` before any acknowledgement.
 */
function isLiveOwner(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  parsed: ParsedId,
): boolean {
  return (
    interaction.user.id === parsed.ownerId &&
    VoiceChannelManager.getInstance(interaction.client).isRoomOwner(
      interaction.user.id,
      parsed.channelId,
    )
  );
}

const NOT_OWNER_MESSAGE =
  "❌ Only the current channel owner can use these controls.";

/**
 * Fetch the room's voice channel. Returns null when it is gone, after telling
 * the member through `fail` (a direct reply before an acknowledgement, a panel
 * replacement after one).
 */
async function fetchVoiceChannel(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  parsed: ParsedId,
  fail: (content: string) => Promise<void>,
): Promise<VoiceChannel | null> {
  const channel = await interaction.guild?.channels.fetch(parsed.channelId);
  if (!channel || channel.type !== ChannelType.GuildVoice) {
    await fail("❌ Voice channel not found.");
    return null;
  }
  return channel as VoiceChannel;
}

/**
 * Answer with an error. Before an acknowledgement this is an ephemeral reply;
 * after one (`defer*`) the panel is replaced with the message, as `applyPreset`
 * does. Never throws, so it is safe inside a catch block.
 */
async function replyError(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  content: string,
): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    try {
      await interaction.editReply({ content, embeds: [], components: [] });
    } catch (error) {
      logger.error("Failed to replace the preset panel with an error:", error);
    }
    return;
  }
  await safeReply(interaction, { content, flags: MessageFlags.Ephemeral });
}

/** Show a panel by editing the acknowledged message (or `update` when not yet acknowledged). */
async function showPanel(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  panel: {
    embed: EmbedBuilder;
    components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[];
  },
): Promise<void> {
  const payload = { embeds: [panel.embed], components: panel.components };
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload);
  } else {
    await interaction.update(payload);
  }
}

const PANEL_ACTIONS = new Set(["open", "manage", "back", "default", "delete"]);
const MODAL_ACTIONS = new Set(["save", "rename"]);

export async function handleVCPresetButton(
  interaction: ButtonInteraction,
): Promise<void> {
  // Parse and authorise without I/O, so the acknowledgement below is the first
  // await. Discord drops an interaction left unanswered for 3 seconds (10062).
  const parsed = parseCustomId(interaction.customId);
  if (!parsed) {
    await interaction.reply({
      content: "❌ Invalid preset interaction.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!isLiveOwner(interaction, parsed)) {
    await interaction.reply({
      content: NOT_OWNER_MESSAGE,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const isModal = MODAL_ACTIONS.has(parsed.action);
  if (!PANEL_ACTIONS.has(parsed.action) && !isModal) {
    await interaction.reply({
      content: "❌ Unknown preset action.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // A modal must be the first response, so those two actions cannot defer and
  // await nothing slow before it: no config read, no channel fetch, no database
  // (the enabled gate, channel check, limit and staleness checks run on submit
  // in vc-modal-handler, which already defers and re-checks).
  if (isModal) {
    try {
      if (parsed.action === "save") {
        await openSaveModal(interaction, parsed);
      } else {
        await openRenameModal(interaction, parsed);
      }
    } catch (error) {
      logger.error("Error handling VC preset button:", error);
      await replyError(
        interaction,
        "❌ An error occurred while processing your request.",
      );
    }
    return;
  }

  // Panel actions acknowledge first: "open" posts a new ephemeral panel, the
  // rest edit the one that was clicked.
  if (parsed.action === "open") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  } else {
    await interaction.deferUpdate();
  }

  try {
    if (!(await presetsEnabled())) {
      await replyError(interaction, "❌ Presets are disabled on this server.");
      return;
    }

    const channel = await fetchVoiceChannel(interaction, parsed, (content) =>
      replyError(interaction, content),
    );
    if (!channel) return;

    switch (parsed.action) {
      case "open":
        return await openPanel(interaction, parsed);
      case "manage":
        return await switchToManage(interaction, parsed, null);
      case "back":
        return await switchToApply(interaction, parsed);
      case "default":
        return await toggleDefault(interaction, parsed);
      case "delete":
        return await deletePreset(interaction, parsed);
    }
  } catch (error) {
    logger.error("Error handling VC preset button:", error);
    await replyError(
      interaction,
      "❌ An error occurred while processing your request.",
    );
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

  if (!isLiveOwner(interaction, parsed)) {
    await interaction.reply({
      content: NOT_OWNER_MESSAGE,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const channel = await fetchVoiceChannel(interaction, parsed, (content) =>
    replyError(interaction, content),
  );
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
    await safeReply(interaction, {
      content: "❌ An error occurred while processing your request.",
      flags: MessageFlags.Ephemeral,
    });
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
  // Already acknowledged with deferReply (ephemeral) by the button handler
  await interaction.editReply({ embeds: [embed], components });
}

async function switchToApply(
  interaction: ButtonInteraction,
  parsed: ParsedId,
): Promise<void> {
  const prefs = await loadPrefs(parsed.ownerId);
  await showPanel(
    interaction,
    buildApplyPanel(prefs.presets, parsed.channelId, parsed.ownerId),
  );
}

async function switchToManage(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  parsed: ParsedId,
  selectedIndex: number | null,
): Promise<void> {
  const prefs = await loadPrefs(parsed.ownerId);
  if (prefs.presets.length === 0) {
    await replyError(interaction, "❌ You don't have any presets yet.");
    return;
  }
  await showPanel(
    interaction,
    buildManagePanel(
      prefs.presets,
      parsed.channelId,
      parsed.ownerId,
      selectedIndex,
    ),
  );
}

async function openSaveModal(
  interaction: ButtonInteraction,
  parsed: ParsedId,
): Promise<void> {
  // Nothing slow here: a modal has to be the first response. The enabled gate,
  // channel check and preset limit run on submit (vc-modal-handler). The name
  // prefill uses only the cached channel and is skipped on a cache miss.
  const cached = interaction.guild?.channels.cache?.get(parsed.channelId);
  const modal = new ModalBuilder()
    .setCustomId(`vc_modal_savepreset_${parsed.channelId}_${parsed.ownerId}`)
    .setTitle("Save preset");
  const nameInput = new TextInputBuilder()
    .setCustomId("name")
    .setLabel("Preset name")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("e.g. Squad night")
    .setRequired(true)
    .setMaxLength(50);
  if (cached?.type === ChannelType.GuildVoice) {
    nameInput.setValue(cached.name.slice(0, 50));
  }

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput),
  );
  await interaction.showModal(modal);
}

/**
 * Re-load the preset a preset-targeting component points at and verify its
 * name still matches the fingerprint captured when the panel rendered.
 * Replies with a staleness error and returns null when the list shifted
 * underneath the panel (preset deleted/renamed via another panel, device,
 * or the web UI) so the action can't silently hit the wrong preset.
 */
async function resolveTargetPreset(
  interaction: ButtonInteraction,
  parsed: ParsedId,
): Promise<IChannelPreset | null> {
  const prefs = await loadPrefs(parsed.ownerId);
  const preset =
    parsed.presetIndex !== null ? prefs.presets[parsed.presetIndex] : undefined;
  if (
    !preset ||
    (parsed.nameTag !== null && presetNameTag(preset.name) !== parsed.nameTag)
  ) {
    await replyError(
      interaction,
      "❌ Your presets changed since this panel was opened — reopen it and try again.",
    );
    return null;
  }
  return preset;
}

async function openRenameModal(
  interaction: ButtonInteraction,
  parsed: ParsedId,
): Promise<void> {
  // No database read: the manage panel put the preset's name tag on this
  // button's custom id, and the submit (vc-modal-handler) verifies it against
  // the preset at the index. Buttons from before tags existed carry none, so
  // they cannot be checked at submit and are refused.
  if (parsed.presetIndex === null || parsed.nameTag === null) {
    await interaction.reply({
      content:
        parsed.presetIndex === null
          ? "❌ No preset selected."
          : "❌ Your presets changed since this panel was opened — reopen it and try again.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(
      `vc_modal_renamepreset_${parsed.presetIndex}_${parsed.nameTag}_${parsed.channelId}_${parsed.ownerId}`,
    )
    .setTitle("Rename preset");
  const nameInput = new TextInputBuilder()
    .setCustomId("name")
    .setLabel("New preset name")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(50);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput),
  );
  await interaction.showModal(modal);
}

async function toggleDefault(
  interaction: ButtonInteraction,
  parsed: ParsedId,
): Promise<void> {
  if (parsed.presetIndex === null) {
    await replyError(interaction, "❌ No preset selected.");
    return;
  }
  const target = await resolveTargetPreset(interaction, parsed);
  if (!target) return;
  let result: { name: string; isDefault: boolean };
  try {
    // Passing the just-verified name as expectedName lets the service
    // re-check it at write time, closing the read→write race window.
    result = await UserVoicePrefsService.getInstance().setDefault(
      parsed.ownerId,
      parsed.presetIndex,
      target.name,
    );
  } catch (error) {
    // Only the known "missing preset" validation case becomes a friendly
    // reply here; unexpected errors (DB/Discord) propagate to the outer
    // handler so they're logged and surfaced generically.
    if (error instanceof VoicePrefsValidationError) {
      await replyError(interaction, `❌ ${error.message}`);
      return;
    }
    throw error;
  }

  await switchToManage(interaction, parsed, parsed.presetIndex);
  await interaction.followUp({
    content: result.isDefault
      ? `⭐ **${escapeDisplayText(result.name)}** will auto-apply on your next channel.`
      : `⭐ **${escapeDisplayText(result.name)}** is no longer the default.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function deletePreset(
  interaction: ButtonInteraction,
  parsed: ParsedId,
): Promise<void> {
  if (parsed.presetIndex === null) {
    await replyError(interaction, "❌ No preset selected.");
    return;
  }
  const target = await resolveTargetPreset(interaction, parsed);
  if (!target) return;
  let removed: { name: string; remaining: number };
  try {
    removed = await UserVoicePrefsService.getInstance().deletePreset(
      parsed.ownerId,
      parsed.presetIndex,
      target.name,
    );
  } catch (error) {
    // As in toggleDefault: translate only the known validation/missing case;
    // rethrow unexpected errors for the outer handler to log and report.
    if (error instanceof VoicePrefsValidationError) {
      await replyError(interaction, `❌ ${error.message}`);
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
    content: `🗑️ Deleted preset **${escapeDisplayText(removed.name)}**.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function applyPreset(
  interaction: StringSelectMenuInteraction,
  parsed: ParsedId,
  channel: VoiceChannel,
  index: number,
): Promise<void> {
  // Acknowledge before the DB read and the possibly queued locked apply, which
  // can outlast Discord's 3-second window (10062). The result edits the
  // deferred message in place.
  await interaction.deferUpdate();
  const prefs = await loadPrefs(parsed.ownerId);
  const preset = prefs.presets[index];
  if (!preset) {
    await interaction.editReply({
      content: "❌ Preset no longer exists.",
      embeds: [],
      components: [],
    });
    return;
  }

  // Apply under the room lock with ownership re-checked inside it, so a
  // transfer that landed after ensureOwnership cannot let a former owner
  // reconfigure the new owner's room (#1143).
  const manager = VoiceChannelManager.getInstance(interaction.client);
  let nameSkipped = false;
  const ran = await manager.runAsRoomOwner(
    interaction.user.id,
    parsed.channelId,
    async () => {
      const result = await applyPresetToChannel(channel, preset, (name) =>
        manager.isReservedChannelName(name),
      );
      nameSkipped = result.nameSkipped;
    },
  );
  if (!ran) {
    await interaction.editReply({
      content: "❌ Only the current channel owner can use these controls.",
      embeds: [],
      components: [],
    });
    return;
  }

  // Do not claim a skipped (reserved) channel name was applied
  const applied = nameSkipped ? { ...preset, channelName: undefined } : preset;
  await interaction.editReply({
    content: "",
    embeds: [
      new EmbedBuilder()
        .setTitle("✅ Preset applied")
        .setColor(embedColor("ok"))
        .setDescription(
          `**${escapeDisplayText(preset.name)}** applied to this channel.\n${presetSummary(applied as IChannelPreset, true)}` +
            (nameSkipped
              ? "\n⚠️ The preset's channel name is reserved, so the name was not changed."
              : ""),
        ),
    ],
    components: [],
  });
}

export async function applyPresetToChannel(
  channel: VoiceChannel,
  preset: IChannelPreset,
  isReservedName?: (name: string) => Promise<boolean>,
): Promise<{ nameSkipped: boolean }> {
  // Never apply a name that would make the room look like the lobby (#1148)
  const nameBlocked =
    !!preset.channelName &&
    !!isReservedName &&
    (await isReservedName(preset.channelName));
  if (nameBlocked) {
    logger.warn(`Skipped reserved channel name from preset on ${channel.id}`);
  }
  if (
    !nameBlocked &&
    preset.channelName &&
    preset.channelName !== channel.name
  ) {
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
  return { nameSkipped: nameBlocked };
}

export async function getDefaultPreset(
  userId: string,
): Promise<IChannelPreset | null> {
  const prefs = await UserVoicePreferences.findOne({ userId }).lean();
  if (!prefs?.presets) return null;
  return prefs.presets.find((p) => p.isDefault) ?? null;
}
