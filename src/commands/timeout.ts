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
  fetchMemberOrNull,
  formatAuditReason,
} from "../utils/moderation-guards.js";
import { getErrorMessage } from "../utils/error-guards.js";
import { formatDuration } from "../utils/time.js";
import logger from "../utils/logger.js";
import { escapeDisplayText } from "../utils/allowed-mentions.js";
import {
  replyWithError,
  replyWithUnexpectedError,
} from "../utils/error-reply.js";

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
  // Set once Discord has accepted the timeout, so the catch below can tell a
  // failed timeout apart from a timeout that landed but whose recording or
  // confirmation failed. Telling a moderator the action failed when it didn't
  // invites them to run it again.
  let timedOut = false;

  try {
    if (!interaction.guildId) {
      await replyWithError(interaction, {
        title: "Can't use this here",
        next: "Run this command in a server.",
      });
      return;
    }

    const targetUser = interaction.options.getUser("user", true);
    const minutes = interaction.options.getInteger("duration", true);
    const reason = interaction.options.getString("reason", true).trim();

    if (targetUser.bot) {
      await replyWithError(interaction, {
        title: "Couldn't time out that member",
        next: "You can't time out a bot. Pick a member, then try again.",
      });
      return;
    }

    if (targetUser.id === interaction.user.id) {
      await replyWithError(interaction, {
        title: "Couldn't time out that member",
        next: "You can't time out yourself. Pick someone else, then try again.",
      });
      return;
    }

    // Discord's maxLength doesn't stop a whitespace-only reason, which trims to
    // "" — an invalid embed field value. Refusing here, before the timeout,
    // keeps the failure in front of the action rather than after it.
    if (!reason) {
      await replyWithError(interaction, {
        title: "Couldn't time out that member",
        next: "Give a reason for the timeout, then try again.",
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
      await replyWithError(interaction, {
        title: "The moderation log is off",
        next: "Ask an admin to turn it on in the Web UI, then try again.",
      });
      return;
    }

    const guild = interaction.guild;
    if (!guild) {
      await replyWithError(interaction, {
        title: "Couldn't read this server",
        next: "Try again in a minute.",
      });
      return;
    }

    const invoker = await guild.members.fetch(interaction.user.id);
    // Unlike a ban, a timeout only exists on a present member. A lookup failure
    // that isn't Discord confirming absence is rethrown, so "they aren't a
    // member" is never shown for what was really a transient error.
    const targetMember = await fetchMemberOrNull(guild, targetUser.id);
    if (!targetMember) {
      await replyWithError(interaction, {
        title: "Couldn't time out that member",
        next: `**${escapeDisplayText(targetUser.tag)}** isn't a member of this server. Pick someone who is, then try again.`,
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
      await replyWithError(interaction, {
        title: "Couldn't time out that member",
        next: refusal,
      });
      return;
    }

    const durationMs = minutes * MS_PER_MINUTE;
    const applied = await applyTimeout(
      targetMember,
      durationMs,
      formatAuditReason(interaction.user.tag, reason),
    );
    if (typeof applied === "string") {
      await replyWithError(interaction, {
        title: "Discord rejected the timeout",
        next: applied,
      });
      return;
    }

    // Everything past this point runs after Discord has already timed the
    // member out, so a failure here must not read as "the timeout failed".
    timedOut = true;

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
    // own locale without the bot doing any date maths. Taken from Discord's
    // own `communicationDisabledUntil` rather than computed from `Date.now()`
    // here — the timeout started before the log write and history query above,
    // so a slow database would otherwise push the displayed expiry past the
    // real one.
    const expiresAt = Math.floor(
      (applied.communicationDisabledUntilTimestamp ?? Date.now() + durationMs) /
        1000,
    );

    const embed = new EmbedBuilder()
      .setColor(actionColor("timeout"))
      .setTitle("⏳ Member timed out")
      .setDescription(
        `**${escapeDisplayText(targetUser.tag)}** has been timed out for **${formatDuration(
          durationMs,
        )}** (expires <t:${expiresAt}:R>).\nThey now have **${total}** entr${
          total === 1 ? "y" : "ies"
        } in the moderation log. Use \`/modlog\` to view their history.`,
      )
      .addFields({ name: "Reason", value: reason })
      .setFooter({ text: "KoolBot · Moderation" })
      .setTimestamp();

    // Ephemeral (set at the deferral above) so the moderator gets a clear
    // confirmation without posting a public call-out; the durable record
    // lives in the moderation log.
    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    logger.error("Error in timeout command:", error);
    if (timedOut) {
      await replyWithError(interaction, {
        title: "The member was timed out",
        next: "I couldn't record it or show the confirmation. Don't run this again — check `/modlog`.",
      });
    } else {
      await replyWithUnexpectedError(interaction);
    }
  }
}

/**
 * Apply the timeout, returning the updated member on success or the message to
 * show the moderator when Discord rejected it. Kept separate so a REST refusal
 * reads as a clear refusal rather than falling into the command's generic error
 * path — nothing has been logged at this point, so the moderator needs to know
 * the timeout did not happen. The returned member carries Discord's own
 * `communicationDisabledUntil`, which is the authoritative expiry.
 */
async function applyTimeout(
  member: GuildMember,
  durationMs: number,
  auditReason: string,
): Promise<GuildMember | string> {
  try {
    return await member.timeout(durationMs, auditReason);
  } catch (error) {
    logger.error("Timeout command: Discord rejected the timeout:", error);
    return `Discord rejected the timeout (${getErrorMessage(
      error,
    )}). Nothing has been recorded.`;
  }
}
