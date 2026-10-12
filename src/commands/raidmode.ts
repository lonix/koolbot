import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
} from "discord.js";
import {
  RaidProtectionService,
  type RaidStatus,
} from "../services/raid-protection-service.js";
import logger from "../utils/logger.js";
import { safeReply } from "../utils/safe-reply.js";

export const data = new SlashCommandBuilder()
  .setName("raidmode")
  .setDescription("Turn anti-raid lockdown on or off, or check its status")
  // Primary gate (a guild admin can override it in Integrations), so execute()
  // re-checks the permission itself: this command can lock out new members.
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addStringOption((option) =>
    option
      .setName("mode")
      .setDescription("on: start lockdown, off: end it, status: show it")
      .setRequired(true)
      .addChoices(
        { name: "on", value: "on" },
        { name: "off", value: "off" },
        { name: "status", value: "status" },
      ),
  );

/** Render the status snapshot. Pure, for direct testing. */
export function buildStatusEmbed(status: RaidStatus): EmbedBuilder {
  const lines: string[] = [];
  if (status.inactiveReason) {
    lines.push(`**Inactive:** ${status.inactiveReason}`);
  }
  lines.push(
    `**Lockdown:** ${
      status.lockdown
        ? `on since <t:${Math.floor((status.since ?? Date.now()) / 1000)}:R>${
            status.startedBy ? ` (by <@${status.startedBy}>)` : " (automatic)"
          }`
        : "off"
    }`,
    `**Mode:** ${status.dryRun ? "dry run (nobody is acted on)" : "live"}`,
    `**Joins in the last ${status.windowSeconds}s:** ${status.joinsInWindow} (lockdown above ${status.joinThreshold})`,
    `**Lockdown action:** ${status.lockdownAction}`,
    `**New-account gate:** ${
      status.minAccountAgeHours > 0
        ? `under ${status.minAccountAgeHours}h old gets ${status.newAccountAction}`
        : "off"
    }`,
    `**This lockdown so far:** ${status.actioned} acted on, ${status.wouldAction} would have been (dry run), ${status.skipped} skipped, ${status.failed} failed`,
  );
  return new EmbedBuilder()
    .setColor(status.lockdown ? 0xdc2626 : 0x22c55e)
    .setTitle("🛡️ Anti-raid status")
    .setDescription(lines.join("\n"));
}

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    if (!interaction.guildId || !interaction.guild) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Discord's default-permission gate can be overridden per role in
    // Integrations, so the permission is checked here as well.
    if (
      !interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)
    ) {
      await interaction.reply({
        content: "You need the Moderate Members permission to use this.",
        flags: MessageFlags.Ephemeral,
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

    const result = await service.setLockdown(
      interaction.guild,
      mode === "on",
      interaction.user.id,
    );
    await interaction.editReply({ content: result.message });
  } catch (error) {
    logger.error("Error in raidmode command:", error);
    await safeReply(interaction, {
      content: "There was an error changing raid mode.",
      flags: MessageFlags.Ephemeral,
    });
  }
}
