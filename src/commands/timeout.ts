import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
  type GuildMember,
} from "discord.js";
import { ModerationService } from "../services/moderation-service.js";
import { actionColor } from "../utils/moderation-format.js";
import {
  MAX_REASON_LENGTH,
  MAX_TIMEOUT_MINUTES,
  checkHierarchy,
  formatAuditReason,
} from "../utils/moderation-guards.js";
import { getErrorMessage } from "../utils/error-guards.js";
import { formatDuration } from "../utils/time.js";
import logger from "../utils/logger.js";
import { safeReply } from "../utils/safe-reply.js";

const MS_PER_MINUTE = 60 * 1000;

export const data = new SlashCommandBuilder()
  .setName("timeout")
  .setDescription("Time a member out and record it in the moderation log")
  // Hide the command from members without the Moderate Members permission by
  // default. Note a guild admin can override this in Discord's Integrations
  // UI, and the bot's own PermissionsService only gates execution once roles
  // have been configured for this command in the Web UI (it is default-open
  // otherwise) — so treat this as the primary gate, not a backstop. The role
  // hierarchy Discord would enforce natively is re-checked at runtime by
  // `checkHierarchy`, because the bot is the audit-log executor here.
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption((option) =>
    option
      .setName("user")
      .setDescription("The member to time out")
      .setRequired(true),
  )
  .addIntegerOption((option) =>
    option
      .setName("duration")
      .setDescription("How long to time the member out for, in minutes")
      .setRequired(true)
      .setMinValue(1)
      // Discord's own UI offers six presets (60s, 5m, 10m, 1h, 1d, 1w); the
      // API allows anything up to 28 days, which is the point of this command.
      .setMaxValue(MAX_TIMEOUT_MINUTES),
  )
  .addStringOption((option) =>
    option
      .setName("reason")
      .setDescription("Why the member is being timed out")
      .setRequired(true)
      .setMaxLength(MAX_REASON_LENGTH),
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
    const minutes = interaction.options.getInteger("duration", true);
    const reason = interaction.options.getString("reason", true).trim();

    if (targetUser.bot) {
      await interaction.reply({
        content: "You can't time out a bot.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (targetUser.id === interaction.user.id) {
      await interaction.reply({
        content: "You can't time out yourself.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Acknowledge before any DB or REST work so the timeout + write + count
    // cannot miss Discord's 3-second ACK window (`10062 Unknown interaction`,
    // #842). Every response below is ephemeral, and visibility is fixed here.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const moderationService = ModerationService.getInstance(interaction.client);

    // Runtime gate: the command is only registered while moderation.enabled is
    // true, but Discord keeps a stale registration until the next reload, so an
    // operator who toggles the feature off expects the bot to stop acting
    // immediately. Refuse rather than act without a record.
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
    // Unlike a ban, a timeout only exists on a present member.
    const targetMember = await guild.members
      .fetch(targetUser.id)
      .catch(() => null);
    if (!targetMember) {
      await interaction.editReply({
        content: `**${targetUser.tag}** isn't a member of this server.`,
      });
      return;
    }

    const refusal = checkHierarchy({
      guild,
      invoker,
      targetMember,
      verb: "time out",
      capability: "moderatable",
    });
    if (refusal) {
      await interaction.editReply({ content: refusal });
      return;
    }

    const durationMs = minutes * MS_PER_MINUTE;
    const applied = await applyTimeout(
      targetMember,
      durationMs,
      formatAuditReason(interaction.user.tag, reason),
    );
    if (applied !== true) {
      await interaction.editReply({ content: applied });
      return;
    }

    await moderationService.logAction({
      guildId: interaction.guildId,
      userId: targetUser.id,
      moderatorId: interaction.user.id,
      action: "timeout",
      reason,
    });

    const total = await moderationService.countHistory(
      interaction.guildId,
      targetUser.id,
    );

    // A relative Discord timestamp so every viewer reads the expiry in their
    // own locale without the bot doing any date maths.
    const expiresAt = Math.floor((Date.now() + durationMs) / 1000);

    const embed = new EmbedBuilder()
      .setColor(actionColor("timeout"))
      .setTitle("⏳ Member timed out")
      .setDescription(
        `**${targetUser.tag}** has been timed out for **${formatDuration(
          durationMs,
        )}** (expires <t:${expiresAt}:R>).\nThey now have **${total}** entr${
          total === 1 ? "y" : "ies"
        } in the moderation log.`,
      )
      .addFields({ name: "Reason", value: reason })
      .setFooter({ text: `Use /modlog to view history` })
      .setTimestamp();

    // Ephemeral (set at the deferral above) so the moderator gets a clear
    // confirmation without posting a public call-out; the durable record
    // lives in the moderation log.
    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    logger.error("Error in timeout command:", error);
    await safeReply(interaction, {
      content: "There was an error timing the member out.",
      flags: MessageFlags.Ephemeral,
    });
  }
}

/**
 * Apply the timeout, returning `true` on success or the message to show the
 * moderator when Discord rejected it. Kept separate so a REST refusal reads as
 * a clear refusal rather than falling into the command's generic error path —
 * nothing has been logged at this point, so the moderator needs to know the
 * timeout did not happen.
 */
async function applyTimeout(
  member: GuildMember,
  durationMs: number,
  auditReason: string,
): Promise<true | string> {
  try {
    await member.timeout(durationMs, auditReason);
    return true;
  } catch (error) {
    logger.error("Timeout command: Discord rejected the timeout:", error);
    return `Discord rejected the timeout (${getErrorMessage(
      error,
    )}). Nothing has been recorded.`;
  }
}
