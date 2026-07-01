import { ButtonInteraction } from "discord.js";
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
      ephemeral: true,
    });
    return;
  }

  const [, , eventId, status] = parts;
  if (!isRsvpStatus(status)) {
    await interaction.reply({
      content: "❌ Unknown RSVP option.",
      ephemeral: true,
    });
    return;
  }

  try {
    const service = EventService.getInstance(interaction.client);
    const event = await service.setRsvp(eventId, interaction.user.id, status);
    if (!event) {
      await interaction.reply({
        content:
          "❌ This event is no longer accepting RSVPs (it may have ended or been cancelled).",
        ephemeral: true,
      });
      return;
    }

    // Refresh the announcement message in place with the new live counts.
    await interaction.update(service.buildAnnouncementPayload(event));
    await interaction.followUp({
      content: `Your RSVP: **${RSVP_LABELS[status]}**`,
      ephemeral: true,
    });
  } catch (error) {
    logger.error("Error handling event RSVP button:", error);
    if (interaction.replied || interaction.deferred) {
      await interaction
        .followUp({
          content: "❌ There was an error recording your RSVP.",
          ephemeral: true,
        })
        .catch(() => undefined);
    } else {
      await interaction
        .reply({
          content: "❌ There was an error recording your RSVP.",
          ephemeral: true,
        })
        .catch(() => undefined);
    }
  }
}
