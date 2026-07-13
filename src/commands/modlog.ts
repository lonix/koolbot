import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { ModerationService } from "../services/moderation-service.js";
import type { ModerationAction } from "../models/moderation-log.js";
import logger from "../utils/logger.js";

const PAGE_SIZE = 10;

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

    const targetUser = interaction.options.getUser("user", true);
    const requestedPage = interaction.options.getInteger("page") ?? 1;

    const moderationService = ModerationService.getInstance(interaction.client);

    // Runtime gate: moderation.enabled is the documented master switch, so a
    // stale command registration must not keep serving history after the
    // feature is turned off.
    if (!(await moderationService.isEnabled())) {
      await interaction.reply({
        content: "The moderation log is currently disabled.",
        ephemeral: true,
      });
      return;
    }

    const total = await moderationService.countHistory(
      interaction.guildId,
      targetUser.id,
    );

    if (total === 0) {
      await interaction.reply({
        content: `**${targetUser.tag}** has no moderation history.`,
        ephemeral: true,
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
      const reason = entry.reason ? `\n> ${entry.reason}` : "";
      return `**${actionLabel(entry.action)}** · ${when} · by ${moderator}${reason}`;
    });

    const embed = new EmbedBuilder()
      .setColor(0x6366f1)
      .setTitle(`🛡️ Moderation history — ${targetUser.tag}`)
      .setThumbnail(targetUser.displayAvatarURL())
      .setDescription(lines.join("\n\n"))
      .setFooter({
        text: `Page ${page}/${totalPages} · ${total} total entr${
          total === 1 ? "y" : "ies"
        }`,
      })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  } catch (error) {
    logger.error("Error in modlog command:", error);
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply({
        content: "There was an error fetching the moderation history.",
      });
    } else {
      await interaction.reply({
        content: "There was an error fetching the moderation history.",
        ephemeral: true,
      });
    }
  }
}
