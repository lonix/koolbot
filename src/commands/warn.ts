import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { ModerationService } from "../services/moderation-service.js";
import logger from "../utils/logger.js";
import { safeReply } from "../utils/safe-reply.js";

const MAX_REASON_LENGTH = 512;

export const data = new SlashCommandBuilder()
  .setName("warn")
  .setDescription("Record a warning against a member (moderation log)")
  // Hide the command from members without the Moderate Members permission by
  // default. Note a guild admin can override this in Discord's Integrations
  // UI, and the bot's own PermissionsService only gates execution once roles
  // have been configured for this command in the Web UI (it is default-open
  // otherwise) — so treat this as the primary gate, not a backstop.
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption((option) =>
    option
      .setName("user")
      .setDescription("The member to warn")
      .setRequired(true),
  )
  .addStringOption((option) =>
    option
      .setName("reason")
      .setDescription("Why the member is being warned")
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
        ephemeral: true,
      });
      return;
    }

    const targetUser = interaction.options.getUser("user", true);
    const reason = interaction.options.getString("reason", true).trim();

    if (targetUser.bot) {
      await interaction.reply({
        content: "You can't warn a bot.",
        ephemeral: true,
      });
      return;
    }

    if (targetUser.id === interaction.user.id) {
      await interaction.reply({
        content: "You can't warn yourself.",
        ephemeral: true,
      });
      return;
    }

    // Acknowledge before any DB work so the write + count cannot miss
    // Discord's 3-second ACK window (`10062 Unknown interaction`, #842).
    // Every response below is ephemeral, and visibility is fixed here.
    await interaction.deferReply({ ephemeral: true });

    const moderationService = ModerationService.getInstance(interaction.client);

    // Runtime gate: the command is only registered while moderation.enabled is
    // true, but Discord keeps a stale registration until the next reload, so an
    // operator who toggles the feature off expects new writes to stop
    // immediately. Return a clear message instead of recording a warning.
    if (!(await moderationService.isEnabled())) {
      await interaction.editReply({
        content: "The moderation log is currently disabled.",
      });
      return;
    }

    await moderationService.logWarn({
      guildId: interaction.guildId,
      userId: targetUser.id,
      moderatorId: interaction.user.id,
      reason,
    });

    const total = await moderationService.countHistory(
      interaction.guildId,
      targetUser.id,
    );

    const embed = new EmbedBuilder()
      .setColor(0xf59e0b)
      .setTitle("⚠️ Warning recorded")
      .setDescription(
        `**${targetUser.tag}** has been warned.\nThey now have **${total}** entr${
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
    logger.error("Error in warn command:", error);
    await safeReply(interaction, {
      content: "There was an error recording the warning.",
      ephemeral: true,
    });
  }
}
