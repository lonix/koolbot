import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { ModerationService } from "../services/moderation-service.js";
import logger from "../utils/logger.js";

const MAX_REASON_LENGTH = 512;

export const data = new SlashCommandBuilder()
  .setName("warn")
  .setDescription("Record a warning against a member (moderation log)")
  // Hide the command from members without the Moderate Members permission by
  // default. The bot's own PermissionsService still gates execution and lets
  // admins configure additional roles.
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

    const moderationService = ModerationService.getInstance(interaction.client);
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

    // Ephemeral so the moderator gets a clear confirmation without posting a
    // public call-out; the durable record lives in the moderation log.
    await interaction.reply({ embeds: [embed], ephemeral: true });
  } catch (error) {
    logger.error("Error in warn command:", error);
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply({
        content: "There was an error recording the warning.",
      });
    } else {
      await interaction.reply({
        content: "There was an error recording the warning.",
        ephemeral: true,
      });
    }
  }
}
