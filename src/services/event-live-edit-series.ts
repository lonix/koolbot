/**
 * Live-edit row "also for the next occurrences" (#1266).
 *
 * A host's live edit of a running or upcoming event applies to THAT occurrence
 * only. This row is the tick on the host panel's group forms: when it is posted
 * with a save, the event's group setup as that save leaves it becomes the setup
 * every following occurrence starts with (`seriesGroupSetup`, read by
 * `EventService.spawnNextOccurrence`), until the host ticks it again.
 *
 * Rules, each from the live-edit core (`event-live-edit.ts`) and not new:
 *
 * 1. **It is a request, not a state.** It always reads as "off"; a posted "on"
 *    is a change, a second save with the tick plans the same change again and
 *    simply stores the then-current setup again (idempotent, never accumulating).
 * 2. **It runs last** (registered after every other row), so it stores the setup
 *    the save leaves behind. `apply` reads the row again (both locks are held, so
 *    nothing else of the group setup moves between that read and the write) and
 *    stores what the host decided: `seriesGroupSetupOf` takes a leader's
 *    renamed group back to its `originalName` / `originalTag`, and takes no
 *    membership, leader or channel.
 * 3. **One conditional write with an explicit outcome.** The write matches the
 *    event only while it is open and in this guild; an end or cancel that took
 *    the event meanwhile gives `lost`, never a success, because the successor
 *    is made from the stored value once the event has ended. The core asks
 *    `deps.isEnding` before it calls the row, but the row awaits a read of its
 *    own after that, so it asks `ctx.ending()` again, synchronously, right
 *    before the write (a hold that began during the read gives `lost`).
 * 4. **Only for an event that repeats** (`applicable`), and not for a series
 *    that was cancelled: its next occurrence will not be made.
 *
 * It owns no outward effect (nothing in Discord changes), so no follow-up. It
 * imports only TYPES from the core (the core lists this row), hence `asRow`.
 */

import { Event, type IEvent } from "../models/event.js";
import { seriesGroupSetupOf } from "./event-groups.js";
import type { JsonValue, LiveEditRow } from "./event-live-edit.js";

export const SERIES_SETUP_ROW_ID = "seriesSetup";

const OPEN = ["scheduled", "active"] as const;

function asRow<V extends JsonValue>(row: LiveEditRow<V>): LiveEditRow {
  return row as unknown as LiveEditRow;
}

export const seriesSetupRow: LiveEditRow = asRow<boolean>({
  id: SERIES_SETUP_ROW_ID,
  label: "Group setup of the next occurrences",
  read: () => false,
  applicable: (e) => {
    if (!e.recurrence || e.recurrence === "none" || !e.seriesId) {
      return "This event does not repeat.";
    }
    if (e.seriesCancelled === true) {
      return "This series was cancelled, so there is no next occurrence.";
    }
    return null;
  },
  parse: (raw) =>
    raw === "1" || raw === "0"
      ? { ok: true, value: raw === "1" }
      : {
          ok: false,
          error:
            "Group setup of the next occurrences: the form is out of date.",
        },
  describe: (v) => (v ? "this event's group setup" : "unchanged"),
  async apply({ eventId, guildId, ending }) {
    const fresh = (await Event.findOne({
      _id: eventId,
      guildId,
      state: { $in: [...OPEN] },
    }).lean()) as IEvent | null;
    if (!fresh) return { status: "lost" };
    // No await between this check and the write.
    if (ending()) return { status: "lost" };
    const result = await Event.updateOne(
      {
        _id: eventId,
        guildId,
        state: { $in: [...OPEN] },
        seriesCancelled: { $ne: true },
      },
      { $set: { seriesGroupSetup: seriesGroupSetupOf(fresh) } },
    );
    return (result?.matchedCount ?? 0) === 1
      ? { status: "applied" }
      : { status: "lost" };
  },
});
