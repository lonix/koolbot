import {
  type APIEmbedField,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
} from "discord.js";
import {
  RaidProtectionService,
  type ActionCounts,
  type RaidStatus,
} from "../services/raid-protection-service.js";
import logger from "../utils/logger.js";
import { replyWithError, UNEXPECTED_ERROR } from "../utils/error-reply.js";
import { embedColor } from "../utils/embed-style.js";

export const data = new SlashCommandBuilder()
  .setName("raidmode")
  .setDescription("Start or end anti-raid lockdown, or show its status")
  // Primary gate (a guild admin can override it in Integrations), so execute()
  // re-checks the permission itself: this command can lock out new members.
  // Moderate Members is enough to see the command, to end a lockdown and to
  // read the status; starting one also needs the permission of the configured
  // action (see RAID_ACTION_PERMISSIONS), checked below.
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addStringOption((option) =>
    option
      .setName("mode")
      .setDescription(
        "on needs the configured action's permission; off and status need Moderate Members",
      )
      .setRequired(true)
      .addChoices(
        { name: "on", value: "on" },
        { name: "off", value: "off" },
        { name: "status", value: "status" },
      ),
  );

function countsLine(c: ActionCounts): string {
  return `${c.actioned} acted on, ${c.wouldAction} would have been (dry run), ${c.skipped} skipped, ${c.failed} failed`;
}

/** Render the status snapshot, one field per fact. Pure, for direct testing. */
export function buildStatusEmbed(status: RaidStatus): EmbedBuilder {
  const fields: APIEmbedField[] = [];
  if (status.inactiveReason) {
    fields.push({ name: "Inactive", value: status.inactiveReason });
  }
  fields.push(
    {
      name: "Lockdown",
      value: status.lockdown
        ? `On since <t:${Math.floor((status.since ?? Date.now()) / 1000)}:R>${
            status.startedBy ? ` (by <@${status.startedBy}>)` : " (automatic)"
          }`
        : "Off",
    },
    {
      name: "Mode",
      value: status.dryRun ? "Dry run (nobody is acted on)" : "Live",
      inline: true,
    },
    {
      name: `Joins in the last ${status.windowSeconds} s`,
      value: `${status.joinsInWindow} (lockdown above ${status.joinThreshold})`,
      inline: true,
    },
    {
      name: "Lockdown action",
      value: `${status.lockdownAction}${status.lockdown ? " (fixed for this lockdown)" : ""}`,
      inline: true,
    },
    {
      name: "New-account gate",
      value:
        status.minAccountAgeHours > 0
          ? `Under ${status.minAccountAgeHours} h old gets ${status.newAccountAction}`
          : "Off",
    },
    { name: "This lockdown so far", value: countsLine(status.counts) },
    {
      name: "New-account gate since the bot started",
      value: countsLine(status.gateCounts),
    },
  );
  if (status.unrecorded > 0) {
    const rows = `${status.unrecorded} log ${status.unrecorded === 1 ? "row" : "rows"}`;
    fields.push({
      name: "Warning",
      value: `${rows} could not be written to the database yet and ${status.unrecorded === 1 ? "is" : "are"} being retried.`,
    });
  }
  return new EmbedBuilder()
    .setColor(status.lockdown ? embedColor("warn") : embedColor("ok"))
    .setTitle("🛡️ Anti-raid status")
    .addFields(fields)
    .setFooter({ text: "KoolBot · Moderation · Raid mode" });
}

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    if (!interaction.guildId || !interaction.guild) {
      await replyWithError(interaction, {
        title: "Can't use this here",
        next: "Run this command in a server.",
      });
      return;
    }

    // Discord's default-permission gate can be overridden per role in
    // Integrations, so the permission is checked here as well.
    if (
      !interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)
    ) {
      await replyWithError(interaction, {
        title: "Moderators only",
        next: "This needs the Moderate Members permission. Ask a moderator or an admin.",
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const mode = interaction.options.getString("mode", true);
    const service = RaidProtectionService.getInstance(interaction.client);

    if (mode === "status") {
      const status = await service.getStatus(interaction.guild);
      await interaction.editReply({ embeds: [buildStatusEmbed(status)] });
      return;
    }

    // `on` makes the bot apply the configured action to every later join, so
    // the moderator must hold the permission that action stands for, the same
    // way `/ban` needs Ban Members. The check runs inside `setLockdown`, on
    // the settings snapshot the lockdown starts with, so the action cannot
    // change between the check and the start. `off` and `status` never
    // escalate.
    const result = await service.setLockdown(
      interaction.guild,
      mode === "on",
      interaction.user.id,
      (needed) =>
        interaction.memberPermissions?.has(needed.flag)
          ? null
          : `Under the current settings a lockdown can **${needed.action}** members who join (the lockdown action, or the stronger new-account action), which needs the **${needed.label}** permission. Ask someone who has it, or an administrator.`,
    );
    await interaction.editReply({ content: result.message });
  } catch (error) {
    logger.error("Error in raidmode command:", error);
    await replyWithError(interaction, {
      title: "Couldn't change raid mode",
      next: UNEXPECTED_ERROR.next,
    });
  }
}
