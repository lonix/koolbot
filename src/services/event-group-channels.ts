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
import { compareIds } from "../web/channel-manager.js";
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
 * - Order (#1214): after a pass that created channels, or when the cached order
 *   looks wrong, the group channels are put directly below the main channel in
 *   group order with ONE paced bulk position write under the same lock. The
 *   channels are read fresh first (`guild.channels.fetch()` with no id always
 *   asks Discord; `force` only exists for the by-id form) and nothing is
 *   written unless every recorded channel and the category could be read. Only
 *   the event's own channels are placed; a foreign channel is sent only when
 *   it has to shift to make room. A failure holds the ordering back for the
 *   same durations as a failed create and is retried by a later pass, which
 *   reads again before it writes.
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
/** Key suffix of the ordering hold in `holds`; a group key never starts with `#`. */
const ORDER_HOLD = "#order";
/** The name the host panel shows for an ordering problem. */
const ORDER_FAILURE_NAME = "Group channel order";
/** Never retry a rate-limited create sooner than this. */
const MIN_RATE_LIMIT_BACKOFF_MS = MS_PER_MINUTE;

/** What the host gets on the main channel and on every group channel. */
export const HOST_CHANNEL_PERMISSIONS =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.Connect |
  PermissionFlagsBits.MoveMembers;

const SNOWFLAKE = /^\d{16,20}$/;

/** Thrown inside a delete attempt when someone has joined the channel. */
class ChannelOccupiedError extends Error {
  constructor() {
    super("Group channel is occupied");
    this.name = "ChannelOccupiedError";
  }
}

/**
 * Which event rows own channels the voice sweeps must leave alone: any row with
 * a recorded group channel, and any group event with a recorded main channel,
 * even before its first group channel exists (or when every create failed).
 */
export function eventChannelProtectionFilter(
  guildId: string,
): Record<string, unknown> {
  return {
    guildId,
    $or: [
      { "groups.channelId": { $type: "string" } },
      { groupsEnabled: true, channelId: { $type: "string" } },
    ],
  };
}
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

/** A channel as far as ordering is concerned. */
export interface OrderChannel {
  id: string;
  parentId: string | null;
  type: ChannelType;
  rawPosition: number;
}

export interface OrderPlan {
  /** The main channel is followed by the group channels, in group order. */
  inOrder: boolean;
  /**
   * What to send when it is not: the group channels, and only the foreign
   * channels that have to shift to make room for them.
   */
  moves: Array<{ id: string; position: number }>;
}

/** Voice and stage channels sort together, below the text channels. */
export function isVoiceLike(type: ChannelType): boolean {
  return (
    type === ChannelType.GuildVoice || type === ChannelType.GuildStageVoice
  );
}

/**
 * Where the group channels go: directly below the main channel, in group order.
 *
 * `channels` are the voice-like channels of the main channel's category (the
 * main channel and `groupIds` among them). Order is compared, not raw numbers
 * (Discord may leave gaps): position, then id for equal positions, which is how
 * discord.js reads a channel's `position` (`Snowflake.compare` on a tie). A
 * category that is already right yields no write. The main channel and
 * everything above it keep their numbers. The group channels take the numbers
 * right after the main channel; a foreign channel below it is moved only until
 * one already sits past the last group channel (the rest of the sorted list
 * keeps its numbers).
 */
export function planGroupOrder(
  mainId: string,
  groupIds: readonly string[],
  channels: readonly OrderChannel[],
): OrderPlan {
  const byPosition = (a: OrderChannel, b: OrderChannel): number =>
    a.rawPosition - b.rawPosition || compareIds(a.id, b.id);
  const sorted = [...channels].sort(byPosition);
  const byId = new Map(channels.map((c) => [c.id, c]));
  const main = byId.get(mainId);
  const groups = groupIds
    .map((id) => byId.get(id))
    .filter((c): c is OrderChannel => !!c);
  if (!main || groups.length === 0) return { inOrder: true, moves: [] };

  const chain = [main, ...groups];
  const start = sorted.findIndex((c) => c.id === mainId);
  const inOrder = chain.every((c, i) => sorted[start + i]?.id === c.id);
  if (inOrder) return { inOrder: true, moves: [] };

  const groupSet = new Set(groups.map((c) => c.id));
  const others = sorted.filter((c) => !groupSet.has(c.id));
  const mainAt = others.findIndex((c) => c.id === mainId);
  const below = [...groups, ...others.slice(mainAt + 1)];
  const moves: Array<{ id: string; position: number }> = [];
  let previous = main.rawPosition;
  for (const channel of below) {
    const next = previous + 1;
    // A foreign channel already past the last placed one keeps its number, and
    // so does everything after it (they are sorted): nothing more to make room for.
    if (!groupSet.has(channel.id) && channel.rawPosition > previous) break;
    const position = next;
    previous = position;
    if (position !== channel.rawPosition) {
      moves.push({ id: channel.id, position });
    }
  }
  return moves.length === 0
    ? { inOrder: true, moves: [] }
    : { inOrder: false, moves };
}

/** The ordering facts of a discord.js channel, or null when it has none. */
function orderChannelOf(channel: unknown): OrderChannel | null {
  const c = channel as {
    id?: unknown;
    type?: unknown;
    parentId?: unknown;
    rawPosition?: unknown;
  } | null;
  if (
    !c ||
    typeof c.id !== "string" ||
    typeof c.type !== "number" ||
    typeof c.rawPosition !== "number"
  ) {
    return null;
  }
  return {
    id: c.id,
    type: c.type,
    parentId: typeof c.parentId === "string" ? c.parentId : null,
    rawPosition: c.rawPosition,
  };
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
  /** `events.channel_prefix`. */
  getPrefix: () => Promise<string>;
  /** `events.channel_grace_minutes`, in milliseconds. */
  getGraceMs: () => Promise<number>;
}

interface Placement {
  category: CategoryChannel;
  overwrites: OverwriteSpec[] | null;
  /** Why the host's access is not sent (null when it is). */
  noAccessReason: string | null;
  prefix: string;
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
  /** Standing notices about an event (the main channel's refused host access),
   * kept apart from the per-pass reports so a pass cannot replace them. */
  private readonly notices = new Map<string, Set<string>>();
  /** Per event, per recorded group channel: why that channel lacks the host's
   * access. Kept until that channel is removed or replaced. */
  private readonly channelWarnings = new Map<string, Map<string, string>>();
  /** `event:group` -> when a failed create may be tried again, and why it failed. */
  private readonly holds = new Map<string, { until: number; reason: string }>();
  /** Warnings already logged, so a standing problem is not logged every scan. */
  private readonly warned = new Set<string>();
  /** Per event: the position write that last went through. A fresh read that
   * still wants exactly that write means Discord did not take it, and sending
   * it again would repeat the request every scan (see `orderLocked`). Cleared
   * as soon as the order is seen right, so a later, different problem is
   * written, never mistaken for this one. */
  private readonly orderWritten = new Map<string, string>();
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
    const base = this.reports.get(eventId) ?? null;
    const extra = [
      ...(this.notices.get(eventId) ?? []),
      ...(this.channelWarnings.get(eventId)?.values() ?? []),
    ];
    if (!base && extra.length === 0) return null;
    const report = base ?? emptyReport();
    return {
      ...report,
      warnings: [...new Set([...extra, ...report.warnings])],
    };
  }

  /** Keep a notice about an event for the host panel until its channels are gone. */
  public addNotice(event: { _id: unknown }, text: string): void {
    const id = String(event._id);
    const set = this.notices.get(id) ?? new Set<string>();
    set.add(text);
    this.notices.set(id, set);
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
   * Does the gateway cache show the group channels out of place (the scan's
   * trigger for an ordering pass)? Cache only, no Discord call, and never the
   * basis of a write: the pass reads fresh. Unknown counts as "no" (a channel
   * or position that is not cached), as does a pending ordering hold.
   */
  public orderLooksWrong(
    event: {
      _id: unknown;
      channelId?: string | null;
      groups?: Array<{ channelId?: string | null }>;
    },
    guild: Guild,
  ): boolean {
    const hold = this.holds.get(`${String(event._id)}:${ORDER_HOLD}`);
    if (hold && Date.now() < hold.until) return false;
    const wrong = this.cacheOrderWrong(event, guild);
    // Seen right: whatever was written before did take effect.
    if (!wrong) this.orderWritten.delete(String(event._id));
    return wrong;
  }

  private cacheOrderWrong(
    event: {
      channelId?: string | null;
      groups?: Array<{ channelId?: string | null }>;
    },
    guild: Guild,
  ): boolean {
    if (!event.channelId) return false;
    const main = orderChannelOf(guild.channels.cache.get(event.channelId));
    if (!main || !main.parentId || !isVoiceLike(main.type)) return false;
    const groupIds: string[] = [];
    for (const group of event.groups ?? []) {
      if (!group.channelId) continue;
      const channel = orderChannelOf(guild.channels.cache.get(group.channelId));
      if (!channel) return false;
      // One in another category is left where it is, so it is not "wrong".
      if (channel.parentId === main.parentId) groupIds.push(channel.id);
    }
    if (groupIds.length === 0) return false;
    const siblings: OrderChannel[] = [];
    for (const cached of guild.channels.cache.values()) {
      const c = orderChannelOf(cached);
      if (c && c.parentId === main.parentId && isVoiceLike(c.type)) {
        siblings.push(c);
      }
    }
    return !planGroupOrder(main.id, groupIds, siblings).inOrder;
  }

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

    // Worked out only when a channel has to be created, so a pass with nothing
    // to create makes no Discord read at all.
    let placement: Placement | null | undefined;
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

      if (placement === undefined) {
        placement = await this.resolvePlacement(row, guild, report);
      }
      if (!placement) {
        report.failures.push({
          key: group.key,
          name: group.name,
          reason: "Not created: see the warning above.",
        });
        continue;
      }

      if (wrote && this.paceMs > 0) await sleep(this.paceMs);
      wrote = true;
      const name = groupChannelName(placement.prefix, group);
      const outcome = await this.createOne(
        row,
        guild,
        placement.category,
        group,
        name,
        placement.overwrites,
        placement.noAccessReason,
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
    await this.orderLocked(eventId, guild, report, { wrote, rateLimited });
    return report;
  }

  /**
   * Put the group channels directly below the main channel (#1214). Runs at the
   * end of a pass, under the pass's lock, when it created channels or the
   * cache shows the order wrong; otherwise it makes no Discord call. It never
   * throws and never stops anything: a problem is a failure in the report and
   * a hold, and a later pass reads again before it writes.
   */
  private async orderLocked(
    eventId: string,
    guild: Guild,
    report: GroupChannelReport,
    pass: { wrote: boolean; rateLimited: boolean },
  ): Promise<void> {
    const holdKey = `${eventId}:${ORDER_HOLD}`;
    const fail = (reason: string): void => {
      report.failures.push({
        key: ORDER_HOLD,
        name: ORDER_FAILURE_NAME,
        reason,
      });
    };
    try {
      // Fresh again: the pass has created and recorded channels since it began,
      // and a cancel may have landed.
      const row = await this.readFresh(eventId);
      if (
        !row ||
        row.groupsEnabled !== true ||
        !(row.state === "scheduled" || row.state === "active") ||
        row.seriesCancelled === true ||
        !row.channelId
      ) {
        return;
      }
      const mainId = row.channelId;
      const groupIds = (row.groups ?? [])
        .map((g) => g.channelId)
        .filter((id): id is string => !!id);
      if (groupIds.length === 0) return;
      if (report.created === 0 && !this.cacheOrderWrong(row, guild)) return;

      const hold = this.holds.get(holdKey);
      if (hold && Date.now() < hold.until) {
        fail(hold.reason);
        return;
      }
      if (pass.rateLimited) {
        fail("Not attempted: Discord is rate limiting. Retried next scan.");
        return;
      }
      if (pass.wrote && this.paceMs > 0) await sleep(this.paceMs);

      let all: Map<string, unknown>;
      try {
        all = new Map(
          [...(await guild.channels.fetch()).entries()].filter(
            ([, channel]) => !!channel,
          ),
        );
      } catch (error) {
        fail(
          `The channels could not be read, so the order was not changed: ${describeWriteFailure(error)}`,
        );
        return;
      }
      const main = orderChannelOf(all.get(mainId));
      if (!main || !isVoiceLike(main.type) || !main.parentId) {
        fail(
          "The event's main voice channel could not be found in a category, so the group channels were not put in order.",
        );
        return;
      }
      const category = all.get(main.parentId) as CategoryChannel | undefined;
      if (!category || category.type !== ChannelType.GuildCategory) {
        fail(
          "The category of the event's main voice channel could not be read, so the group channels were not put in order.",
        );
        return;
      }
      // Every recorded channel must be readable, or nothing is written.
      const placed: string[] = [];
      for (const group of row.groups ?? []) {
        if (!group.channelId) continue;
        const channel = orderChannelOf(all.get(group.channelId));
        if (!channel || channel.type !== ChannelType.GuildVoice) {
          fail(
            `The channel of ${group.name} could not be read as a voice channel, so the order was not changed.`,
          );
          return;
        }
        if (channel.parentId !== main.parentId) {
          // Moving it between categories is not ordering: leave it, say so.
          this.warnOnce(
            row,
            `order-category-${group.channelId}`,
            `${group.name}: its channel is not in the main channel's category, so it was left where it is.`,
            report.warnings,
          );
          continue;
        }
        placed.push(channel.id);
      }
      const siblings: OrderChannel[] = [];
      for (const candidate of all.values()) {
        const c = orderChannelOf(candidate);
        if (c && c.parentId === main.parentId && isVoiceLike(c.type)) {
          siblings.push(c);
        }
      }
      const plan = planGroupOrder(main.id, placed, siblings);
      if (plan.inOrder) {
        this.orderWritten.delete(eventId);
        this.holds.delete(holdKey);
        return;
      }
      const wanted = JSON.stringify(plan.moves);
      if (this.orderWritten.get(eventId) === wanted) {
        // The very write that went through last time is wanted again: Discord
        // did not take it, and writing it again would only repeat the request
        // every scan. Say so and wait. (A different plan is a new situation
        // and is written.)
        this.orderWritten.delete(eventId);
        const reason =
          "The channel order was written but Discord still reports a different order. It is tried again later; move the group channels by hand if it persists.";
        this.holds.set(holdKey, {
          until: Date.now() + REFUSED_CREATE_BACKOFF_MS,
          reason,
        });
        fail(reason);
        return;
      }
      const perms = botPermissionsIn(guild, category);
      if (perms && !perms.has(PermissionFlagsBits.ManageChannels)) {
        const reason =
          "The bot lacks Manage Channels in the events category, so the group channels were not put in order. Grant it to the bot's role.";
        this.warnOnce(row, "order-manage-channels", reason, report.warnings);
        // Until someone grants it, do not read the whole server every scan.
        this.holds.set(holdKey, {
          until: Date.now() + REFUSED_CREATE_BACKOFF_MS,
          reason,
        });
        return;
      }

      try {
        await this.call(
          (signal) =>
            this.rest().patch(Routes.guildChannels(guild.id), {
              body: plan.moves,
              reason: `Event group channel order (${sanitizeForLog(eventId)})`,
              signal,
            }),
          "order event group channels",
          // A timed-out write may have landed; the next pass reads first.
          false,
        );
      } catch (error) {
        const reason = describeWriteFailure(error);
        let waitMs = UNCONFIRMED_CREATE_BACKOFF_MS;
        if (error instanceof RateLimitError) {
          waitMs = Math.max(MIN_RATE_LIMIT_BACKOFF_MS, rateLimitWaitMs(error));
        } else if (error instanceof DiscordAPIError) {
          waitMs = REFUSED_CREATE_BACKOFF_MS;
        }
        this.holds.set(holdKey, {
          until: Date.now() + waitMs,
          reason: `${reason} Tried again later.`,
        });
        fail(reason);
        logger.warn(
          `Event ${sanitizeForLog(eventId)}: group channels not put in order: ${sanitizeForLog(reason)}`,
        );
        return;
      }
      this.orderWritten.set(eventId, wanted);
      this.holds.delete(holdKey);
      logger.info(
        `Put the group channels of event ${sanitizeForLog(eventId)} in order (${plan.moves.length} position(s) written)`,
      );
    } catch (error) {
      logger.error(
        `Event ${sanitizeForLog(eventId)}: ordering the group channels failed:`,
        error,
      );
      fail("Ordering the group channels failed unexpectedly. See the log.");
    }
  }

  /**
   * Where and how to create this event's group channels: in the category the
   * main channel is in now (read from Discord, never the current default
   * category, which may have changed since), so replacements inherit the same
   * access. Null, with a warning, when that cannot be verified.
   */
  private async resolvePlacement(
    row: EventRow,
    guild: Guild,
    report: GroupChannelReport,
  ): Promise<Placement | null> {
    const fail = (kind: string, message: string): null => {
      this.warnOnce(row, kind, message, report.warnings);
      return null;
    };
    const main = await this.readChannel(guild, row.channelId as string);
    if (main.status !== "ok") {
      return fail(
        "placement-main",
        main.status === "gone"
          ? "The event's main voice channel no longer exists, so no group channels were created."
          : "The event's main voice channel could not be read, so no group channels were created. It is tried again on the next scan.",
      );
    }
    const parentId = (main.channel as { parentId?: string | null }).parentId;
    if (!parentId) {
      return fail(
        "placement-parent",
        "The event's main voice channel is not in a category, so no group channels were created.",
      );
    }
    const parent = await this.readChannel(guild, parentId);
    if (
      parent.status !== "ok" ||
      parent.channel.type !== ChannelType.GuildCategory
    ) {
      return fail(
        "placement-category",
        "The category of the event's main voice channel could not be verified, so no group channels were created. It is tried again on the next scan.",
      );
    }
    const category = parent.channel as CategoryChannel;
    const perms = botPermissionsIn(guild, category);
    if (perms && !perms.has(PermissionFlagsBits.ManageChannels)) {
      return fail(
        "manage-channels",
        "The bot lacks Manage Channels in the events category, so no group channels were created and the event runs with its main channel only. Grant it to the bot's role.",
      );
    }
    const scratch: string[] = [];
    const overwrites = this.hostOverwritesFor(row, guild, category, scratch);
    return {
      category,
      overwrites,
      noAccessReason: overwrites ? null : (scratch[0] ?? "no host access"),
      prefix: await this.deps.getPrefix(),
    };
  }

  private async createOne(
    row: EventRow,
    guild: Guild,
    category: CategoryChannel,
    group: GroupRow,
    name: string,
    overwrites: OverwriteSpec[] | null,
    noAccessReason: string | null,
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
    // Why the new channel lacks the host's access, if it does.
    let lacksAccess: string | null = noAccessReason;
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
            [],
          );
          lacksAccess = "Discord refused the host's access";
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
    if (lacksAccess) {
      // Tied to this channel, so it outlives the pass that created it and goes
      // when the channel is removed or replaced.
      const forEvent = this.channelWarnings.get(eventId) ?? new Map();
      forEvent.set(
        created.id,
        `${group.name}: created without the host's access (${lacksAccess}).`,
      );
      this.channelWarnings.set(eventId, forEvent);
    }
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

    // Stored before any channel is processed, so a failed read or delete shows
    // on the host panel instead of an old creation report.
    this.reports.set(eventId, report);
    let wrote = false;
    let rateLimited = false;
    for (const group of recorded) {
      const channelId = group.channelId as string;
      // Pace first, then read: nothing sits between the occupancy check and
      // the delete but the request itself.
      if (wrote && this.paceMs > 0) await sleep(this.paceMs);
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
      wrote = true;
      try {
        await this.call(
          (signal) => {
            // Checked again on every attempt (a timeout retry runs this
            // again): a member may have joined since the read above.
            const live = guild.channels.cache.get(channelId) as
              VoiceChannel | undefined;
            if (
              live?.type === ChannelType.GuildVoice &&
              live.members.size > 0
            ) {
              throw new ChannelOccupiedError();
            }
            return this.rest().delete(Routes.channel(channelId), {
              reason: "Event ended",
              signal,
            });
          },
          "delete event group channel",
          // Deleting twice is harmless (the second answer is 10003).
          true,
        );
      } catch (error) {
        if (error instanceof ChannelOccupiedError) {
          // Someone joined: keep the channel and its record for the next scan.
          report.occupied += 1;
          continue;
        }
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
    this.notices.delete(eventId);
    this.channelWarnings.delete(eventId);
    this.orderWritten.delete(eventId);
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
    this.channelWarnings.get(eventId)?.delete(channelId);
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
