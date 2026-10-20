import {
  Client,
  Collection,
  DiscordAPIError,
  Guild,
  GuildScheduledEvent,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  GuildScheduledEventStatus,
  type Snowflake,
} from "discord.js";
import { NATIVE_EVENTS_WARNING, PERM } from "./bot-permission-registry.js";
import { ConfigService } from "./config-service.js";
import { Event, type IEvent } from "../models/event.js";
import {
  coverKeyFor,
  loadEventCover,
  MAX_COVER_ATTEMPTS,
} from "./event-cover.js";
import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";

/**
 * Mirrors KoolBot events to Discord *native* guild scheduled events (#1034),
 * so members see them in the server's "Events" list.
 *
 * Native is the only mode (#1175): the sync runs whenever the Events feature
 * itself is on (`events.enabled`). KoolBot stays the source of
 * truth: the native event is created, updated and closed to match the Mongo
 * row, never the other way round in this slice.
 *
 * Restart safety: the native event's id is persisted on the row
 * (`nativeEventId`) with an atomic compare-and-set, so a restart reads the link
 * back instead of creating a second event. Before creating, the sync also looks
 * for a bot-created native event with the same name and start that no row
 * references yet (a crash between "create" and "save the id"), and adopts it.
 *
 * Every entry point is best-effort and never throws: a Discord failure must not
 * break the event lifecycle. A missing permission is reported once per process
 * (not every scan tick) and clears itself when the permission comes back.
 *
 * Discord facts relied on (see the PR for which are verified against
 * discord-api-types and which are not):
 * - external events need a location (max 100 chars) and an end time;
 * - name max 100, description max 1000;
 * - a scheduled event can only move Scheduled to Active/Canceled, and Active
 *   to Completed;
 * - the start time of a new event must be in the future.
 */

const MS_PER_MINUTE = 60 * 1000;
const NAME_MAX = 100;
const DESCRIPTION_MAX = 1000;
const LOCATION_MAX = 100;
const DISCORD_UNKNOWN_SCHEDULED_EVENT = 10070;
/** How long a started-but-unclaimed create is given to show up in Discord
 * (a timed-out request may still complete) before it is retried. */
/** At most this many native events are created per scan (once a minute), so
 * enabling mirroring for a guild with many future events backfills in small
 * steps instead of one burst of REST calls. */
export const MAX_CREATES_PER_SCAN = 5;
export const CREATE_GRACE_MS = 5 * MS_PER_MINUTE;

export const DEFAULT_NATIVE_LOCATION =
  "Voice channel in this server (see the event announcement)";

/** What the mirror wants the native event to look like for a row. */
export interface NativeEventFields {
  name: string;
  description: string;
  start: Date;
  end: Date;
  location: string;
}

/** Pure: the native-event fields derived from a KoolBot event. */
export function buildNativeFields(
  event: Pick<
    IEvent,
    "title" | "description" | "startTime" | "durationMinutes"
  >,
  location: string,
): NativeEventFields {
  // Discord rejects an end that is not after the start.
  const minutes = Math.max(1, event.durationMinutes || 0);
  return {
    name: event.title.slice(0, NAME_MAX),
    description: (event.description ?? "").slice(0, DESCRIPTION_MAX),
    start: event.startTime,
    end: new Date(event.startTime.getTime() + minutes * MS_PER_MINUTE),
    location: (location.trim() || DEFAULT_NATIVE_LOCATION).slice(
      0,
      LOCATION_MAX,
    ),
  };
}

/** Pure: which fields of an existing native event differ from the wanted ones. */
export function diffNativeFields(
  native: {
    name: string;
    description: string | null;
    scheduledStartTimestamp: number | null;
    scheduledEndTimestamp: number | null;
    entityType: GuildScheduledEventEntityType;
    entityMetadata: { location: string | null } | null;
    channelId?: string | null;
  },
  want: NativeEventFields,
): Partial<{
  name: string;
  // `null` clears it: Discord accepts 1-1000 characters or null, never "".
  description: string | null;
  scheduledStartTime: Date;
  scheduledEndTime: Date;
  entityMetadata: { location: string };
  entityType: GuildScheduledEventEntityType;
  channel: null;
}> {
  const diff: ReturnType<typeof diffNativeFields> = {};
  if (native.name !== want.name) diff.name = want.name;
  if ((native.description ?? "") !== want.description) {
    diff.description = want.description === "" ? null : want.description;
  }
  if (native.scheduledStartTimestamp !== want.start.getTime()) {
    diff.scheduledStartTime = want.start;
  }
  if (native.entityType !== GuildScheduledEventEntityType.External) {
    // An admin switched the mirror to a voice/stage event. Put it back: the
    // typings allow `entityType: External` with `channel: null` plus a
    // location and an end time (all three sent together). Not verified
    // against Discord itself.
    diff.entityType = GuildScheduledEventEntityType.External;
    diff.channel = null;
    diff.entityMetadata = { location: want.location };
    diff.scheduledEndTime = want.end;
  } else {
    if (native.scheduledEndTimestamp !== want.end.getTime()) {
      diff.scheduledEndTime = want.end;
    }
    if ((native.entityMetadata?.location ?? "") !== want.location) {
      diff.entityMetadata = { location: want.location };
    }
  }
  return diff;
}

export type NativeCache = Collection<Snowflake, GuildScheduledEvent>;

// discord.js types `description` as `string`, but its manager forwards it
// verbatim into the REST body, whose typing (RESTPatchAPIGuildScheduledEventJSONBody)
// allows `null` to clear it. Edits that clear a description are cast through this.
type EditOptions = Parameters<Guild["scheduledEvents"]["edit"]>[1];

type ApiCaller = <T>(call: () => Promise<T>, name: string) => Promise<T>;

export class NativeEventSync {
  private readonly warned = new Set<string>();
  private createsThisScan = 0;

  constructor(
    private readonly client: Client,
    private readonly callApi: ApiCaller = defaultApiCaller(client),
  ) {}

  public async isEnabled(): Promise<boolean> {
    try {
      const config = ConfigService.getInstance();
      // Inert unless the Events feature is on: no REST calls, no warnings.
      return await config.getBoolean("events.enabled", false);
    } catch {
      return false;
    }
  }

  /**
   * Load the guild's native events once, for a whole scan. Returns null when
   * mirroring is off, and `"failed"` when the listing failed: the caller then
   * skips native sync for this tick instead of falling back to one fetch per
   * event, which would multiply a transient Discord failure by the number of
   * events.
   */
  public async loadCache(guild: Guild): Promise<NativeCache | null | "failed"> {
    if (!(await this.isEnabled())) return null;
    this.createsThisScan = 0;
    try {
      return await this.callApi(
        () => guild.scheduledEvents.fetch(),
        "fetch guild scheduled events",
      );
    } catch (error) {
      logger.warn(
        "Native events: could not list scheduled events; skipping native sync for this scan:",
        error,
      );
      return "failed";
    }
  }

  /**
   * Bring the native event in line with the row. Idempotent; safe to call
   * from the scan on every tick. Never throws.
   */
  public async syncEvent(
    event: IEvent,
    guild?: Guild | null,
    cache?: NativeCache | null,
  ): Promise<void> {
    try {
      if (!(await this.isEnabled())) return;
      if (event.nativeAdopted) {
        // An adopted event belongs to whoever made it in Discord: nothing here
        // writes to it (see `releaseAdopted` and `pullAdopted`).
        await this.releaseAdopted(event);
        return;
      }
      const terminal = event.state === "ended" || event.state === "cancelled";
      const pendingCreate = terminal && !event.nativeEventId;
      // A terminal row with no id is only interesting while a create it
      // started may still land in Discord (see `reconcilePendingCreate`).
      if (pendingCreate && !event.nativeCreateStartedAt) return;
      if (!terminal && event.nativeDetached) return;

      const g =
        guild ??
        (await this.client.guilds.fetch(event.guildId).catch(() => null));
      if (!g) return;

      if (!(await this.hasPermission(g))) return;

      if (pendingCreate) {
        await this.reconcilePendingCreate(event, g, cache);
      } else if (terminal) {
        await this.closeNative(event, g, cache);
      } else if (event.nativeEventId) {
        await this.updateNative(event, g, cache);
      } else {
        await this.createNative(event, g, cache);
      }
    } catch (error) {
      logger.error(
        `Native events: sync failed for event ${sanitizeForLog(String(event._id))}:`,
        error,
      );
    }
  }

  // ---------------------------------------------------------------
  // Adopted events (#1034): read-only towards Discord
  // ---------------------------------------------------------------

  /**
   * A finished or cancelled adopted row only lets go of its native event. The
   * native event is left exactly as it is: it was made by a member, so it is
   * never cancelled, completed or deleted from here.
   */
  private async releaseAdopted(event: IEvent): Promise<void> {
    const terminal = event.state === "ended" || event.state === "cancelled";
    if (!terminal || !event.nativeEventId) return;
    const nativeId = event.nativeEventId;
    await Event.updateOne(
      { _id: event._id, nativeEventId: nativeId },
      { $set: { nativeEventId: null } },
    );
    event.nativeEventId = null;
  }

  /**
   * Follow the native event of an adopted row, which stays the source of truth:
   * its name, description, start and length are copied onto the row (so
   * reminders follow it), and `"gone"` is returned when it was deleted or
   * cancelled in Discord before it started, so the caller can cancel the row. Never writes to
   * Discord. A failed read is "ok": try again on the next scan.
   */
  public async pullAdopted(
    event: IEvent,
    guild: Guild,
    cache?: NativeCache | null,
  ): Promise<"ok" | "gone"> {
    try {
      if (!event.nativeAdopted || !event.nativeEventId) return "ok";
      // An event that has not started follows a deletion, a cancellation and
      // edits. The row's state is no guide (the temp channel makes it "active"
      // ahead of the start, and voice events never get one), so the start time
      // is. Past the start the row is only ever updated, never cancelled: a
      // missing or finished entry can't tell a deleted event from one that
      // ended, and the only thing worth catching is a postponement made just
      // before the old start (a still-scheduled event with a future start).
      const started = event.startTime.getTime() <= Date.now();
      const native = await this.fetchNative(guild, event.nativeEventId, cache);
      if (started) {
        if (
          !native ||
          native.status !== GuildScheduledEventStatus.Scheduled ||
          !native.scheduledStartAt ||
          native.scheduledStartAt.getTime() <= Date.now()
        ) {
          return "ok";
        }
      } else if (
        !native ||
        native.status === GuildScheduledEventStatus.Canceled
      ) {
        return "gone";
      }
      // A running event keeps the schedule its channel and reminder were
      // based on; only a waiting one follows edits.
      if (
        native.status !== GuildScheduledEventStatus.Scheduled ||
        !native.scheduledStartAt
      ) {
        return "ok";
      }
      const start = native.scheduledStartAt;
      const minutes = native.scheduledEndTimestamp
        ? Math.max(
            1,
            Math.ceil((native.scheduledEndTimestamp - start.getTime()) / 60000),
          )
        : event.durationMinutes;
      const next = {
        title: native.name.slice(0, NAME_MAX),
        description: (native.description ?? "").slice(0, DESCRIPTION_MAX),
        startTime: start,
        durationMinutes: minutes,
      };
      if (
        next.title !== event.title ||
        next.description !== event.description ||
        next.startTime.getTime() !== event.startTime.getTime() ||
        next.durationMinutes !== event.durationMinutes
      ) {
        // A moved start means the reminder is due again for the new time.
        const moved =
          next.startTime.getTime() !== event.startTime.getTime() &&
          event.reminderSent;
        const set = moved ? { ...next, reminderSent: false } : next;
        await Event.updateOne(
          { _id: event._id, state: { $in: ["scheduled", "active"] } },
          { $set: set },
        );
        Object.assign(event, set);
      }
      return "ok";
    } catch (error) {
      logger.warn(
        `Native events: could not read adopted event ${sanitizeForLog(String(event._id))}:`,
        error,
      );
      return "ok";
    }
  }

  /**
   * Whether the adopted event happens in a Discord channel of its own (a voice
   * or stage event), in which case KoolBot makes no temporary channel for it.
   * `null` when that is not known this scan (no listing, event not in it).
   */
  public adoptedHasChannel(
    event: IEvent,
    cache?: NativeCache | null,
  ): boolean | null {
    if (!event.nativeEventId || !cache) return null;
    const native = cache.get(event.nativeEventId);
    return native ? !!native.channelId : null;
  }

  // ---------------------------------------------------------------
  // Permission
  // ---------------------------------------------------------------

  /**
   * The bot needs Create Events (create, and edit its own) or Manage Events.
   * Missing is logged once per process and then skipped quietly.
   */
  private async hasPermission(guild: Guild): Promise<boolean> {
    const me =
      guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
    const ok =
      !!me &&
      (me.permissions.has(PERM.manageEvents.bit) ||
        me.permissions.has(PERM.createEvents.bit));
    if (ok) {
      this.warned.delete("permission");
      return true;
    }
    this.warnOnce("permission", NATIVE_EVENTS_WARNING);
    return false;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    logger.warn(message);
  }

  // ---------------------------------------------------------------
  // Create / adopt
  // ---------------------------------------------------------------

  private async wantedFields(event: IEvent): Promise<NativeEventFields> {
    const location = await ConfigService.getInstance().getString(
      "events.native.location",
      DEFAULT_NATIVE_LOCATION,
    );
    return buildNativeFields(event, location ?? "");
  }

  private async createNative(
    event: IEvent,
    guild: Guild,
    cache?: NativeCache | null,
  ): Promise<void> {
    const want = await this.wantedFields(event);
    // Discord refuses a start in the past, and an event that has already begun
    // gains nothing from a native entry, so a row with no create in flight
    // stops here. A row WITH a marker may have a late event (it can even have
    // started meanwhile), so that one goes on to the lookup below first.
    const startPast = want.start.getTime() <= Date.now();
    if (startPast && !event.nativeCreateStartedAt) return;

    const existing =
      cache ??
      (await this.callApi(
        () => guild.scheduledEvents.fetch(),
        "fetch guild scheduled events",
      ));
    const adopted = await this.findAdoptable(event, existing, want);
    if (adopted) {
      if (await this.claim(event, adopted.id)) {
        logger.info(
          `Native events: adopted ${sanitizeForLog(adopted.id)} for event ${sanitizeForLog(String(event._id))}`,
        );
      }
      return;
    }

    if (startPast) {
      // Never create in the past. Once the grace period has passed with no late
      // event, drop the marker so the row stops being reconciled.
      const startedAt = event.nativeCreateStartedAt?.getTime() ?? 0;
      if (Date.now() - startedAt >= CREATE_GRACE_MS) {
        await Event.updateOne(
          { _id: event._id },
          { $set: { nativeCreateStartedAt: null } },
        );
        event.nativeCreateStartedAt = null;
      }
      return;
    }

    // A create that was started but never claimed (timeout, crash) may still
    // land in Discord. Adoption above already looked for it; do not create
    // again until the grace period has passed with nothing found.
    // A scan (it passes the shared cache) creates at most
    // MAX_CREATES_PER_SCAN; the rest wait for the next tick. A single create
    // from the Web UI or a cancel path (no cache) is never held back.
    if (cache && this.createsThisScan >= MAX_CREATES_PER_SCAN) return;
    if (!(await this.markCreateStarted(event))) return;
    if (cache) this.createsThisScan += 1;

    let created: GuildScheduledEvent;
    try {
      created = await this.callApi(
        () =>
          guild.scheduledEvents.create({
            name: want.name,
            description: want.description || undefined,
            scheduledStartTime: want.start,
            scheduledEndTime: want.end,
            privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
            entityType: GuildScheduledEventEntityType.External,
            entityMetadata: { location: want.location },
            reason: "KoolBot event mirror",
          }),
        "create guild scheduled event",
        // Non-idempotent: never replay a create that merely timed out.
      );
    } catch (error) {
      // Discord answered with an error, so nothing was created: allow an
      // immediate retry. Anything else (timeout) may have created it; the
      // marker stays so the next scans adopt rather than duplicate.
      if (error instanceof DiscordAPIError) {
        await Event.updateOne(
          { _id: event._id },
          { $set: { nativeCreateStartedAt: null } },
        );
      }
      throw error;
    }
    cache?.set(created.id, created);

    const claimed = await this.claim(event, created.id);
    // The cover goes in its own edit, never in the create: a rejected image
    // must not stop the event from being mirrored (see `syncCover`).
    if (claimed) await this.syncCover(event, guild, created.id);
    if (!claimed) {
      // Lost the claim. Only an unreferenced event is a duplicate: another
      // row may have adopted it meanwhile, and deleting that would take its
      // mirror away.
      const owned = await Event.exists({ nativeEventId: created.id });
      if (!owned) {
        await this.callApi(
          () => guild.scheduledEvents.delete(created.id),
          "delete duplicate guild scheduled event",
        ).catch(() => undefined);
        cache?.delete(created.id);
      }
    }
  }

  /**
   * Atomically record that a create is starting. False when one was started
   * recently (within `CREATE_GRACE_MS`) and may still be in flight.
   */
  private async markCreateStarted(event: IEvent): Promise<boolean> {
    const staleBefore = new Date(Date.now() - CREATE_GRACE_MS);
    const marked = await Event.findOneAndUpdate(
      {
        _id: event._id,
        nativeEventId: null,
        // The identity the create is made with (#1298): a scan holding a row from
        // before an edit must not start a create under the old name or start.
        title: event.title,
        startTime: event.startTime,
        state: { $in: ["scheduled", "active"] },
        $or: [
          { nativeCreateStartedAt: null },
          { nativeCreateStartedAt: { $lt: staleBefore } },
        ],
      },
      { $set: { nativeCreateStartedAt: new Date() } },
    );
    return !!marked;
  }

  /** A bot-created native event matching this row that no row references.
   * A late event may already have started (Active) by the time it is found. */
  private async findAdoptable(
    event: IEvent,
    existing: NativeCache,
    want: NativeEventFields,
  ): Promise<GuildScheduledEvent | null> {
    const botId = this.client.user?.id;
    if (!botId) return null;
    const candidates = [...existing.values()].filter(
      (n) =>
        n.creatorId === botId &&
        n.name === want.name &&
        n.scheduledStartTimestamp === want.start.getTime() &&
        (n.status === GuildScheduledEventStatus.Scheduled ||
          n.status === GuildScheduledEventStatus.Active),
    );
    for (const candidate of candidates) {
      const taken = await Event.exists({
        nativeEventId: candidate.id,
        _id: { $ne: event._id },
      });
      if (!taken) return candidate;
    }
    return null;
  }

  /** Atomically store the native id; false when another writer got there. */
  private async claim(event: IEvent, nativeId: string): Promise<boolean> {
    let claimed: unknown;
    try {
      claimed = await Event.findOneAndUpdate(
        {
          _id: event._id,
          nativeEventId: null,
          state: { $in: ["scheduled", "active"] },
        },
        { $set: { nativeEventId: nativeId, nativeCreateStartedAt: null } },
      );
    } catch (error) {
      // The unique index on `nativeEventId`: another row (or replica) already
      // owns this native event, so this claim lost the race.
      if ((error as { code?: number }).code === 11000) return false;
      throw error;
    }
    if (claimed) event.nativeEventId = nativeId;
    return !!claimed;
  }

  // ---------------------------------------------------------------
  // Update
  // ---------------------------------------------------------------

  private async fetchNative(
    guild: Guild,
    nativeId: string,
    cache?: NativeCache | null,
  ): Promise<GuildScheduledEvent | null> {
    if (cache) return cache.get(nativeId) ?? null;
    try {
      return await this.callApi(
        () => guild.scheduledEvents.fetch(nativeId),
        "fetch guild scheduled event",
      );
    } catch (error) {
      if (isUnknownNative(error)) return null;
      throw error;
    }
  }

  private async updateNative(
    event: IEvent,
    guild: Guild,
    cache?: NativeCache | null,
  ): Promise<void> {
    const nativeId = event.nativeEventId as string;
    const native = await this.fetchNative(guild, nativeId, cache);
    if (!native) {
      // Deleted in Discord by a person: respect it, do not recreate.
      await Event.updateOne(
        { _id: event._id },
        { $set: { nativeEventId: null, nativeDetached: true } },
      );
      event.nativeEventId = null;
      event.nativeDetached = true;
      logger.info(
        `Native events: ${sanitizeForLog(nativeId)} was deleted in Discord; no longer mirroring event ${sanitizeForLog(String(event._id))}`,
      );
      return;
    }
    // Finished events are left alone. A running (Active) event still gets its
    // descriptive fields; only the schedule and type are suppressed for it.
    const active = native.status === GuildScheduledEventStatus.Active;
    if (native.status !== GuildScheduledEventStatus.Scheduled && !active) {
      return;
    }

    const want = await this.wantedFields(event);
    const diff = diffNativeFields(native, want);
    if (Object.keys(diff).length === 0) {
      await this.syncCover(event, guild, native.id);
      return;
    }

    // The conversion back to an external event is its own patch, so a Discord
    // rejection of it can never block the name/description/time updates.
    const converting = diff.entityType !== undefined;
    const startPast = active || want.start.getTime() <= Date.now();

    // Safe patch. A start in the past cannot be moved, and location metadata
    // is only valid on a native event that is already external.
    const safe: Record<string, unknown> = {};
    if (diff.name !== undefined) safe.name = diff.name;
    if (diff.description !== undefined) safe.description = diff.description;
    if (!startPast) {
      if (diff.scheduledStartTime)
        safe.scheduledStartTime = diff.scheduledStartTime;
      if (diff.scheduledEndTime && !converting) {
        safe.scheduledEndTime = diff.scheduledEndTime;
      }
    }
    if (!converting && diff.entityMetadata) {
      safe.entityMetadata = diff.entityMetadata;
    }
    if (Object.keys(safe).length > 0) {
      try {
        await this.callApi(
          () =>
            guild.scheduledEvents.edit(native.id, {
              ...safe,
              reason: "KoolBot event mirror",
            } as unknown as EditOptions),
          "edit guild scheduled event",
        );
      } catch (error) {
        // Whether Discord accepts edits to a running event is unverified: log
        // it and carry on; it is retried on the next scan.
        if (!active) throw error;
        logger.warn(
          `Native events: could not edit running event ${sanitizeForLog(native.id)}:`,
          error,
        );
      }
    }

    // A running event's length can be edited by the host (#1298). Discord ends
    // an external event at its end time, so a stale end would close the card
    // early or late. The start is locked, but the end alone is sent, as its own
    // patch, so a rejection never blocks the name/description patch above.
    // Whether Discord accepts it for an Active event is unverified: a failure
    // is logged once per event and the next scan tries again.
    if (
      startPast &&
      !converting &&
      diff.scheduledEndTime &&
      want.end.getTime() > Date.now()
    ) {
      try {
        await this.callApi(
          () =>
            guild.scheduledEvents.edit(native.id, {
              scheduledEndTime: diff.scheduledEndTime,
              reason: "KoolBot event mirror",
            } as unknown as EditOptions),
          "edit guild scheduled event end",
        );
      } catch (error) {
        this.warnOnce(
          `active-end:${String(event._id)}`,
          `Native events: could not move the end of running event ${sanitizeForLog(native.id)}: ${sanitizeForLog(String(error))}`,
        );
      }
    }

    if (converting && !startPast) {
      // The complete conversion goes in one patch: type, no channel, location
      // and end time. Failure is logged and retried next scan, nothing more.
      try {
        await this.callApi(
          () =>
            guild.scheduledEvents.edit(native.id, {
              entityType: diff.entityType,
              channel: null,
              entityMetadata: diff.entityMetadata,
              scheduledEndTime: want.end,
              reason: "KoolBot event mirror",
            } as unknown as EditOptions),
          "restore external guild scheduled event",
        );
      } catch (error) {
        logger.warn(
          `Native events: could not restore the external type of ${sanitizeForLog(native.id)}:`,
          error,
        );
      }
    }

    await this.syncCover(event, guild, native.id);
  }

  // ---------------------------------------------------------------
  // Cover image (#1181)
  // ---------------------------------------------------------------

  /**
   * Bring the native event's cover in line with the row's `coverHash`. The row
   * remembers what was last sent (`nativeCoverHash`), so the image travels only
   * when it is new or changed, never on every scan, and a row that never had a
   * cover costs nothing here (both hashes are null, no query, no REST call).
   *
   * It is always a separate edit: a rejected image can never block the
   * name/time/location sync or the creation of the event. A failure is logged
   * and counted on the row; after `MAX_COVER_ATTEMPTS` the sync stops until the
   * image changes (which resets the count).
   *
   * Removing a cover sends `image: null`: discord.js forwards the option as
   * `image && resolveImage(image)`, so `null` reaches the REST body as `null`,
   * which `RESTPatchAPIGuildScheduledEventJSONBody` allows to clear it, while
   * an omitted option is left out of the request.
   *
   * Adopted rows never get here (`syncEvent` returns first).
   */
  private async syncCover(
    event: IEvent,
    guild: Guild,
    nativeId: string,
  ): Promise<void> {
    const wanted = event.coverHash ?? null;
    const synced = event.nativeCoverHash ?? null;
    // A failed send may still have landed in Discord (the call times out
    // without cancelling the request), and the row cannot tell. Removing the
    // cover keeps a non-zero attempt count (see `removeEventCover`), which
    // asks for one `image: null` even though nothing is recorded as sent.
    const unconfirmed = wanted === null && (event.nativeCoverAttempts ?? 0) > 0;
    if (wanted === synced && !unconfirmed) return;
    if ((event.nativeCoverAttempts ?? 0) >= MAX_COVER_ATTEMPTS) return;

    let image: string | null = null;
    let sentHash: string | null = null;
    try {
      if (wanted) {
        const cover = await loadEventCover(event);
        if (!cover) {
          this.warnOnce(
            `cover-missing:${String(event._id)}:${wanted}`,
            `Native events: event ${sanitizeForLog(String(event._id))} names a cover image (${sanitizeForLog(coverKeyFor(event))}) that is not stored; skipping it.`,
          );
          return;
        }
        image = cover.dataUri;
        sentHash = cover.hash;
      }
      await this.callApi(
        () =>
          guild.scheduledEvents.edit(nativeId, {
            image,
            reason: "KoolBot event cover",
          } as unknown as EditOptions),
        "edit guild scheduled event cover",
      );
    } catch (error) {
      const attempts = (event.nativeCoverAttempts ?? 0) + 1;
      event.nativeCoverAttempts = attempts;
      await Event.updateOne(
        { _id: event._id, coverHash: wanted },
        { $inc: { nativeCoverAttempts: 1 } },
      ).catch(() => undefined);
      logger.warn(
        attempts >= MAX_COVER_ATTEMPTS
          ? `Native events: could not send the cover of ${sanitizeForLog(nativeId)} ${attempts} times; giving up until the image changes:`
          : `Native events: could not send the cover of ${sanitizeForLog(nativeId)} (attempt ${attempts} of ${MAX_COVER_ATTEMPTS}); will retry:`,
        error,
      );
      return;
    }
    await Event.updateOne(
      { _id: event._id },
      { $set: { nativeCoverHash: sentHash, nativeCoverAttempts: 0 } },
    );
    event.nativeCoverHash = sentHash;
    event.nativeCoverAttempts = 0;
  }

  // ---------------------------------------------------------------
  // Close (cancelled / ended)
  // ---------------------------------------------------------------

  /**
   * Finish the native event for a terminal row, then release the link so the
   * scan stops visiting it.
   *
   * Scheduled: cancelled rows are cancelled; ended rows (never started) are
   * deleted. Active: completed. Already Completed/Canceled: nothing to do.
   * If the transition fails the link is kept and retried next tick.
   */
  private async closeNative(
    event: IEvent,
    guild: Guild,
    cache?: NativeCache | null,
  ): Promise<void> {
    const nativeId = event.nativeEventId as string;
    const native = await this.fetchNative(guild, nativeId, cache);
    if (native) {
      await this.finishNative(event, guild, native);
      // `fetch()` hands back its own Collection, which `delete()` does not
      // touch: drop the closed event so a later row in the same scan with the
      // same name and start cannot adopt a native event that is already gone.
      cache?.delete(native.id);
    }
    await Event.updateOne(
      { _id: event._id, nativeEventId: nativeId },
      { $set: { nativeEventId: null } },
    );
    event.nativeEventId = null;
  }

  private async finishNative(
    event: IEvent,
    guild: Guild,
    native: GuildScheduledEvent,
  ): Promise<void> {
    if (native.status === GuildScheduledEventStatus.Scheduled) {
      if (event.state === "cancelled") {
        await this.callApi(
          () =>
            guild.scheduledEvents.edit(native.id, {
              status: GuildScheduledEventStatus.Canceled,
              reason: "KoolBot event cancelled",
            }),
          "cancel guild scheduled event",
        );
      } else {
        await this.callApi(
          () => guild.scheduledEvents.delete(native.id),
          "delete unstarted guild scheduled event",
        );
      }
    } else if (native.status === GuildScheduledEventStatus.Active) {
      await this.callApi(
        () =>
          guild.scheduledEvents.edit(native.id, {
            status: GuildScheduledEventStatus.Completed,
            reason: "KoolBot event finished",
          }),
        "complete guild scheduled event",
      );
    }
  }

  /**
   * A create that timed out may land in Discord after its row was cancelled or
   * ended, so the id was never stored. Look for the late event (same creator,
   * name and start) and close it by the normal terminal rules; give up and
   * clear the marker once the grace period has passed with nothing found.
   */
  private async reconcilePendingCreate(
    event: IEvent,
    guild: Guild,
    cache?: NativeCache | null,
  ): Promise<void> {
    const want = await this.wantedFields(event);
    const existing =
      cache ??
      (await this.callApi(
        () => guild.scheduledEvents.fetch(),
        "fetch guild scheduled events",
      ));
    const found = await this.findAdoptable(event, existing, want);
    if (found) {
      await this.finishNative(event, guild, found);
      cache?.delete(found.id);
      logger.info(
        `Native events: closed late-created ${sanitizeForLog(found.id)} for finished event ${sanitizeForLog(String(event._id))}`,
      );
    } else {
      const startedAt = event.nativeCreateStartedAt?.getTime() ?? 0;
      if (Date.now() - startedAt < CREATE_GRACE_MS) return;
    }
    await Event.updateOne(
      { _id: event._id },
      { $set: { nativeCreateStartedAt: null } },
    );
    event.nativeCreateStartedAt = null;
  }
}

function isUnknownNative(error: unknown): boolean {
  return (
    error instanceof DiscordAPIError &&
    error.code === DISCORD_UNKNOWN_SCHEDULED_EVENT
  );
}

/** Route REST work through `CommandManager.makeDiscordApiCall` (timeout +
 * backoff). Imported lazily to keep this module cheap to load and to test. */
function defaultApiCaller(client: Client): ApiCaller {
  return async <T>(call: () => Promise<T>, name: string): Promise<T> => {
    const { CommandManager } = await import("./command-manager.js");
    // Creates are not safe to replay after a timeout; everything else is.
    const retryOnTimeout = !name.startsWith("create ");
    return CommandManager.getInstance(client).makeDiscordApiCall(
      call,
      name,
      30000,
      3,
      retryOnTimeout,
    );
  };
}
