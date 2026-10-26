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
import {
  afterWrite,
  replyWithError,
  replyWithUnexpectedError,
  type ErrorMessage,
} from "../utils/error-reply.js";
import { waitText } from "../utils/member-cooldown.js";

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

const FAILURE_TEXT: Record<TicketFailure, ErrorMessage> = {
  disabled: {
    title: "Tickets are off",
    next: "Ask an admin to turn them on in the Web UI.",
  },
  "no-staff-role": {
    title: "Tickets aren't set up yet",
    next: "An admin needs to choose the staff role first.",
  },
  "not-found": {
    title: "Couldn't find that ticket",
    next: "I can't find that ticket's channel any more. Ask a moderator if it still needs help.",
  },
  "already-closed": {
    title: "That ticket is already closed",
    next: "Open a new ticket if you still need help.",
  },
  "not-closed": {
    title: "That ticket isn't closed",
    next: "Close it first if you want to do that.",
  },
  "already-claimed": {
    title: "That ticket is already claimed",
    next: "Someone on the staff is already on it.",
  },
  "too-many-open": {
    title: "Couldn't open a ticket",
    next: "You already have an open ticket. Please use it, or close it first.",
  },
  cooldown: {
    title: "Couldn't open a ticket",
    next: "You opened a ticket a moment ago. Please wait a little, then try again.",
  },
  "discord-error": {
    title: "Couldn't reach Discord",
    next: "Something went wrong talking to Discord. Please try again, or ask a moderator.",
  },
};

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    if (!interaction.guild || !interaction.guildId) {
      await replyWithError(interaction, {
        title: "Can't use this here",
        next: "Run this command in a server.",
      });
      return;
    }

    // Acknowledge before any DB or channel work (#842).
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const manager = TicketChannelManager.getInstance(interaction.client);
    if (!(await manager.isEnabled())) {
      await replyWithError(interaction, FAILURE_TEXT.disabled);
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
    await replyWithUnexpectedError(interaction);
  }
}

async function handleOpen(
  interaction: ChatInputCommandInteraction,
  manager: TicketChannelManager,
): Promise<void> {
  const subject = interaction.options.getString("subject", true).trim();
  if (!subject) {
    await replyWithError(interaction, {
      title: "Couldn't open a ticket",
      next: "Say what you need help with, then try again.",
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
    await replyWithError(
      interaction,
      result.reason === "cooldown" && result.retryAfterSeconds
        ? {
            title: "Couldn't open a ticket",
            next: `You opened a ticket a moment ago. Please wait ${waitText(result.retryAfterSeconds)} before opening another.`,
          }
        : result.reason === "too-many-open" && result.maxOpen
          ? {
              title: "Couldn't open a ticket",
              next: `You already have ${result.maxOpen} open ticket${result.maxOpen === 1 ? "" : "s"}, the most allowed. Please use ${result.maxOpen === 1 ? "it" : "one of them"}, or close ${result.maxOpen === 1 ? "it" : "one"} first.`,
            }
          : FAILURE_TEXT[result.reason],
    );
    return;
  }
  // The ticket channel exists: a failing confirmation must not tell the
  // member to try again, which would open a second one.
  await afterWrite(
    interaction,
    { done: "Your ticket was opened", check: "the ticket channels" },
    async () => {
      await interaction.editReply({
        content: `🎫 Your ticket is open: <#${result.ticket.channelId}>`,
      });
    },
  );
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
    await replyWithError(interaction, {
      title: "Couldn't find a ticket",
      next: "Run this inside the ticket channel, or pass a ticket ID.",
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
    await replyWithError(interaction, {
      title: "Staff only",
      next: "Only staff can do that. Ask a moderator for help.",
    });
    return;
  }

  const result =
    sub === "claim"
      ? await manager.claimTicket(ticket, interaction.user.id)
      : await manager.closeTicket(ticket, interaction.user.id);
  if (!result.ok) {
    await replyWithError(interaction, FAILURE_TEXT[result.reason]);
    return;
  }
  await afterWrite(
    interaction,
    {
      done:
        sub === "claim" ? "The ticket was claimed" : "The ticket was closed",
      check: "the ticket channel",
    },
    async () => {
      await interaction.editReply({
        content:
          sub === "claim" ? "🙋 You claimed this ticket." : "🔒 Ticket closed.",
      });
    },
  );
}
