import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { ModerationService } from "../services/moderation-service.js";
import type { ModerationAction } from "../models/moderation-log.js";
import logger from "../utils/logger.js";
import { safeReply } from "../utils/safe-reply.js";
import {
  clampToLimit,
  truncateText,
  DISCORD_EMBED_DESCRIPTION_LIMIT,
} from "../utils/discord-limits.js";

export const PAGE_SIZE = 10;

/**
 * Longest reason shown per entry. Reasons are stored at up to 512 chars, but
 * a full page of those (plus the action/when/moderator line) overflows the
 * 4096-char embed description (#840). 300 keeps a full page well inside the
 * limit while still showing the vast majority of reasons untouched.
 */
export const MAX_REASON_DISPLAY_LENGTH = 300;

/** Emoji + label shown for each action in the history embed. */
export function actionLabel(action: ModerationAction): string {
  switch (action) {
    case "warn":
      return "⚠️ Warn";
    case "kick":
      return "👢 Kick";
    case "ban":
      return "🔨 Ban";
    case "unban":
      return "🕊️ Unban";
    case "timeout":
      return "⏳ Timeout";
    case "untimeout":
      return "✅ Timeout lifted";
    default:
      return action;
  }
}

export const data = new SlashCommandBuilder()
  .setName("modlog")
  .setDescription("View a member's moderation history")
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption((option) =>
    option
      .setName("user")
      .setDescription("The member whose history to view")
      .setRequired(true),
  )
  .addIntegerOption((option) =>
    option
      .setName("page")
      .setDescription("Page of history to view (10 per page)")
      .setMinValue(1),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    if (!interaction.guildId) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        ephemeral: true,
      });
      return;
    }

    // Acknowledge before any DB work so a slow history query cannot miss
    // Discord's 3-second ACK window (`10062 Unknown interaction`, #842).
    // Every response below is ephemeral, and visibility is fixed here.
    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser("user", true);
    const requestedPage = interaction.options.getInteger("page") ?? 1;

    const moderationService = ModerationService.getInstance(interaction.client);

    // Runtime gate: moderation.enabled is the documented master switch, so a
    // stale command registration must not keep serving history after the
    // feature is turned off.
    if (!(await moderationService.isEnabled())) {
      await interaction.editReply({
        content: "The moderation log is currently disabled.",
      });
      return;
    }

    const total = await moderationService.countHistory(
      interaction.guildId,
      targetUser.id,
    );

    if (total === 0) {
      await interaction.editReply({
        content: `**${targetUser.tag}** has no moderation history.`,
      });
      return;
    }

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const page = Math.min(Math.max(1, requestedPage), totalPages);
    const skip = (page - 1) * PAGE_SIZE;

    const entries = await moderationService.getHistory(
      interaction.guildId,
      targetUser.id,
      { limit: PAGE_SIZE, skip },
    );

    const lines = entries.map((entry) => {
      const when = `<t:${Math.floor(entry.createdAt.getTime() / 1000)}:f>`;
      const moderator = entry.moderatorId
        ? `<@${entry.moderatorId}>`
        : "Unknown";
      const reason = entry.reason
        ? `\n> ${truncateText(entry.reason, MAX_REASON_DISPLAY_LENGTH)}`
        : "";
      return `**${actionLabel(entry.action)}** · ${when} · by ${moderator}${reason}`;
    });

    // The per-reason cap above keeps a full page under the limit; this clamp
    // is the guarantee should the line format or page size ever grow.
    const description = clampToLimit(lines, DISCORD_EMBED_DESCRIPTION_LIMIT, {
      separator: "\n\n",
      overflowLabel: (dropped) => `…and ${dropped} more on this page`,
    });

    const embed = new EmbedBuilder()
      .setColor(0x6366f1)
      .setTitle(`🛡️ Moderation history — ${targetUser.tag}`)
      .setThumbnail(targetUser.displayAvatarURL())
      .setDescription(description)
      .setFooter({
        text: `Page ${page}/${totalPages} · ${total} total entr${
          total === 1 ? "y" : "ies"
        }`,
      })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    logger.error("Error in modlog command:", error);
    await safeReply(interaction, {
      content: "There was an error fetching the moderation history.",
      ephemeral: true,
    });
  }
}
