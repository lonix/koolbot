import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import {
  MAX_SUBJECT_LENGTH,
  TicketChannelManager,
  type TicketFailure,
} from "../services/ticket-channel-manager.js";
import type { ITicket } from "../models/ticket.js";
import logger from "../utils/logger.js";
import { safeReply } from "../utils/safe-reply.js";

/**
 * `/ticket` — member support tickets (#1004).
 *
 * `open` and `close` are member self-service; `claim` is the staff side of the
 * same workflow. Everything that *configures* tickets (category, staff role,
 * transcripts) and the cross-ticket overview live in the Web UI at
 * `/admin/tickets`, per the admin-surface split in CLAUDE.md.
 */

export const data = new SlashCommandBuilder()
  .setName("ticket")
  .setDescription("Get private help from staff")
  .addSubcommand((sub) =>
    sub
      .setName("open")
      .setDescription("Open a private ticket channel with the staff")
      .addStringOption((o) =>
        o
          .setName("subject")
          .setDescription("What do you need help with?")
          .setRequired(true)
          .setMaxLength(MAX_SUBJECT_LENGTH),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("close")
      .setDescription("Close a ticket (run it inside the ticket channel)")
      .addStringOption((o) =>
        o
          .setName("id")
          .setDescription("Ticket ID — staff only, to close one from elsewhere")
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("claim")
      .setDescription("Staff: claim this ticket as yours")
      .addStringOption((o) =>
        o
          .setName("id")
          .setDescription("Ticket ID, to claim one from elsewhere")
          .setRequired(false),
      ),
  );

const FAILURE_TEXT: Record<TicketFailure, string> = {
  disabled: "Tickets are currently disabled.",
  "no-staff-role":
    "Tickets aren't set up yet: an admin needs to choose the staff role first.",
  "not-found": "I can't find that ticket's channel any more.",
  "already-closed": "That ticket is already closed.",
  "not-closed": "That ticket isn't closed.",
  "already-claimed": "That ticket has already been claimed.",
  "discord-error":
    "Something went wrong talking to Discord. Please try again, or ask a moderator.",
};

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    if (!interaction.guild || !interaction.guildId) {
      await interaction.reply({
        content: "This command can only be used in a server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Acknowledge before any DB or channel work (#842).
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const manager = TicketChannelManager.getInstance(interaction.client);
    if (!(await manager.isEnabled())) {
      await interaction.editReply({ content: FAILURE_TEXT.disabled });
      return;
    }

    const sub = interaction.options.getSubcommand();
    if (sub === "open") {
      await handleOpen(interaction, manager);
    } else {
      await handleStaffOrAuthor(interaction, manager, sub);
    }
  } catch (error) {
    logger.error("Error in ticket command:", error);
    await safeReply(interaction, {
      content: "There was an error handling the ticket.",
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function handleOpen(
  interaction: ChatInputCommandInteraction,
  manager: TicketChannelManager,
): Promise<void> {
  const subject = interaction.options.getString("subject", true).trim();
  if (!subject) {
    await interaction.editReply({
      content: "Please say what you need help with.",
    });
    return;
  }
  const result = await manager.openTicket({
    guild: interaction.guild!,
    authorId: interaction.user.id,
    authorName: interaction.user.username,
    subject,
  });
  if (!result.ok) {
    await interaction.editReply({ content: FAILURE_TEXT[result.reason] });
    return;
  }
  await interaction.editReply({
    content: `🎫 Your ticket is open: <#${result.ticket.channelId}>`,
  });
}

/** Resolve the ticket a `close` / `claim` refers to: the `id` option, else this channel. */
async function resolveTicket(
  interaction: ChatInputCommandInteraction,
  manager: TicketChannelManager,
): Promise<ITicket | null> {
  const guildId = interaction.guildId!;
  const id = interaction.options.getString("id")?.trim();
  return id
    ? manager.findById(guildId, id)
    : manager.findByChannel(guildId, interaction.channelId);
}

async function handleStaffOrAuthor(
  interaction: ChatInputCommandInteraction,
  manager: TicketChannelManager,
  sub: string,
): Promise<void> {
  const ticket = await resolveTicket(interaction, manager);
  if (!ticket) {
    await interaction.editReply({
      content:
        "I couldn't find a ticket. Run this inside the ticket channel, or pass a ticket ID.",
    });
    return;
  }

  const settings = await manager.getSettings();
  const member = await interaction.guild!.members.fetch(interaction.user.id);
  const staff = manager.isStaff(member, settings.staffRoleId);
  // The author may close only from inside the ticket channel; reaching it by
  // ID from elsewhere is a staff privilege.
  const isAuthor =
    ticket.authorId === interaction.user.id &&
    ticket.channelId === interaction.channelId;

  // Staff can act on any ticket; the author may only close their own.
  if (!staff && !(sub === "close" && isAuthor)) {
    await interaction.editReply({ content: "Only staff can do that." });
    return;
  }

  const result =
    sub === "claim"
      ? await manager.claimTicket(ticket, interaction.user.id)
      : await manager.closeTicket(ticket, interaction.user.id);
  if (!result.ok) {
    await interaction.editReply({ content: FAILURE_TEXT[result.reason] });
    return;
  }
  await interaction.editReply({
    content:
      sub === "claim" ? "🙋 You claimed this ticket." : "🔒 Ticket closed.",
  });
}
