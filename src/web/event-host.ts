/**
 * Who may run an event from the host panel (#1189).
 *
 * The host of an event is its creator (`IEvent.createdBy`); a Web UI admin can
 * act as host of any event of the configured guild. The host is often NOT in an
 * admin session (the Administrator who scheduled the event may have signed in
 * through `/me`), so the panel is served from the member surface (`/me/events/:id/host`), which accepts both
 * session roles, and this module is the one place that decides who gets in.
 *
 * Everything here is pure and synchronous on purpose: callers read the session
 * once, load the event once, and ask. The answer fails closed: anything
 * missing, empty or mismatched is "not the host".
 */

import { env } from "../config/env.js";
import { isForeignGuild } from "../utils/guild-scope.js";
import type { WebSessionContext } from "./session.js";
import { Event } from "../models/event.js";
import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";

/** The part of a web session the access rule reads. */
export type HostSession = Pick<
  WebSessionContext,
  "discordUserId" | "guildId" | "role"
>;

/** The part of an event row the access rule reads. */
export interface HostEventRef {
  guildId?: string | null;
  createdBy?: string | null;
  state?: string | null;
  nativeCleanupOnly?: boolean | null;
}

// Model-free helpers live in their own module so layouts can import them.
export {
  hostControlsAvailable,
  hostPanelPath,
  isEventRunning,
} from "./host-panel-shared.js";
import { isEventRunning } from "./host-panel-shared.js";

/**
 * Whether a row may be shown on the host panel at all. A discarded duplicate
 * occurrence kept only until its native event is closed (`nativeCleanupOnly`)
 * is internal bookkeeping, not an event anyone hosts.
 */
export function isHostableEvent(
  event: HostEventRef | null | undefined,
): boolean {
  if (!event) return false;
  return event.nativeCleanupOnly !== true;
}

/**
 * True when `session` may open and (with later controls) change `event`.
 *
 * - The event must belong to the session's guild AND to the configured
 *   `GUILD_ID` (#1144). Both comparisons are strict string equality; the
 *   configured-guild check is skipped only when `GUILD_ID` is unset, which
 *   startup refuses.
 * - An `admin` session is the host of every event of that guild. The role is
 *   the live one: the session middleware re-checks the Administrator
 *   permission on every request. An admin who signed in through `/me` holds a
 *   `user` session and hosts only their own events.
 * - Otherwise the session user must be exactly the creator. Ids are compared
 *   as stored, never trimmed or case-folded, and an empty id never matches.
 */
export function isEventHost(
  session: HostSession | null | undefined,
  event: HostEventRef | null | undefined,
  configuredGuildId: string | undefined = env.guildId,
): boolean {
  if (!session || !event) return false;
  if (!isHostableEvent(event)) return false;
  const { guildId, discordUserId, role } = session;
  if (typeof guildId !== "string" || guildId.length === 0) return false;
  if (typeof discordUserId !== "string" || discordUserId.length === 0) {
    return false;
  }
  if (typeof event.guildId !== "string" || event.guildId !== guildId) {
    return false;
  }
  if (isForeignGuild(event.guildId, configuredGuildId)) return false;
  if (role === "admin") return true;
  if (role !== "user") return false;
  return (
    typeof event.createdBy === "string" &&
    event.createdBy.length > 0 &&
    event.createdBy === discordUserId
  );
}

/**
 * How many open events `userId` has in `guildId`: scheduled or active, the same
 * set the "Events you host" card lists (a discarded duplicate kept for native
 * cleanup, and an event an admin adopted, are not the host's). Finished and
 * cancelled events do not count. Throws when the read fails, so the caller can
 * refuse instead of letting the limit be skipped.
 */
export async function countOpenHostEvents(
  guildId: string,
  userId: string,
): Promise<number> {
  return Event.countDocuments({
    guildId,
    createdBy: userId,
    state: { $in: ["scheduled", "active"] },
    nativeCleanupOnly: { $ne: true },
    nativeAdopted: { $ne: true },
  });
}

/** Row shown in the "Events you host" card on the member overview. */
export interface HostedEventSummary {
  id: string;
  title: string;
  startTime: Date;
  timezone: string;
  state: string;
}

/** Most events the overview card lists. */
export const HOSTED_EVENTS_LIMIT = 10;

/**
 * Open (`scheduled` or `active`) events the member created, soonest first,
 * for the "Host panel" links on the member overview. Adopted events are left
 * out: the adopting admin did not create them, though an admin can still open
 * one from the admin Events list. A failed read yields an empty list, so the
 * overview renders without the card instead of failing.
 */
export async function listHostedEvents(
  guildId: string,
  userId: string,
): Promise<HostedEventSummary[]> {
  if (!guildId || !userId) return [];
  try {
    const rows = (await Event.find({
      guildId,
      createdBy: userId,
      state: { $in: ["scheduled", "active"] },
      nativeCleanupOnly: { $ne: true },
      nativeAdopted: { $ne: true },
    })
      .sort({ startTime: 1 })
      .limit(HOSTED_EVENTS_LIMIT)
      .lean()) as unknown;
    if (!Array.isArray(rows)) return [];
    return rows.map((r) => ({
      id: String(r._id),
      title: String(r.title ?? ""),
      startTime: r.startTime as Date,
      timezone: String(r.timezone ?? ""),
      state: String(r.state ?? ""),
    }));
  } catch (err) {
    logger.warn(
      `Could not list hosted events for ${sanitizeForLog(userId)}`,
      err,
    );
    return [];
  }
}

/** One row of the host's "Your events" page. */
export interface HostEventRow {
  id: string;
  title: string;
  startTime: Date;
  timezone: string;
  state: string;
  durationMinutes: number;
  /** `isEventRunning`: active and the start has arrived. */
  running: boolean;
  /** The row can still be edited (open, not adopted). */
  editable: boolean;
  /** Part of a recurring series: Cancel then only reaches this occurrence. */
  recurring: boolean;
}

/** Most finished events the page lists. */
export const HOST_PAST_EVENTS_LIMIT = 25;
/** Most open events the page lists. */
export const HOST_OPEN_EVENTS_LIMIT = 50;

/**
 * The events `userId` created in `guildId`, for the host's own page (#1319):
 * running (`live`), planned (`upcoming`, soonest first) and finished (`past`,
 * newest first). The filter is on `createdBy` and `guildId`, both from the
 * session, so nobody else's event can appear. Adopted events are left out, as
 * on the overview: the adopting admin did not create them. Unlike the overview
 * card, a failed read throws, so the page can say so instead of showing "no
 * events".
 */
export async function listHostEvents(
  guildId: string,
  userId: string,
): Promise<{
  live: HostEventRow[];
  upcoming: HostEventRow[];
  past: HostEventRow[];
}> {
  const empty = { live: [], upcoming: [], past: [] };
  if (!guildId || !userId) return empty;
  const base = {
    guildId,
    createdBy: userId,
    nativeCleanupOnly: { $ne: true },
    nativeAdopted: { $ne: true },
  };
  const now = new Date();
  const toRows = (rows: unknown): HostEventRow[] =>
    Array.isArray(rows)
      ? rows.map((r) => ({
          id: String(r._id),
          title: String(r.title ?? ""),
          startTime: r.startTime as Date,
          timezone: String(r.timezone ?? ""),
          state: String(r.state ?? ""),
          durationMinutes: Number(r.durationMinutes ?? 0),
          running: isEventRunning(r, now),
          editable: r.state === "scheduled" || r.state === "active",
          recurring: Boolean(
            r.recurrence && r.recurrence !== "none" && r.seriesId,
          ),
        }))
      : [];
  const [open, past] = await Promise.all([
    Event.find({ ...base, state: { $in: ["scheduled", "active"] } })
      .sort({ startTime: 1 })
      .limit(HOST_OPEN_EVENTS_LIMIT)
      .lean() as unknown,
    Event.find({ ...base, state: { $in: ["ended", "cancelled"] } })
      .sort({ startTime: -1 })
      .limit(HOST_PAST_EVENTS_LIMIT)
      .lean() as unknown,
  ]);
  // Running is `isEventRunning`: an `active` event whose start is still ahead
  // (its channel was prepared early) stays upcoming, with Edit and Cancel.
  const openRows = toRows(open);
  return {
    live: openRows.filter((r) => r.running),
    upcoming: openRows.filter((r) => !r.running),
    past: toRows(past),
  };
}
