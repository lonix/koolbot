import { ButtonInteraction, MessageFlags } from "discord.js";
import { EventService } from "../services/event-service.js";
import type { RsvpStatus } from "../models/event.js";
import logger from "../utils/logger.js";

const RSVP_LABELS: Record<RsvpStatus, string> = {
  going: "✅ Going",
  maybe: "🤔 Maybe",
  cant: "🚫 Can't make it",
};

function isRsvpStatus(value: string): value is RsvpStatus {
  return value === "going" || value === "maybe" || value === "cant";
}

/**
 * @deprecated Legacy (#1175). New events have no RSVP buttons; this only
 * serves announcements posted before native-only events, and only while the
 * event is still current (`setRsvp` refuses a finished event or a message that
 * is not the event's announcement).
 *
 * Handle a Going / Maybe / Can't RSVP button on an event announcement.
 *
 * customId format: `event_rsvp_{eventId}_{status}` — the eventId is a Mongo
 * ObjectId (24 hex chars, no underscores) so a plain split is safe.
 */
export async function handleEventRsvpButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const parts = interaction.customId.split("_");
  if (parts.length !== 4 || parts[0] !== "event" || parts[1] !== "rsvp") {
    await interaction.reply({
      content: "❌ Invalid RSVP button.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const [, , eventId, status] = parts;
  if (!isRsvpStatus(status)) {
    await interaction.reply({
      content: "❌ Unknown RSVP option.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    // Acknowledge before the write: Discord invalidates an interaction left
    // unacknowledged for three seconds (`10062 Unknown interaction`, #842),
    // and the write is a Mongo round trip. Everything after this edits the
    // announcement with `editReply` and answers the member with an ephemeral
    // `followUp`, as the LFG buttons do (#1534).
    await interaction.deferUpdate();

    const service = EventService.getInstance(interaction.client);
    const event = await service.setRsvp(
      eventId,
      interaction.user.id,
      status,
      interaction.message.id,
    );
    if (!event) {
      await interaction.followUp({
        content:
          "❌ This event is no longer accepting RSVPs here. Press Interested on the event in Discord's Events list instead.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Refresh the announcement message in place with the new live counts.
    await interaction.editReply(service.buildLegacyRsvpPayload(event));
    await interaction.followUp({
      content: `Your RSVP: **${RSVP_LABELS[status]}**`,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    logger.error("Error handling event RSVP button:", error);
    if (interaction.replied || interaction.deferred) {
      await interaction
        .followUp({
          content: "❌ There was an error recording your RSVP.",
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => undefined);
    } else {
      await interaction
        .reply({
          content: "❌ There was an error recording your RSVP.",
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => undefined);
    }
  }
}
