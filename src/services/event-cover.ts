import { createHash } from "node:crypto";
import { Event, type IEvent } from "../models/event.js";
import { EventImage, type IEventImage } from "../models/event-image.js";
import logger from "../utils/logger.js";
import { createKeyedLock } from "../utils/keyed-lock.js";

/**
 * Optional cover image of a KoolBot event, mirrored to the native Discord
 * event (#1181). Storage, validation and cleanup live here; sending it to
 * Discord is `NativeEventSync`'s job.
 *
 * The image is stored once per event or series in the `event-images`
 * collection (see `models/event-image.ts`); event rows carry only its hash.
 */

/**
 * Largest accepted upload: 2 MiB. Deliberately conservative: Discord's own
 * limit for a scheduled-event cover is not stated in discord-api-types or
 * discord.js (the typings only say "base64 image"), so this stays well under
 * any plausible limit. It also bounds what each send costs: the bytes go out as
 * base64 (about a third larger) in one REST body, and are read from Mongo on
 * each (re)send. Far above what a banner needs (Discord recommends about
 * 800x320 px, which is a few hundred KB at most) and far below Mongo's 16 MB
 * document limit.
 */
export const COVER_MAX_BYTES = 2 * 1024 * 1024;

/** The sync gives up on a cover after this many failed sends (until the image
 * changes), so a rejected image cannot retry forever. */
export const MAX_COVER_ATTEMPTS = 3;

const coverLock = createKeyedLock();

/**
 * Run `work` once every earlier cover mutation for the same event or series
 * has finished. Set, remove, the orphan sweep and the spawn of a successor
 * occurrence all go through it, so the image document and the row hashes are
 * always changed together. In-process only: the bot is one process (the web
 * UI and the scan run in it), and the writes stay atomic on their own.
 */
export function withCoverLock<T>(
  guildId: string,
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  return coverLock.run(`${guildId}:${key}`, work);
}

export type CoverMime = "image/png" | "image/jpeg" | "image/gif";

/**
 * The type of an image by its real file signature (magic bytes), or null when
 * it is not PNG, JPEG or GIF. The declared MIME type and file name are never
 * consulted: they are chosen by the uploader. Formats follow what
 * discord-api-types documents for the other base64 image fields of the API
 * (`png/jpeg/gif`, rest/v10/guild.d.ts); WebP is not listed there, so it is
 * rejected rather than guessed.
 */
export function sniffCoverImage(data: Buffer): CoverMime | null {
  if (
    data.length >= 8 &&
    data
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (data.length >= 6) {
    const head = data.subarray(0, 6).toString("latin1");
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  return null;
}

export type CoverValidation =
  { ok: true; mime: CoverMime; hash: string } | { ok: false; error: string };

/** Validate an uploaded cover: non-empty, within the size cap, real signature. */
export function validateCoverImage(data: Buffer): CoverValidation {
  if (data.length === 0) {
    return { ok: false, error: "No image was received." };
  }
  if (data.length > COVER_MAX_BYTES) {
    return {
      ok: false,
      error: `The image is too large (${formatKb(data.length)}). The maximum is ${formatKb(COVER_MAX_BYTES)}.`,
    };
  }
  const mime = sniffCoverImage(data);
  if (!mime) {
    return {
      ok: false,
      error: "The file is not a PNG, JPEG or GIF image.",
    };
  }
  return {
    ok: true,
    mime,
    hash: createHash("sha256").update(data).digest("hex"),
  };
}

function formatKb(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(bytes % (1024 * 1024) === 0 ? 0 : 1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}

/** The key the image of this event or series is stored under. */
export function coverKeyFor(event: Pick<IEvent, "_id" | "seriesId">): string {
  return event.seriesId ?? String(event._id);
}

/** Every row of the event's series (or the one-off row itself), minus adopted
 * rows, which never carry a cover. */
function coverRowsFilter(
  event: Pick<IEvent, "_id" | "seriesId" | "guildId">,
): Record<string, unknown> {
  return {
    guildId: event.guildId,
    nativeAdopted: { $ne: true },
    ...(event.seriesId ? { seriesId: event.seriesId } : { _id: event._id }),
  };
}

export const COVER_DETACHED_REASON =
  "This event was deleted from Discord's Events list and is no longer mirrored, so a cover would never be shown.";

/**
 * Why this event cannot take a cover, or null when it can. An adopted event
 * keeps the cover it has in Discord: KoolBot never writes to it. A finished
 * event has no native event left to show one on; a finished occurrence still
 * waiting for its successor keeps the series live.
 */
export function coverIneligibleReason(
  event: Pick<
    IEvent,
    | "state"
    | "nativeAdopted"
    | "nativeCleanupOnly"
    | "nativeDetached"
    | "recurrence"
    | "nextSpawned"
    | "seriesCancelled"
  >,
): string | null {
  if (event.nativeAdopted) {
    return "This event was adopted from an existing Discord event, so its cover is managed in Discord and KoolBot never changes it.";
  }
  if (event.nativeCleanupOnly) {
    return "This entry is only kept until its Discord event is closed.";
  }
  if (event.nativeDetached && event.recurrence === "none") {
    // The sync skips a detached row for good, so a cover could never arrive.
    // A recurring series stays eligible: its future occurrences get one.
    return COVER_DETACHED_REASON;
  }
  const finished = event.state === "ended" || event.state === "cancelled";
  const awaitingSuccessor =
    finished &&
    event.recurrence !== "none" &&
    !event.nextSpawned &&
    !event.seriesCancelled;
  if (finished && !awaitingSuccessor) {
    return "This event is finished, so there is nothing left to show a cover on.";
  }
  return null;
}

export type SetCoverResult =
  | { ok: true; mime: CoverMime; hash: string; bytes: number }
  | { ok: false; error: string };

/**
 * Validate and store the cover for the event's series (or the one-off), and
 * point every non-adopted row of it at the new hash. The image is written
 * first, so a row never names a hash whose bytes are missing. The sync then
 * sends it on its next scan.
 */
export async function setEventCover(
  event: IEvent,
  data: Buffer,
): Promise<SetCoverResult> {
  const reason = coverIneligibleReason(event);
  if (reason) return { ok: false, error: reason };
  const checked = validateCoverImage(data);
  if (!checked.ok) return checked;
  // Both writes under one lock: a concurrent set or remove for the same key
  // can neither interleave its image write between ours and our row update,
  // nor delete the image we just stored.
  await withCoverLock(event.guildId, coverKeyFor(event), async () => {
    await EventImage.findOneAndUpdate(
      { guildId: event.guildId, key: coverKeyFor(event) },
      {
        $set: {
          mime: checked.mime,
          data,
          hash: checked.hash,
          bytes: data.length,
        },
      },
      { upsert: true },
    );
    await Event.updateMany(coverRowsFilter(event), {
      $set: { coverHash: checked.hash, nativeCoverAttempts: 0 },
    });
  });
  return {
    ok: true,
    mime: checked.mime,
    hash: checked.hash,
    bytes: data.length,
  };
}

/**
 * Remove the cover of the event's series (or the one-off). The rows are
 * detached first, then the image is deleted; the sync clears the native cover
 * for rows whose last-sent hash is still set.
 */
export async function removeEventCover(
  event: IEvent,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const reason = coverIneligibleReason(event);
  if (reason) return { ok: false, error: reason };
  await withCoverLock(event.guildId, coverKeyFor(event), async () => {
    // A row with failed (possibly landed) sends keeps one pending attempt, so
    // the sync still sends a single `image: null` for it; others reset to 0.
    await Event.updateMany(coverRowsFilter(event), [
      {
        $set: {
          coverHash: null,
          nativeCoverAttempts: {
            $cond: [{ $gt: ["$nativeCoverAttempts", 0] }, 1, 0],
          },
        },
      },
    ]);
    await EventImage.deleteOne({
      guildId: event.guildId,
      key: coverKeyFor(event),
    });
  });
  return { ok: true };
}

export interface LoadedCover {
  hash: string;
  /** `data:<mime>;base64,...`, the form discord.js forwards as is. A Buffer
   * would be labelled `image/jpg` whatever it holds (DataResolver). */
  dataUri: string;
}

/** The stored image of an event or series as a data URI, or null. */
export async function loadEventCover(
  event: Pick<IEvent, "_id" | "seriesId" | "guildId">,
): Promise<LoadedCover | null> {
  const doc: IEventImage | null = await EventImage.findOne({
    guildId: event.guildId,
    key: coverKeyFor(event),
  });
  if (!doc) return null;
  return {
    hash: doc.hash,
    dataUri: `data:${doc.mime};base64,${Buffer.from(doc.data).toString("base64")}`,
  };
}

/**
 * Delete the images whose event or series has no live row left (finished,
 * cancelled, or never existed), and clear the hash on any row still naming
 * one. Events are never purged by retention, so this is what keeps the
 * collection from keeping images of finished series. Cheap: it reads only the
 * keys, and returns at once when there are no images.
 */
export async function sweepOrphanCovers(guildId: string): Promise<number> {
  const images = await EventImage.find({ guildId }).select("key").lean();
  let removed = 0;
  for (const { key } of images as Array<{ key: string }>) {
    // Liveness is checked inside the lock, so a series that was just revived
    // by a spawn or an upload is not swept on a stale answer.
    const gone = await withCoverLock(guildId, key, async () => {
      const live = await Event.exists({
        guildId,
        $and: [
          { $or: [{ _id: key }, { seriesId: key }] },
          {
            $or: [
              { state: { $in: ["scheduled", "active"] } },
              {
                state: { $in: ["ended", "cancelled"] },
                recurrence: { $ne: "none" },
                nextSpawned: false,
                seriesCancelled: { $ne: true },
              },
            ],
          },
        ],
      });
      if (live) return false;
      await Event.updateMany(
        { guildId, $or: [{ _id: key }, { seriesId: key }] },
        { $set: { coverHash: null } },
      );
      await EventImage.deleteOne({ guildId, key });
      return true;
    });
    if (gone) removed += 1;
  }
  if (removed > 0) {
    logger.info(`Event covers: removed ${removed} image(s) of finished events`);
  }
  return removed;
}
