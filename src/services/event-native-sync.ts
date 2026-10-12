import {
  Client,
  Collection,
  DiscordAPIError,
  Guild,
  GuildScheduledEvent,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  GuildScheduledEventStatus,
  PermissionFlagsBits,
  type Snowflake,
} from "discord.js";
import { ConfigService } from "./config-service.js";
import { Event, type IEvent } from "../models/event.js";
import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";

/**
 * Mirrors KoolBot events to Discord *native* guild scheduled events (#1034),
 * so members see them in the server's "Events" list.
 *
 * Opt-in (`events.native.enabled`, default off). KoolBot stays the source of
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
  },
  want: NativeEventFields,
): Partial<{
  name: string;
  // `null` clears it: Discord accepts 1-1000 characters or null, never "".
  description: string | null;
  scheduledStartTime: Date;
  scheduledEndTime: Date;
  entityMetadata: { location: string };
}> {
  const diff: ReturnType<typeof diffNativeFields> = {};
  if (native.name !== want.name) diff.name = want.name;
  if ((native.description ?? "") !== want.description) {
    diff.description = want.description === "" ? null : want.description;
  }
  if (native.scheduledStartTimestamp !== want.start.getTime()) {
    diff.scheduledStartTime = want.start;
  }
  if (native.scheduledEndTimestamp !== want.end.getTime()) {
    diff.scheduledEndTime = want.end;
  }
  if (
    native.entityType === GuildScheduledEventEntityType.External &&
    (native.entityMetadata?.location ?? "") !== want.location
  ) {
    diff.entityMetadata = { location: want.location };
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

  constructor(
    private readonly client: Client,
    private readonly callApi: ApiCaller = defaultApiCaller(client),
  ) {}

  public async isEnabled(): Promise<boolean> {
    try {
      return await ConfigService.getInstance().getBoolean(
        "events.native.enabled",
        false,
      );
    } catch {
      return false;
    }
  }

  /**
   * Load the guild's native events once, for a whole scan. Returns null when
   * mirroring is off or the fetch failed (callers then fall back to per-event
   * fetches).
   */
  public async loadCache(guild: Guild): Promise<NativeCache | null> {
    if (!(await this.isEnabled())) return null;
    try {
      return await this.callApi(
        () => guild.scheduledEvents.fetch(),
        "fetch guild scheduled events",
      );
    } catch (error) {
      logger.warn("Native events: could not list scheduled events:", error);
      return null;
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
      const terminal = event.state === "ended" || event.state === "cancelled";
      if (terminal && !event.nativeEventId) return;
      if (!terminal && event.nativeDetached) return;

      const g =
        guild ??
        (await this.client.guilds.fetch(event.guildId).catch(() => null));
      if (!g) return;

      if (!(await this.hasPermission(g))) return;

      if (terminal) {
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
      (me.permissions.has(PermissionFlagsBits.ManageEvents) ||
        me.permissions.has(PermissionFlagsBits.CreateEvents));
    if (ok) {
      this.warned.delete("permission");
      return true;
    }
    this.warnOnce(
      "permission",
      "Native events are enabled (events.native.enabled) but the bot lacks the Create Events / Manage Events permission; events are not mirrored to Discord's Events list. Grant it to the bot's role to enable mirroring.",
    );
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
    // gains nothing from a native entry.
    if (want.start.getTime() <= Date.now()) return;

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

    const created = await this.callApi(
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
    cache?.set(created.id, created);

    if (!(await this.claim(event, created.id))) {
      // Lost the race (or the row is gone): do not leave a duplicate behind.
      await this.callApi(
        () => guild.scheduledEvents.delete(created.id),
        "delete duplicate guild scheduled event",
      ).catch(() => undefined);
      cache?.delete(created.id);
    }
  }

  /** A bot-created native event matching this row that no row references. */
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
        n.status === GuildScheduledEventStatus.Scheduled,
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
        { $set: { nativeEventId: nativeId } },
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
    // Start/end of a running or finished event cannot be moved.
    if (native.status !== GuildScheduledEventStatus.Scheduled) return;

    const want = await this.wantedFields(event);
    if (want.start.getTime() <= Date.now()) {
      // A past start cannot be pushed; only the safe fields.
      const { name, description, entityMetadata } = diffNativeFields(
        native,
        want,
      );
      if (name === undefined && description === undefined && !entityMetadata) {
        return;
      }
      await this.callApi(
        () =>
          guild.scheduledEvents.edit(native.id, {
            ...(name !== undefined ? { name } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(entityMetadata ? { entityMetadata } : {}),
            reason: "KoolBot event mirror",
          } as unknown as EditOptions),
        "edit guild scheduled event",
      );
      return;
    }
    const diff = diffNativeFields(native, want);
    if (Object.keys(diff).length === 0) return;
    await this.callApi(
      () =>
        guild.scheduledEvents.edit(native.id, {
          ...diff,
          reason: "KoolBot event mirror",
        } as unknown as EditOptions),
      "edit guild scheduled event",
    );
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
    await Event.updateOne(
      { _id: event._id, nativeEventId: nativeId },
      { $set: { nativeEventId: null } },
    );
    event.nativeEventId = null;
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
