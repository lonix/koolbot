import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
} from "discord.js";
import { ModerationService } from "../services/moderation-service.js";
import logger from "../utils/logger.js";
import { escapeDisplayText } from "../utils/allowed-mentions.js";
import {
  afterWrite,
  replyWithError,
  replyWithUnexpectedError,
} from "../utils/error-reply.js";
import { MAX_REASON_LENGTH } from "../utils/moderation-guards.js";
import { embedColor } from "../utils/embed-style.js";

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
      await replyWithError(interaction, {
        title: "Can't use this here",
        next: "Run this command in a server.",
      });
      return;
    }

    const targetUser = interaction.options.getUser("user", true);
    const reason = interaction.options.getString("reason", true).trim();

    if (targetUser.bot) {
      await replyWithError(interaction, {
        title: "Couldn't warn that member",
        next: "You can't warn a bot. Pick a member, then try again.",
      });
      return;
    }

    if (targetUser.id === interaction.user.id) {
      await replyWithError(interaction, {
        title: "Couldn't warn that member",
        next: "You can't warn yourself. Pick someone else, then try again.",
      });
      return;
    }

    // Discord's maxLength doesn't stop a whitespace-only reason, which trims to
    // "" — an invalid embed field value, and a recorded warning with no reason.
    // Refusing here keeps the failure in front of the write.
    if (!reason) {
      await replyWithError(interaction, {
        title: "Couldn't warn that member",
        next: "Give a reason for the warning, then try again.",
      });
      return;
    }

    // Acknowledge before any DB work so the write + count cannot miss
    // Discord's 3-second ACK window (`10062 Unknown interaction`, #842).
    // Every response below is ephemeral, and visibility is fixed here.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const moderationService = ModerationService.getInstance(interaction.client);

    // Runtime gate: the command is only registered while moderation.enabled is
    // true, but Discord keeps a stale registration until the next reload, so an
    // operator who toggles the feature off expects new writes to stop
    // immediately. Return a clear message instead of recording a warning.
    if (!(await moderationService.isEnabled())) {
      await replyWithError(interaction, {
        title: "The moderation log is off",
        next: "Ask an admin to turn it on in the Web UI, then try again.",
      });
      return;
    }

    await moderationService.logWarn({
      guildId: interaction.guildId,
      userId: targetUser.id,
      moderatorId: interaction.user.id,
      reason,
    });

    // `logWarn` inserts a new entry on every call, so from here on a failure
    // must not tell the moderator to try again.
    const guildId = interaction.guildId;
    await afterWrite(
      interaction,
      { done: "The warning was recorded", check: "`/modlog`" },
      async () => {
        const total = await moderationService.countHistory(
          guildId,
          targetUser.id,
        );

        const embed = new EmbedBuilder()
          .setColor(embedColor("warn"))
          .setTitle("⚠️ Warning recorded")
          .setDescription(
            `**${escapeDisplayText(targetUser.tag)}** has been warned.\nThey now have **${total}** entr${
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
      },
    );
  } catch (error) {
    logger.error("Error in warn command:", error);
    await replyWithUnexpectedError(interaction);
  }
}
