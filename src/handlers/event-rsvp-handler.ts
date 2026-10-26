import { ButtonInteraction, MessageFlags } from "discord.js";
import { EventService } from "../services/event-service.js";
import type { RsvpStatus } from "../models/event.js";
import logger from "../utils/logger.js";
import {
  replyAfterWriteError,
  replyWithError,
  replyWithUnexpectedError,
} from "../utils/error-reply.js";

const RSVP_LABELS: Record<RsvpStatus, string> = {
  going: "✅ Going",
  maybe: "🤔 Maybe",
  cant: "🚫 Can't make it",
};

/** A button whose id this handler cannot read (an old or edited announcement). */
const OUT_OF_DATE = {
  title: "This RSVP button is out of date",
  next: "Press Interested on the event in Discord's Events list instead.",
};

/**
 * Errors go out as a separate ephemeral message and never edit the
 * announcement: after `deferUpdate()` the deferred response IS the public
 * announcement (#1510).
 */
const FOLLOW_UP = { whenDeferred: "followUp" } as const;

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
    await replyWithError(interaction, { ...OUT_OF_DATE, ...FOLLOW_UP });
    return;
  }

  const [, , eventId, status] = parts;
  if (!isRsvpStatus(status)) {
    await replyWithError(interaction, { ...OUT_OF_DATE, ...FOLLOW_UP });
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
      await replyWithError(interaction, {
        title: "This event is no longer taking RSVPs here",
        next: "Press Interested on the event in Discord's Events list instead.",
        ...FOLLOW_UP,
      });
      return;
    }

    // Refresh the announcement message in place with the new live counts.
    // The RSVP is stored from here on, so a failing refresh or confirmation must
    // not read as "not recorded" or advise a retry, and it must not edit the
    // announcement. `afterWrite` takes no `whenDeferred`, so this does the same
    // with `followUp`.
    try {
      await interaction.editReply(service.buildLegacyRsvpPayload(event));
      await interaction.followUp({
        content: `Your RSVP: **${RSVP_LABELS[status]}**`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      logger.error("Error confirming event RSVP:", error);
      await replyAfterWriteError(
        interaction,
        {
          done: "Your RSVP was recorded",
          check: "the counts on the event announcement",
        },
        FOLLOW_UP,
      );
    }
  } catch (error) {
    logger.error("Error handling event RSVP button:", error);
    await replyWithUnexpectedError(interaction, FOLLOW_UP);
  }
}
