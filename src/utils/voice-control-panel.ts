import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import { embedColor } from "./embed-style.js";

/** Title of the controls post. Sentence case; 🔊 names a voice room. */
export const CONTROL_PANEL_TITLE = "🔊 Room controls";

/**
 * Title the post had before #1519. Posts already sitting in rooms still carry
 * it, so finding a post after an ownership transfer must accept both.
 */
export const LEGACY_CONTROL_PANEL_TITLE = "🎮 Voice Channel Controls";

/** True when an embed title belongs to a controls post, old or new. */
export function isControlPanelTitle(title: string | null | undefined): boolean {
  return title === CONTROL_PANEL_TITLE || title === LEGACY_CONTROL_PANEL_TITLE;
}

/** The state the controls post shows and the buttons toggle. */
export interface ControlPanelState {
  channelId: string;
  ownerId: string;
  isPrivate: boolean;
  isLive: boolean;
  hasWaitingRoom: boolean;
  presetsEnabled: boolean;
}

/**
 * The one place the voice room controls post is built (#1519): state in,
 * embed and button rows out. `sendControlPanel` (new room) and
 * `rebuildControlPanel` (after a change) both call it, so the copy exists once.
 * The custom ids (`vc_control_*`, `vc_preset_open_*`) must not change: buttons
 * on posts already in rooms keep working.
 */
export function buildControlPanel(state: ControlPanelState): {
  embed: EmbedBuilder;
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const { channelId, ownerId, isPrivate, isLive, hasWaitingRoom } = state;

  const embed = new EmbedBuilder()
    .setTitle(CONTROL_PANEL_TITLE)
    .setDescription(
      `Controls for <#${channelId}>. Only its owner can use these buttons.`,
    )
    .addFields(
      {
        name: "Privacy",
        value: isPrivate ? "Invite only" : "Public",
        inline: true,
      },
      { name: "Live", value: isLive ? "Yes" : "No", inline: true },
      {
        name: "Waiting room",
        value: hasWaitingRoom ? "On" : "Off",
        inline: true,
      },
    )
    .setColor(embedColor(isLive ? "ok" : "neutral"))
    .setFooter({ text: "KoolBot · Voice channels" });

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`vc_control_name_${channelId}_${ownerId}`)
      .setLabel("Rename")
      .setStyle(ButtonStyle.Primary)
      .setEmoji("✏️"),
    new ButtonBuilder()
      .setCustomId(`vc_control_privacy_${channelId}_${ownerId}`)
      .setLabel(isPrivate ? "Make public" : "Make private")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji(isPrivate ? "🌐" : "🔒"),
    new ButtonBuilder()
      .setCustomId(`vc_control_invite_${channelId}_${ownerId}`)
      .setLabel("Invite")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("👥")
      .setDisabled(!isPrivate), // Only a private room has an invite list
    new ButtonBuilder()
      .setCustomId(`vc_control_transfer_${channelId}_${ownerId}`)
      .setLabel("Transfer")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("👑"),
  );

  const row2Buttons = [
    new ButtonBuilder()
      .setCustomId(`vc_control_live_${channelId}_${ownerId}`)
      .setLabel(isLive ? "Go offline" : "Go live")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji(isLive ? "⬜" : "🔴"),
    new ButtonBuilder()
      .setCustomId(`vc_control_waitingroom_${channelId}_${ownerId}`)
      .setLabel(hasWaitingRoom ? "Remove waiting room" : "Add waiting room")
      .setStyle(hasWaitingRoom ? ButtonStyle.Danger : ButtonStyle.Secondary)
      .setEmoji(hasWaitingRoom ? "🗑️" : "⏳"),
  ];

  if (state.presetsEnabled) {
    row2Buttons.push(
      new ButtonBuilder()
        .setCustomId(`vc_preset_open_${channelId}_${ownerId}`)
        .setLabel("Choose preset")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("🎛️"),
    );
  }

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...row2Buttons,
  );

  return { embed, components: [row1, row2] };
}
