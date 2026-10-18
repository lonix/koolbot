import {
  ChannelType,
  DiscordAPIError,
  OverwriteType,
  PermissionFlagsBits,
  RateLimitError,
  Routes,
  type CategoryChannel,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type PermissionsBitField,
  type REST,
  type VoiceChannel,
} from "discord.js";
import { Event } from "../models/event.js";
import {
  cancellableCall,
  createWriteRest,
  describeWriteFailure,
  rateLimitWaitMs,
} from "../web/channel-write-rest.js";
import { createKeyedLock } from "../utils/keyed-lock.js";
import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";

/**
 * Voice channels of event groups (#1190): one per group, next to the event's
 * main channel.
 *
 * What this module promises, in the order the owner reviewed channel writes
 * (#1172, #1173):
 *
 * - Every write goes through `CommandManager.makeDiscordApiCall` on the
 *   no-retry write client (`createWriteRest`), one request at a time with a
 *   short pause between them. A create is never replayed after a timeout.
 * - A channel id is recorded with one atomic update per group
 *   (`groups.$.channelId`, filtered on the group still having none and the
 *   event still being open). The event document in memory is never edited, so
 *   a later `event.save()` cannot write a stale group list over a newer one.
 * - Only a channel whose id is recorded on a group is ever deleted. It is read
 *   again with `force: true` first; only a confirmed "unknown channel" (10003)
 *   counts as gone, any other failure keeps the id and tries again next scan.
 *   A channel with someone in it is left until it is empty.
 * - One failed group never stops the others; every failure is returned in the
 *   report, which the host panel (#1189) shows.
 */

const DISCORD_UNKNOWN_CHANNEL = 10003;
const DISCORD_MISSING_PERMISSIONS = 50013;
const MS_PER_MINUTE = 60 * 1000;

/** Pause between two channel writes, so a big batch stays under Discord's limits. */
export const GROUP_WRITE_PACE_MS = 600;
/** After a create whose outcome is unknown, wait this long before trying again. */
export const UNCONFIRMED_CREATE_BACKOFF_MS = 10 * MS_PER_MINUTE;
/**
 * After Discord refused a create (a full category, a missing permission), wait
 * this long: the refusal will repeat until someone fixes it, and the scan runs
 * every minute.
 */
export const REFUSED_CREATE_BACKOFF_MS = 5 * MS_PER_MINUTE;
/** Never retry a rate-limited create sooner than this. */
const MIN_RATE_LIMIT_BACKOFF_MS = MS_PER_MINUTE;

/** What the host gets on the main channel and on every group channel. */
export const HOST_CHANNEL_PERMISSIONS =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.Connect |
  PermissionFlagsBits.MoveMembers;

const SNOWFLAKE = /^\d{16,20}$/;
const CHANNEL_NAME_MAX = 100;

/** The group fields this module reads (a lean row has no defaults). */
interface GroupRow {
  key: string;
  name: string;
  size?: number | null;
  marker?: string;
  channelId?: string | null;
}

interface EventRow {
  _id: unknown;
  guildId: string;
  state: string;
  startTime: Date;
  durationMinutes: number;
  channelId?: string | null;
  categoryId?: string;
  createdBy?: string;
  seriesCancelled?: boolean;
  groupsEnabled?: boolean;
  groups?: GroupRow[];
}

export interface GroupChannelFailure {
  key: string;
  name: string;
  reason: string;
}

/** The one result a pass returns: what was done and what could not be. */
export interface GroupChannelReport {
  created: number;
  removed: number;
  /** Channels deliberately left for the next scan (someone is in them). */
  occupied: number;
  failures: GroupChannelFailure[];
  warnings: string[];
}

export function emptyReport(): GroupChannelReport {
  return { created: 0, removed: 0, occupied: 0, failures: [], warnings: [] };
}

export interface OverwriteSpec {
  id: string;
  type: OverwriteType;
  allow: bigint;
  deny: bigint;
}

/**
 * `<prefix> <marker> <name>`, whitespace collapsed, at most 100 characters
 * (Discord's cap, counted in characters so an emoji marker is never cut).
 */
export function groupChannelName(
  prefix: string,
  group: { name: string; marker?: string | null },
): string {
  const raw = [prefix, group.marker ?? "", group.name]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ");
  return Array.from(raw).slice(0, CHANNEL_NAME_MAX).join("");
}

/**
 * The overwrites for a new channel in `category` that also give the host View,
 * Connect and Move Members.
 *
 * Sending any overwrites at creation replaces what the channel would inherit
 * from its category, so the category's own overwrites are copied in first: a
 * private events category stays private. The host's own entry, when the
 * category has one, is widened, never replaced.
 */
export function buildHostOverwrites(
  category: CategoryChannel,
  hostId: string,
): OverwriteSpec[] {
  const specs = new Map<string, OverwriteSpec>();
  for (const overwrite of category.permissionOverwrites.cache.values()) {
    specs.set(`${overwrite.type}:${overwrite.id}`, {
      id: overwrite.id,
      type: overwrite.type,
      allow: overwrite.allow.bitfield,
      deny: overwrite.deny.bitfield,
    });
  }
  const key = `${OverwriteType.Member}:${hostId}`;
  const existing = specs.get(key);
  specs.set(key, {
    id: hostId,
    type: OverwriteType.Member,
    allow: (existing?.allow ?? 0n) | HOST_CHANNEL_PERMISSIONS,
    deny: (existing?.deny ?? 0n) & ~HOST_CHANNEL_PERMISSIONS,
  });
  return [...specs.values()];
}

/** What can be said about the bot's permissions in a category, or null if unknown. */
function botPermissionsIn(
  guild: Guild,
  category: CategoryChannel,
): Readonly<PermissionsBitField> | null {
  const me = guild.members?.me;
  if (!me) return null;
  try {
    return me.permissionsIn(category);
  } catch {
    return null;
  }
}

type ApiCaller = <T>(
  fn: (signal: AbortSignal) => Promise<T>,
  name: string,
  retryOnTimeout: boolean,
) => Promise<T>;

export interface GroupChannelDeps {
  /** The category the event's channels live in, or null (already logged). */
  resolveCategory: (
    event: EventRow,
    guild: Guild,
  ) => Promise<CategoryChannel | null>;
  /** `events.channel_prefix`. */
  getPrefix: () => Promise<string>;
  /** `events.channel_grace_minutes`, in milliseconds. */
  getGraceMs: () => Promise<number>;
}

export interface GroupChannelOptions {
  /** Tests: stand in for the write client. */
  rest?: REST;
  /** Tests: stand in for `makeDiscordApiCall`. */
  call?: ApiCaller;
  paceMs?: number;
}

export class EventGroupChannels {
  private readonly lock = createKeyedLock();
  private readonly reports = new Map<string, GroupChannelReport>();
  /** `event:group` -> when a failed create may be tried again, and why it failed. */
  private readonly holds = new Map<string, { until: number; reason: string }>();
  /** Warnings already logged, so a standing problem is not logged every scan. */
  private readonly warned = new Set<string>();
  private restClient: REST | null;
  private readonly callOverride?: ApiCaller;
  private readonly paceMs: number;

  constructor(
    private readonly client: Client,
    private readonly deps: GroupChannelDeps,
    options: GroupChannelOptions = {},
  ) {
    this.restClient = options.rest ?? null;
    this.callOverride = options.call;
    this.paceMs = options.paceMs ?? GROUP_WRITE_PACE_MS;
  }

  /** The last report for an event, for the host panel (#1189). */
  public getReport(eventId: string): GroupChannelReport | null {
    return this.reports.get(eventId) ?? null;
  }

  /**
   * Overwrites for the main channel of a group event: the host's access on top
   * of the category's own. Null (with a warning) when the bot cannot grant it,
   * so the channel is then created as a plain one.
   */
  public hostOverwritesFor(
    event: { _id: unknown; createdBy?: string },
    guild: Guild,
    category: CategoryChannel,
    warnings: string[],
  ): OverwriteSpec[] | null {
    const hostId = event.createdBy ?? "";
    if (!SNOWFLAKE.test(hostId)) {
      this.warnOnce(
        event,
        "host-id",
        "The event's host is not a Discord user, so the host got no extra channel access.",
        warnings,
      );
      return null;
    }
    const perms = botPermissionsIn(guild, category);
    if (
      perms &&
      !(
        perms.has(PermissionFlagsBits.ManageRoles) &&
        perms.has(PermissionFlagsBits.MoveMembers)
      )
    ) {
      this.warnOnce(
        event,
        "host-perms",
        "The bot lacks Manage Roles or Move Members in the events category, so the host got no extra channel access. Grant both to the bot's role.",
        warnings,
      );
      return null;
    }
    return buildHostOverwrites(category, hostId);
  }

  // -------------------------------------------------------------
  // Create and reconcile
  // -------------------------------------------------------------

  /**
   * Make the group channels of an open event match its record: create the ones
   * a group has no channel for, and re-create the ones whose recorded channel
   * no longer exists. Safe to run on every scan and after a restart.
   */
  public reconcile(
    event: { _id: unknown },
    guild: Guild,
  ): Promise<GroupChannelReport> {
    // Everything the pass needs from the caller is taken here, synchronously.
    const eventId = String(event._id);
    return this.lock.run(eventId, () => this.reconcileLocked(eventId, guild));
  }

  private async reconcileLocked(
    eventId: string,
    guild: Guild,
  ): Promise<GroupChannelReport> {
    const report = emptyReport();
    const row = await this.readFresh(eventId);
    if (
      !row ||
      row.groupsEnabled !== true ||
      !(row.state === "scheduled" || row.state === "active") ||
      row.seriesCancelled === true ||
      !row.channelId ||
      (row.groups ?? []).length === 0
    ) {
      return report;
    }
    this.reports.set(eventId, report);

    const category = await this.deps.resolveCategory(row, guild);
    if (!category) {
      report.warnings.push(
        "The events category could not be found, so no group channels were created.",
      );
      return report;
    }
    const perms = botPermissionsIn(guild, category);
    if (perms && !perms.has(PermissionFlagsBits.ManageChannels)) {
      this.warnOnce(
        row,
        "manage-channels",
        "The bot lacks Manage Channels in the events category, so no group channels were created and the event runs with its main channel only. Grant it to the bot's role.",
        report.warnings,
      );
      return report;
    }

    const prefix = await this.deps.getPrefix();
    const overwrites = this.hostOverwritesFor(
      row,
      guild,
      category,
      report.warnings,
    );
    let wrote = false;
    let rateLimited = false;

    for (const group of row.groups ?? []) {
      const groupKey = `${eventId}:${group.key}`;
      const recorded = group.channelId ?? null;

      if (recorded) {
        // Existence only: the gateway drops a deleted channel from the cache.
        if (guild.channels.cache.has(recorded)) continue;
        const state = await this.readChannel(guild, recorded);
        if (state.status === "ok") continue;
        if (state.status === "error") {
          report.failures.push({
            key: group.key,
            name: group.name,
            reason: `Could not check the group channel: ${describeWriteFailure(state.error)}`,
          });
          continue;
        }
        // Confirmed gone: forget the id, then make a new channel below.
        await this.clearRecorded(eventId, group.key, recorded);
      }

      if (rateLimited) {
        report.failures.push({
          key: group.key,
          name: group.name,
          reason: "Not attempted: Discord is rate limiting. Retried next scan.",
        });
        continue;
      }
      const hold = this.holds.get(groupKey);
      if (hold && Date.now() < hold.until) {
        report.failures.push({
          key: group.key,
          name: group.name,
          reason: hold.reason,
        });
        continue;
      }

      if (wrote && this.paceMs > 0) await sleep(this.paceMs);
      wrote = true;
      const name = groupChannelName(prefix, group);
      const outcome = await this.createOne(
        row,
        guild,
        category,
        group,
        name,
        overwrites,
        report,
      );
      if (outcome.kind === "rate-limited") rateLimited = true;
      if (outcome.hold) {
        this.holds.set(groupKey, {
          until: Date.now() + outcome.hold.ms,
          reason: outcome.hold.reason,
        });
      } else {
        this.holds.delete(groupKey);
      }
    }
    return report;
  }

  private async createOne(
    row: EventRow,
    guild: Guild,
    category: CategoryChannel,
    group: GroupRow,
    name: string,
    overwrites: OverwriteSpec[] | null,
    report: GroupChannelReport,
  ): Promise<{
    kind: "ok" | "failed" | "rate-limited" | "unconfirmed";
    /** Set when this group must not be tried again straight away. */
    hold?: { ms: number; reason: string };
  }> {
    const eventId = String(row._id);
    const post = (withOverwrites: boolean): Promise<{ id: string }> =>
      this.call(
        (signal) =>
          this.rest().post(Routes.guildChannels(guild.id), {
            body: {
              name,
              type: ChannelType.GuildVoice,
              parent_id: category.id,
              user_limit: group.size ?? 0,
              ...(withOverwrites && overwrites
                ? {
                    permission_overwrites: overwrites.map((o) => ({
                      id: o.id,
                      type: o.type,
                      allow: o.allow.toString(),
                      deny: o.deny.toString(),
                    })),
                  }
                : {}),
            },
            reason: `Event group channel (${sanitizeForLog(String(row._id))})`,
            signal,
          }),
        "create event group channel",
        // A create is not idempotent: never replay it after a timeout.
        false,
      ) as Promise<{ id: string }>;

    let created: { id: string };
    try {
      try {
        created = await post(true);
      } catch (error) {
        // A refusal for the host's overwrites must not cost the channel: the
        // same channel without them inherits the category, as a plain one does.
        if (
          overwrites &&
          error instanceof DiscordAPIError &&
          error.code === DISCORD_MISSING_PERMISSIONS
        ) {
          this.warnOnce(
            row,
            "overwrite-refused",
            "Discord refused the host's channel access, so the group channels were created without it.",
            report.warnings,
          );
          created = await post(false);
        } else {
          throw error;
        }
      }
    } catch (error) {
      const reason = describeWriteFailure(error);
      report.failures.push({ key: group.key, name: group.name, reason });
      logger.warn(
        `Event ${sanitizeForLog(eventId)}: group channel for ${sanitizeForLog(group.name)} not created: ${sanitizeForLog(reason)}`,
      );
      if (error instanceof RateLimitError) {
        return {
          kind: "rate-limited",
          hold: {
            ms: Math.max(MIN_RATE_LIMIT_BACKOFF_MS, rateLimitWaitMs(error)),
            reason: `${reason} Tried again later.`,
          },
        };
      }
      if (error instanceof DiscordAPIError) {
        // Discord answered no: nothing was created. The same request would be
        // refused again until someone fixes the cause, so wait before retrying.
        return {
          kind: "failed",
          hold: {
            ms: REFUSED_CREATE_BACKOFF_MS,
            reason: `${reason} Tried again later.`,
          },
        };
      }
      // Timeout or lost answer: Discord may have made it. Reading state cannot
      // tell it apart from a foreign channel with the same name, so it is
      // never adopted; the create is just not repeated for a while.
      return {
        kind: "unconfirmed",
        hold: {
          ms: UNCONFIRMED_CREATE_BACKOFF_MS,
          reason:
            "An earlier attempt may or may not have created this channel. Check the events category in Discord; it is tried again later.",
        },
      };
    }

    // Record it. The update only matches while the group still has no channel
    // and the event is still open, so two passes or a cancel cannot both win.
    let matched = false;
    try {
      const result = await Event.updateOne(
        {
          _id: eventId,
          state: { $in: ["scheduled", "active"] },
          seriesCancelled: { $ne: true },
          groups: { $elemMatch: { key: group.key, channelId: null } },
        },
        { $set: { "groups.$.channelId": created.id } },
      );
      matched = (result?.matchedCount ?? 0) > 0;
    } catch (error) {
      logger.error(
        `Event ${sanitizeForLog(eventId)}: could not record group channel ${sanitizeForLog(created.id)}; removing it:`,
        error,
      );
    }
    if (!matched) {
      // Ours (just created, id from Discord's own answer) and unrecorded, so
      // removing it is safe and leaves nothing behind.
      await this.deleteCreated(guild, created.id);
      report.failures.push({
        key: group.key,
        name: group.name,
        reason:
          "The event changed while the channel was being created; it was removed again.",
      });
      return { kind: "failed" };
    }
    report.created += 1;
    logger.info(
      `Created group channel ${sanitizeForLog(name)} for event ${sanitizeForLog(eventId)}`,
    );
    return { kind: "ok" };
  }

  // -------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------

  /**
   * Delete the recorded group channels of an event that is over: right away
   * once it is cancelled, after the grace period once it has ended (the moment
   * the main channel is eligible). Channels with people in them stay until the
   * next scan. The decision uses a fresh read of the event, never the caller's
   * copy, and does nothing for an event that is still open.
   */
  public cleanup(
    event: { _id: unknown },
    guild: Guild,
    now: Date,
  ): Promise<GroupChannelReport> {
    const eventId = String(event._id);
    return this.lock.run(eventId, () =>
      this.cleanupLocked(eventId, guild, now),
    );
  }

  private async cleanupLocked(
    eventId: string,
    guild: Guild,
    now: Date,
  ): Promise<GroupChannelReport> {
    const report = emptyReport();
    const row = await this.readFresh(eventId);
    if (!row) return report;
    const recorded = (row.groups ?? []).filter((g) => !!g.channelId);
    if (recorded.length === 0) {
      this.forget(eventId);
      return report;
    }
    if (row.state === "ended") {
      const end =
        row.startTime.getTime() +
        Math.max(0, row.durationMinutes) * MS_PER_MINUTE;
      if (now.getTime() < end + (await this.deps.getGraceMs())) return report;
    } else if (row.state !== "cancelled") {
      return report;
    }

    let wrote = false;
    let rateLimited = false;
    for (const group of recorded) {
      const channelId = group.channelId as string;
      const state = await this.readChannel(guild, channelId);
      if (state.status === "gone") {
        await this.clearRecorded(eventId, group.key, channelId);
        continue;
      }
      if (state.status === "error") {
        report.failures.push({
          key: group.key,
          name: group.name,
          reason: `Could not check the group channel: ${describeWriteFailure(state.error)}`,
        });
        continue;
      }
      const channel = state.channel;
      if (
        channel.type !== ChannelType.GuildVoice ||
        channel.guildId !== guild.id
      ) {
        // The recorded id is no longer a voice channel of this server: it is
        // not ours to delete. Drop the record only.
        logger.warn(
          `Event ${sanitizeForLog(eventId)}: recorded group channel ${sanitizeForLog(channelId)} is not a voice channel; leaving it alone`,
        );
        await this.clearRecorded(eventId, group.key, channelId);
        continue;
      }
      if ((channel as VoiceChannel).members.size > 0) {
        report.occupied += 1;
        continue;
      }
      if (rateLimited) {
        report.failures.push({
          key: group.key,
          name: group.name,
          reason: "Not attempted: Discord is rate limiting. Retried next scan.",
        });
        continue;
      }
      if (wrote && this.paceMs > 0) await sleep(this.paceMs);
      wrote = true;
      try {
        await this.call(
          (signal) =>
            this.rest().delete(Routes.channel(channelId), {
              reason: "Event ended",
              signal,
            }),
          "delete event group channel",
          // Deleting twice is harmless (the second answer is 10003).
          true,
        );
      } catch (error) {
        if (!(
          error instanceof DiscordAPIError &&
          error.code === DISCORD_UNKNOWN_CHANNEL
        )) {
          report.failures.push({
            key: group.key,
            name: group.name,
            reason: describeWriteFailure(error),
          });
          if (error instanceof RateLimitError) rateLimited = true;
          // The id stays: the next scan reads the channel again.
          continue;
        }
      }
      await this.clearRecorded(eventId, group.key, channelId);
      report.removed += 1;
      logger.info(
        `Removed group channel ${sanitizeForLog(channelId)} of event ${sanitizeForLog(eventId)}`,
      );
    }
    if (report.failures.length === 0 && report.occupied === 0) {
      this.forget(eventId);
    }
    return report;
  }

  // -------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------

  private forget(eventId: string): void {
    this.reports.delete(eventId);
    for (const key of [...this.holds.keys()]) {
      if (key.startsWith(`${eventId}:`)) this.holds.delete(key);
    }
    for (const key of [...this.warned]) {
      if (key.startsWith(`${eventId}:`)) this.warned.delete(key);
    }
  }

  private warnOnce(
    event: { _id: unknown },
    kind: string,
    message: string,
    warnings: string[],
  ): void {
    warnings.push(message);
    const key = `${String(event._id)}:${kind}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    logger.warn(`Event ${sanitizeForLog(String(event._id))}: ${message}`);
  }

  private async readFresh(eventId: string): Promise<EventRow | null> {
    try {
      return (await Event.findById(eventId).lean()) as EventRow | null;
    } catch (error) {
      logger.error(
        `Event ${sanitizeForLog(eventId)}: could not read the event for its group channels:`,
        error,
      );
      return null;
    }
  }

  /**
   * Read a channel from Discord, not the cache, before a decision that depends
   * on it (deleting, or concluding it is gone).
   */
  private async readChannel(
    guild: Guild,
    channelId: string,
  ): Promise<
    | { status: "ok"; channel: GuildBasedChannel }
    | { status: "gone" }
    | { status: "error"; error: unknown }
  > {
    try {
      const channel = await guild.channels.fetch(channelId, { force: true });
      if (!channel) return { status: "gone" };
      return { status: "ok", channel };
    } catch (error) {
      if (
        error instanceof DiscordAPIError &&
        error.code === DISCORD_UNKNOWN_CHANNEL
      ) {
        return { status: "gone" };
      }
      return { status: "error", error };
    }
  }

  private async clearRecorded(
    eventId: string,
    groupKey: string,
    channelId: string,
  ): Promise<void> {
    try {
      await Event.updateOne(
        {
          _id: eventId,
          groups: { $elemMatch: { key: groupKey, channelId } },
        },
        { $set: { "groups.$.channelId": null } },
      );
    } catch (error) {
      logger.error(
        `Event ${sanitizeForLog(eventId)}: could not clear group channel ${sanitizeForLog(channelId)}:`,
        error,
      );
    }
  }

  /** Delete a channel this pass created itself and could not record. */
  private async deleteCreated(guild: Guild, channelId: string): Promise<void> {
    try {
      await this.call(
        (signal) =>
          this.rest().delete(Routes.channel(channelId), {
            reason: "Event group channel was not recorded",
            signal,
          }),
        "delete unrecorded event group channel",
        true,
      );
    } catch (error) {
      if (
        error instanceof DiscordAPIError &&
        error.code === DISCORD_UNKNOWN_CHANNEL
      ) {
        return;
      }
      logger.error(
        `Could not remove unrecorded group channel ${sanitizeForLog(channelId)} in ${sanitizeForLog(guild.id)}; delete it by hand:`,
        error,
      );
    }
  }

  private rest(): REST {
    if (!this.restClient) {
      if (!this.client.token) throw new Error("The bot is not logged in");
      this.restClient = createWriteRest(this.client.token);
    }
    return this.restClient;
  }

  private async call<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    name: string,
    retryOnTimeout: boolean,
  ): Promise<T> {
    if (this.callOverride) return this.callOverride(fn, name, retryOnTimeout);
    const { CommandManager } = await import("./command-manager.js");
    return cancellableCall(
      CommandManager.getInstance(this.client),
      fn,
      name,
      retryOnTimeout,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const handle = setTimeout(resolve, ms);
    handle.unref?.();
  });
}
