import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
  type Guild,
} from "discord.js";
import { ModerationService } from "../services/moderation-service.js";
import { actionColor } from "../utils/moderation-format.js";
import {
  MAX_MESSAGE_DELETE_DAYS,
  MAX_REASON_LENGTH,
  checkHierarchy,
  formatAuditReason,
} from "../utils/moderation-guards.js";
import { getErrorMessage } from "../utils/error-guards.js";
import logger from "../utils/logger.js";
import { safeReply } from "../utils/safe-reply.js";

const SECONDS_PER_DAY = 24 * 60 * 60;

export const data = new SlashCommandBuilder()
  .setName("ban")
  .setDescription("Ban a member and record it in the moderation log")
  // Hide the command from members without the Ban Members permission by
  // default. Note a guild admin can override this in Discord's Integrations
  // UI, and the bot's own PermissionsService only gates execution once roles
  // have been configured for this command in the Web UI (it is default-open
  // otherwise) — so treat this as the primary gate, not a backstop. The role
  // hierarchy Discord would enforce natively is re-checked at runtime by
  // `checkHierarchy`, because the bot is the audit-log executor here.
  .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
  .addUserOption((option) =>
    option
      .setName("user")
      .setDescription("The member to ban")
      .setRequired(true),
  )
  .addStringOption((option) =>
    option
      .setName("reason")
      .setDescription("Why the member is being banned")
      .setRequired(true)
      .setMaxLength(MAX_REASON_LENGTH),
  )
  .addIntegerOption((option) =>
    option
      .setName("delete_days")
      .setDescription("Days of the member's recent messages to delete (0-7)")
      .setMinValue(0)
      .setMaxValue(MAX_MESSAGE_DELETE_DAYS),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    if (!interaction.guildId) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const targetUser = interaction.options.getUser("user", true);
    const reason = interaction.options.getString("reason", true).trim();
    const deleteDays = interaction.options.getInteger("delete_days") ?? 0;

    if (targetUser.bot) {
      await interaction.reply({
        content: "You can't ban a bot.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (targetUser.id === interaction.user.id) {
      await interaction.reply({
        content: "You can't ban yourself.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Acknowledge before any DB or REST work so the ban + write + count cannot
    // miss Discord's 3-second ACK window (`10062 Unknown interaction`, #842).
    // Every response below is ephemeral, and visibility is fixed here.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const moderationService = ModerationService.getInstance(interaction.client);

    // Runtime gate: the command is only registered while moderation.enabled is
    // true, but Discord keeps a stale registration until the next reload, so an
    // operator who toggles the feature off expects the bot to stop acting
    // immediately. Refuse rather than ban without a record.
    if (!(await moderationService.isEnabled())) {
      await interaction.editReply({
        content: "The moderation log is currently disabled.",
      });
      return;
    }

    const guild = interaction.guild;
    if (!guild) {
      await interaction.editReply({
        content: "I couldn't read this server's details. Please try again.",
      });
      return;
    }

    const invoker = await guild.members.fetch(interaction.user.id);
    // A ban may target someone who already left, so a missing member is fine
    // here — Discord accepts a ban by user id.
    const targetMember = await guild.members
      .fetch(targetUser.id)
      .catch(() => null);

    const refusal = checkHierarchy({
      guild,
      invoker,
      targetMember,
      verb: "ban",
      capability: "bannable",
    });
    if (refusal) {
      await interaction.editReply({ content: refusal });
      return;
    }

    const banned = await banMember(guild, targetUser.id, {
      auditReason: formatAuditReason(interaction.user.tag, reason),
      deleteDays,
    });
    if (banned !== true) {
      await interaction.editReply({ content: banned });
      return;
    }

    await moderationService.logAction({
      guildId: interaction.guildId,
      userId: targetUser.id,
      moderatorId: interaction.user.id,
      action: "ban",
      reason,
    });

    const total = await moderationService.countHistory(
      interaction.guildId,
      targetUser.id,
    );

    const embed = new EmbedBuilder()
      .setColor(actionColor("ban"))
      .setTitle("🔨 Member banned")
      .setDescription(
        `**${targetUser.tag}** has been banned.\nThey now have **${total}** entr${
          total === 1 ? "y" : "ies"
        } in the moderation log.`,
      )
      .addFields({ name: "Reason", value: reason })
      .setFooter({ text: `Use /modlog to view history` })
      .setTimestamp();

    if (deleteDays > 0) {
      embed.addFields({
        name: "Messages deleted",
        value: `Last ${deleteDays} day${deleteDays === 1 ? "" : "s"}`,
      });
    }

    // Ephemeral (set at the deferral above) so the moderator gets a clear
    // confirmation without posting a public call-out; the durable record
    // lives in the moderation log.
    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    logger.error("Error in ban command:", error);
    await safeReply(interaction, {
      content: "There was an error banning the member.",
      flags: MessageFlags.Ephemeral,
    });
  }
}

/**
 * Issue the ban, returning `true` on success or the message to show the
 * moderator when Discord rejected it. Kept separate so a REST refusal reads as
 * a clear refusal rather than falling into the command's generic error path —
 * nothing has been logged at this point, so the moderator needs to know the
 * ban did not happen.
 */
async function banMember(
  guild: Guild,
  userId: string,
  options: { auditReason: string; deleteDays: number },
): Promise<true | string> {
  try {
    await guild.bans.create(userId, {
      reason: options.auditReason,
      deleteMessageSeconds: options.deleteDays * SECONDS_PER_DAY,
    });
    return true;
  } catch (error) {
    logger.error("Ban command: Discord rejected the ban:", error);
    return `Discord rejected the ban (${getErrorMessage(
      error,
    )}). Nothing has been recorded.`;
  }
}
