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
import {
  LEADS_REQUIRED_BOT_PERMISSIONS,
  buildLeadsOverwrites,
  describePlan,
  leadsLeaderIds,
  planLeadsSync,
  revokedUserIds,
  type LeadsAccessContext,
  type LeadsOp,
  type OverwriteSpec,
} from "./event-leads-access.js";
import { resolveLeadsChannel } from "./event-leader-roles.js";

export type { OverwriteSpec } from "./event-leads-access.js";

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
 * - The leads channel (#1199) is created with the overwrites of
 *   `event-leads-access.ts` (the category's own, then @everyone denied Connect,
 *   the host, the leaders and the bot allowed), and `syncLeads` keeps them
 *   right under the same lock: it decides from a fresh row and a force-read
 *   channel, never from the change that triggered it, writes one overwrite per
 *   request (revokes first), paced, and writes nothing when the channel cannot
 *   be read. A channel that could not be restricted is created without the
 *   restriction and the host panel says so until it is.
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
  kind?: string;
  size?: number | null;
  marker?: string;
  channelId?: string | null;
  memberIds?: string[];
  captainId?: string | null;
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
  captainsEnabled?: boolean;
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
  category: GuildBasedChannel,
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
  /**
   * `events.enabled`, read inside the lock before the leads channel's access is
   * widened. An error counts as off (fails closed). Without it (tests) events
   * count as on.
   */
  isEnabled?: () => Promise<boolean>;
  /**
   * The ids of the roles of KoolBot's admin groups in a server (the Web UI's
   * admins). The leads channel never denies or moves their holders. May throw.
   */
  getAdminRoleIds?: (guildId: string) => Promise<string[]>;
}

/** The admin roles for the leads channel, and whether they could be established. */
export interface LeadsAdmins {
  roleIds: ReadonlySet<string>;
  known: boolean;
}

/** What one `syncLeads` pass did, for the caller that moves people out. */
export interface LeadsSyncResult {
  status: "skipped" | "ok" | "failed";
  /** People to move out of the leads channel if they are in it. */
  evict: string[];
  /** The leads channel the pass looked at, when it did. */
  leadsChannelId: string | null;
  /** Overwrite requests sent. */
  wrote: number;
}

const LEADS_HOLD = "#leads";
/** Start of the warning a leads channel created without its restriction leaves in the pass report. */
const LEADS_UNRESTRICTED_WARNING =
  "The leaders-only channel is created WITHOUT its restriction, so anyone who can see it can join:";
/** Shown (and the channel left unverified) while the admin groups cannot be read. */
const ADMIN_GROUPS_UNKNOWN =
  "The admin groups could not be read, so the leaders-only channel's roles were not checked and the admins' access was not granted. It is tried again later.";
const LEADS_EVICT_HOLD = "#leads-evict";
/** Key of the standing warning about the leads channel's access (per channel id). */
const ACCESS_WARNING_SUFFIX = "#access";

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
  /** Per event: the leads access pass that last verified the channel (cleared
   * when the channel is replaced). Until it is set, the scan runs one. */
  private readonly leadsChecked = new Set<string>();
  /** Per event: the plan last written to the leads channel. A fresh read that
   * wants exactly that plan again means Discord did not take it (see
   * `syncLeadsLocked`). Cleared as soon as the channel is seen right. */
  private readonly leadsWritten = new Map<string, string>();
  /** Per event: people still to be moved out of the leads channel. */
  private readonly leadsEvict = new Map<string, Set<string>>();
  /** Per event: people a leader change in this process made leaders, as the
   * hook reported them (checked synchronously when a move out of the leads
   * channel is about to be sent, because a reappointment can land while the
   * move waits on Discord; a later change that ends the role removes them). */
  private readonly leadersNow = new Map<string, Set<string>>();
  /** Per server: the admin group roles last read (the cache-only trigger uses it). */
  private readonly adminRolesSeen = new Map<string, Set<string>>();
  /** Per event: problems with the leads channel the host panel shows (kept apart
   * from the per-pass reports, like the notices). */
  private readonly leadsProblems = new Map<
    string,
    Map<string, GroupChannelFailure>
  >();
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
    const problems = [...(this.leadsProblems.get(eventId)?.values() ?? [])];
    if (!base && extra.length === 0 && problems.length === 0) return null;
    const report = base ?? emptyReport();
    return {
      ...report,
      failures: [...report.failures, ...problems],
      warnings: [...new Set([...extra, ...report.warnings])],
    };
  }

  /** Set (or with null, clear) a standing problem with the leads channel. */
  public setLeadsProblem(
    eventId: string,
    key: string,
    problem: { name: string; reason: string } | null,
  ): void {
    const forEvent = this.leadsProblems.get(eventId) ?? new Map();
    if (problem) forEvent.set(key, { key, ...problem });
    else forEvent.delete(key);
    if (forEvent.size === 0) this.leadsProblems.delete(eventId);
    else this.leadsProblems.set(eventId, forEvent);
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
      // The leads channel is created restricted (#1199), from the leaders of
      // THIS pass's fresh row; a leader set after that read is applied by the
      // sync that the change queues behind this pass.
      const leads =
        group.kind === "leads"
          ? await this.leadsOverwritesFor(
              row,
              guild,
              placement.category,
              report,
            )
          : null;
      const outcome = await this.createOne(
        row,
        guild,
        placement.category,
        group,
        name,
        leads ? leads.overwrites : placement.overwrites,
        leads ? leads.reason : placement.noAccessReason,
        report,
        leads !== null,
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
    isLeads = false,
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
            isLeads ? "leads-overwrite-refused" : "overwrite-refused",
            isLeads
              ? "Discord refused the leaders-only channel's permissions, so it was created WITHOUT the restriction."
              : "Discord refused the host's channel access, so the group channels were created without it.",
            [],
          );
          lacksAccess = isLeads
            ? "Discord refused the channel's permissions"
            : "Discord refused the host's access";
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
    if (isLeads) {
      // A new channel (a replacement included) has not been verified yet, and
      // an older write belongs to the channel that is gone.
      this.leadsChecked.delete(eventId);
      this.leadsWritten.delete(eventId);
      this.leadsEvict.delete(eventId);
      this.holds.delete(`${eventId}:${LEADS_HOLD}`);
    }
    if (lacksAccess) {
      // Tied to this channel, so it outlives the pass that created it and goes
      // when the channel is removed or replaced.
      const forEvent = this.channelWarnings.get(eventId) ?? new Map();
      forEvent.set(
        isLeads ? `${created.id}${ACCESS_WARNING_SUFFIX}` : created.id,
        isLeads
          ? `${group.name}: created WITHOUT the leaders-only restriction, so anyone who can see it can join (${lacksAccess}). It is restricted as soon as the bot has the permissions.`
          : `${group.name}: created without the host's access (${lacksAccess}).`,
      );
      this.channelWarnings.set(eventId, forEvent);
    }
    logger.info(
      `Created group channel ${sanitizeForLog(name)} for event ${sanitizeForLog(eventId)}`,
    );
    return { kind: "ok" };
  }

  // -------------------------------------------------------------
  // The leads channel (#1199)
  // -------------------------------------------------------------

  /**
   * The roles that count as admins for the leads channel: KoolBot's admin
   * groups (the Web UI's admins, who may act as host), read from the database,
   * and, where the caller knows the guild, the roles holding Administrator.
   * When the groups cannot be read the last answer is used; if there never was
   * one, `known` is false and nothing is denied or moved on a guess.
   */
  public async leadsAdminRoles(guildId: string): Promise<LeadsAdmins> {
    if (!this.deps.getAdminRoleIds) return { roleIds: new Set(), known: true };
    try {
      const ids = new Set(await this.deps.getAdminRoleIds(guildId));
      this.adminRolesSeen.set(guildId, ids);
      return { roleIds: ids, known: true };
    } catch (error) {
      logger.warn(
        `Could not read the admin groups of server ${sanitizeForLog(guildId)} for the leaders-only channel:`,
        error,
      );
      const seen = this.adminRolesSeen.get(guildId);
      return { roleIds: seen ?? new Set(), known: !!seen };
    }
  }

  private leadsContext(
    row: EventRow,
    guild: Guild,
    admins: LeadsAdmins = {
      roleIds: this.adminRolesSeen.get(guild.id) ?? new Set(),
      known: true,
    },
  ): LeadsAccessContext {
    const hostId = SNOWFLAKE.test(row.createdBy ?? "")
      ? (row.createdBy as string)
      : null;
    const me = this.client.user?.id;
    const adminRoleIds = new Set<string>(admins.roleIds);
    for (const role of guild.roles?.cache?.values() ?? []) {
      if (role.permissions?.has(PermissionFlagsBits.Administrator)) {
        adminRoleIds.add(role.id);
      }
    }
    return {
      everyoneId: guild.id,
      hostId,
      botId: me && SNOWFLAKE.test(me) ? me : null,
      leaderIds: leadsLeaderIds(row).filter((id) => SNOWFLAKE.test(id)),
      adminRoleIds,
      allRolesExempt: !admins.known,
      // Admin groups get an explicit allow, never on a guess.
      adminGrantRoleIds: admins.known ? new Set(admins.roleIds) : new Set(),
    };
  }

  /**
   * The overwrites for a new leads channel, or null with the reason when the
   * restriction cannot be sent (the channel is then created without it, as the
   * issue asks, and the host panel says so). The bot must itself hold every
   * permission it grants, or Discord refuses (50013) the whole create.
   */
  private async leadsOverwritesFor(
    row: EventRow,
    guild: Guild,
    category: CategoryChannel,
    report: GroupChannelReport,
  ): Promise<{ overwrites: OverwriteSpec[] | null; reason: string | null }> {
    const ctx = this.leadsContext(
      row,
      guild,
      await this.leadsAdminRoles(guild.id),
    );
    const unrestricted = (
      reason: string,
    ): { overwrites: null; reason: string } => {
      this.warnOnce(
        row,
        "leads-unrestricted",
        `${LEADS_UNRESTRICTED_WARNING} ${reason}.`,
        report.warnings,
      );
      return { overwrites: null, reason };
    };
    if (!ctx.hostId)
      return unrestricted("the event's host is not a Discord user");
    if (!ctx.botId) return unrestricted("the bot's own id is not known");
    const perms = botPermissionsIn(guild, category);
    if (perms) {
      const missing = missingLeadsPermissions(perms);
      if (missing.length > 0) {
        return unrestricted(
          `the bot lacks ${missing.join(", ")} in the events category`,
        );
      }
    }
    return {
      overwrites: buildLeadsOverwrites(overwriteSpecsOf(category), ctx),
      reason: null,
    };
  }

  /**
   * Does the gateway cache say the leads channel needs a pass (the scan's
   * trigger)? True when the channel has never been verified since it was
   * created or since a restart, when its cached overwrites differ from what
   * the rules want, when someone who cannot connect sits in it, or when a
   * person still has to be moved out. Cache only, never the basis of a write:
   * the pass reads Discord fresh. False while a hold from a failure is active,
   * and when the channel is not in the cache (the group pass handles that).
   */
  public leadsNeedsAttention(
    event: {
      _id: unknown;
      createdBy?: string;
      captainsEnabled?: boolean;
      groups?: GroupRow[];
    },
    guild: Guild,
  ): boolean {
    const id = String(event._id);
    const leadsId = resolveLeadsChannel(event);
    if (!leadsId) return false;
    const now = Date.now();
    // A failed pass holds everything (the failure will repeat until fixed).
    const hold = this.holds.get(`${id}:${LEADS_HOLD}`);
    if (hold && now < hold.until) return false;
    const evictHold = this.holds.get(`${id}:${LEADS_EVICT_HOLD}`);
    const evictHeld = !!evictHold && now < evictHold.until;
    if ((this.leadsEvict.get(id)?.size ?? 0) > 0 && !evictHeld) return true;
    if (!this.leadsChecked.has(id)) return true;
    const channel = guild.channels.cache.get(leadsId) as
      VoiceChannel | undefined;
    if (!channel) return false;
    const ctx = this.leadsContext(event as EventRow, guild);
    if (planLeadsSync(overwriteSpecsOf(channel), ctx).length > 0) return true;
    // Seen right: whatever was written before did take effect, so the same
    // write may legitimately be wanted again later (see `syncLeadsLocked`).
    this.leadsWritten.delete(id);
    if (evictHeld) return false;
    const probe = this.leadsProbe(guild, leadsId);
    const keep = new Set<string>(ctx.leaderIds);
    if (ctx.hostId) keep.add(ctx.hostId);
    for (const member of channel.members?.values() ?? []) {
      if (member.user?.bot || keep.has(member.id)) continue;
      if (!probe.isAdmin(member.id) && probe.canConnect(member.id) === false) {
        return true;
      }
    }
    return false;
  }

  /**
   * What the gateway cache says about people in the leads channel: whether the
   * member holds Administrator (or owns the server), and whether they may
   * connect. Both answer "do not touch" when the cache cannot tell.
   */
  public leadsProbe(
    guild: Guild,
    channelId: string,
    admins: LeadsAdmins = {
      roleIds: this.adminRolesSeen.get(guild.id) ?? new Set(),
      known: true,
    },
  ): {
    isAdmin: (userId: string) => boolean;
    canConnect: (userId: string) => boolean | null;
  } {
    const channel = guild.channels.cache.get(channelId) as
      VoiceChannel | undefined;
    return {
      // An admin is the server's owner, a holder of Administrator, or a holder
      // of the role of a KoolBot admin group. Anyone the cache cannot place,
      // and everyone while the admin groups are unknown, counts as one.
      isAdmin: (userId: string): boolean => {
        if (userId === guild.ownerId || !admins.known) return true;
        const member = guild.members?.cache?.get(userId);
        if (!member) return true;
        if (member.permissions?.has(PermissionFlagsBits.Administrator)) {
          return true;
        }
        for (const roleId of member.roles?.cache?.keys() ?? []) {
          if (admins.roleIds.has(roleId)) return true;
        }
        return false;
      },
      canConnect: (userId: string): boolean | null => {
        const member = guild.members?.cache?.get(userId);
        if (!channel || !member) return null;
        try {
          return (
            channel.permissionsFor(member)?.has(PermissionFlagsBits.Connect) ??
            null
          );
        } catch {
          return null;
        }
      },
    };
  }

  /**
   * Note a leader change as the hook reports it, synchronously: who just
   * became a leader must not be moved out by a plan made before that.
   */
  public trackLeaderChange(
    eventId: string,
    change: { fromUserId: string | null; toUserId: string | null },
  ): void {
    const set = this.leadersNow.get(eventId) ?? new Set<string>();
    if (change.fromUserId) set.delete(change.fromUserId);
    if (change.toUserId) set.add(change.toUserId);
    if (set.size > 0) this.leadersNow.set(eventId, set);
    else this.leadersNow.delete(eventId);
  }

  /** Was this person made a leader since this process started (and not removed since)? */
  public isTrackedLeader(eventId: string, userId: string): boolean {
    return this.leadersNow.get(eventId)?.has(userId) === true;
  }

  /** Remember people who still have to be moved out of the leads channel. */
  public queueEviction(eventId: string, userIds: Iterable<string>): void {
    const set = this.leadsEvict.get(eventId) ?? new Set<string>();
    for (const id of userIds) set.add(id);
    if (set.size > 0) this.leadsEvict.set(eventId, set);
  }

  /** Do not try to move people out of the leads channel again for `ms`. */
  public holdEviction(eventId: string, ms: number): void {
    this.holds.set(`${eventId}:${LEADS_EVICT_HOLD}`, {
      until: Date.now() + ms,
      reason: "Moving people out of the leaders-only channel is held back.",
    });
  }

  /**
   * Make the leads channel's access match the event right now: one pass under
   * the per-event lock that reads the event and the channel fresh, plans from
   * those and from nothing else, and sends the difference, one overwrite per
   * request, revokes first, paced.
   *
   * Not driven by the change that triggered it: whoever the row names as host
   * and leaders when the pass reads is who gets access, so a pass that runs
   * after a replacement leader was queued, or after the channel was made again,
   * is simply right. `takeRevoked` runs first thing inside the lock: people the
   * caller knows lost access (the hook's stored "from" ids) are moved out even
   * when the overwrite is already gone.
   *
   * Fails closed: nothing is written when the event, the channel or the bot's
   * permission to change overwrites cannot be established, and the reason is
   * shown on the host panel. While `events.enabled` is off only access is taken
   * away, never given. Never throws.
   */
  public syncLeads(
    eventId: string,
    guild: Guild,
    opts: { takeRevoked?: () => readonly string[] } = {},
  ): Promise<LeadsSyncResult> {
    return this.lock.run(eventId, () =>
      this.syncLeadsLocked(eventId, guild, opts),
    );
  }

  private async syncLeadsLocked(
    eventId: string,
    guild: Guild,
    opts: { takeRevoked?: () => readonly string[] },
  ): Promise<LeadsSyncResult> {
    // Everything queued before this point is covered by this pass; whatever
    // arrives later queues its own.
    const revoked = new Set<string>([
      ...(opts.takeRevoked?.() ?? []),
      ...(this.leadsEvict.get(eventId) ?? []),
    ]);
    this.leadsEvict.delete(eventId);
    const result = (
      status: LeadsSyncResult["status"],
      leadsChannelId: string | null,
      evict: string[],
      wrote: number,
    ): LeadsSyncResult => ({ status, evict, leadsChannelId, wrote });
    // A pass that could not finish keeps the people for the next one.
    const failed = (
      leadsChannelId: string | null,
      wrote = 0,
    ): LeadsSyncResult => {
      this.queueEviction(eventId, revoked);
      // A write may have landed although its answer did not (or only part of
      // the plan did): the channel is no longer known to be right, so the scan
      // checks it again once the hold has run out and clears what was reported.
      this.leadsChecked.delete(eventId);
      return result("failed", leadsChannelId, [], wrote);
    };
    const holdKey = `${eventId}:${LEADS_HOLD}`;
    const problem = (reason: string): void =>
      this.setLeadsProblem(eventId, LEADS_HOLD, {
        name: LEADS_PROBLEM_NAME,
        reason,
      });

    try {
      const row = await this.readFresh(eventId);
      if (
        !row ||
        row.guildId !== guild.id ||
        row.groupsEnabled !== true ||
        !(row.state === "scheduled" || row.state === "active") ||
        row.seriesCancelled === true
      ) {
        return result("skipped", null, [], 0);
      }
      const leadsId = resolveLeadsChannel(row);
      if (!leadsId) return result("skipped", null, [], 0);

      let enabled = true;
      if (this.deps.isEnabled) {
        try {
          enabled = await this.deps.isEnabled();
        } catch {
          enabled = false;
        }
      }

      const state = await this.readChannel(guild, leadsId);
      if (state.status === "gone") {
        // The next group pass makes a new, restricted one.
        return result("skipped", leadsId, [], 0);
      }
      // A standing problem is not tried again on every scan.
      const holdFor = (reason: string): void => {
        this.holds.set(holdKey, {
          until: Date.now() + REFUSED_CREATE_BACKOFF_MS,
          reason,
        });
      };
      if (state.status === "error") {
        const reason = `The leaders-only channel could not be read, so its access was not changed: ${describeWriteFailure(state.error)}`;
        problem(reason);
        holdFor(reason);
        return failed(leadsId);
      }
      const channel = state.channel;
      if (
        channel.type !== ChannelType.GuildVoice ||
        channel.guildId !== guild.id
      ) {
        const reason =
          "The recorded leaders-only channel is not a voice channel of this server, so its access was not changed.";
        problem(reason);
        holdFor(reason);
        return failed(leadsId);
      }
      const perms = botPermissionsIn(guild, channel);
      if (perms && !perms.has(PermissionFlagsBits.ManageRoles)) {
        const reason =
          "The bot lacks Manage Roles on the leaders-only channel, so it cannot change who may join it. Grant it to the bot's role.";
        this.warnOnce(row, "leads-manage-roles", reason, []);
        problem(reason);
        this.holds.set(holdKey, {
          until: Date.now() + REFUSED_CREATE_BACKOFF_MS,
          reason,
        });
        return failed(leadsId);
      }

      const ctx = this.leadsContext(
        row,
        guild,
        await this.leadsAdminRoles(guild.id),
      );
      let ops = planLeadsSync(overwriteSpecsOf(channel), ctx);
      // With events off nothing is given, only taken away from members.
      if (!enabled) ops = ops.filter(isMemberRevoke);
      const planKey = describePlan(ops);

      if (ops.length === 0) {
        this.leadsWritten.delete(eventId);
        this.holds.delete(holdKey);
        if (enabled && ctx.allRolesExempt) {
          // The roles could not be cleaned up or granted without knowing the
          // admin groups: not verified, and tried again when they can be read.
          holdFor(ADMIN_GROUPS_UNKNOWN);
          problem(ADMIN_GROUPS_UNKNOWN);
        } else if (enabled) {
          // Seen right, from Discord itself.
          this.leadsChecked.add(eventId);
          this.setLeadsProblem(eventId, LEADS_HOLD, null);
          this.channelWarnings
            .get(eventId)
            ?.delete(`${leadsId}${ACCESS_WARNING_SUFFIX}`);
          // The "created without its restriction" warning of the pass that
          // created the channel is stored in that pass's report: drop it too.
          const stored = this.reports.get(eventId);
          if (stored) {
            stored.warnings = stored.warnings.filter(
              (w) => !w.startsWith(LEADS_UNRESTRICTED_WARNING),
            );
          }
        }
        return result("ok", leadsId, [...revoked], 0);
      }
      if (this.leadsWritten.get(eventId) === planKey) {
        // The very write that went through last time is wanted again: Discord
        // did not take it, and writing it again would only repeat the request
        // every scan. Say so and wait; a different plan is a new situation.
        this.leadsWritten.delete(eventId);
        const reason =
          "The leaders-only channel's access was written but Discord still reports different permissions. It is tried again later; check the channel's permissions by hand if it persists.";
        this.holds.set(holdKey, {
          until: Date.now() + REFUSED_CREATE_BACKOFF_MS,
          reason,
        });
        problem(reason);
        return failed(leadsId);
      }

      let wrote = 0;
      for (const op of ops) {
        if (wrote > 0 && this.paceMs > 0) await sleep(this.paceMs);
        wrote += 1;
        try {
          await this.writeLeadsOp(leadsId, op);
        } catch (error) {
          if (
            error instanceof DiscordAPIError &&
            error.code === DISCORD_UNKNOWN_CHANNEL
          ) {
            // Deleted while this ran: nothing is left to restrict, and the
            // group pass makes a restricted replacement.
            return result("skipped", leadsId, [], wrote);
          }
          const reason = describeWriteFailure(error);
          let waitMs = UNCONFIRMED_CREATE_BACKOFF_MS;
          if (error instanceof RateLimitError) {
            waitMs = Math.max(
              MIN_RATE_LIMIT_BACKOFF_MS,
              rateLimitWaitMs(error),
            );
          } else if (error instanceof DiscordAPIError) {
            waitMs = REFUSED_CREATE_BACKOFF_MS;
          }
          this.holds.set(holdKey, {
            until: Date.now() + waitMs,
            reason: `${reason} Tried again later.`,
          });
          problem(
            `The leaders-only channel's access was only partly changed: ${reason}`,
          );
          logger.warn(
            `Event ${sanitizeForLog(eventId)}: leaders-only channel access not fully applied: ${sanitizeForLog(reason)}`,
          );
          return failed(leadsId, wrote);
        }
      }
      this.leadsWritten.set(eventId, planKey);
      this.holds.delete(holdKey);
      this.setLeadsProblem(eventId, LEADS_HOLD, null);
      if (ctx.allRolesExempt) {
        holdFor(ADMIN_GROUPS_UNKNOWN);
        problem(ADMIN_GROUPS_UNKNOWN);
      }
      logger.info(
        `Updated the leaders-only channel access of event ${sanitizeForLog(eventId)} (${ops.length} overwrite(s) written)`,
      );
      for (const id of revokedUserIds(ops)) revoked.add(id);
      return result("ok", leadsId, [...revoked], wrote);
    } catch (error) {
      logger.error(
        `Event ${sanitizeForLog(eventId)}: updating the leaders-only channel access failed:`,
        error,
      );
      const reason =
        "Updating the leaders-only channel's access failed unexpectedly. See the log.";
      problem(reason);
      this.holds.set(holdKey, {
        until: Date.now() + REFUSED_CREATE_BACKOFF_MS,
        reason,
      });
      return failed(null);
    }
  }

  private writeLeadsOp(channelId: string, op: LeadsOp): Promise<unknown> {
    const route =
      op.kind === "put"
        ? Routes.channelPermission(channelId, op.spec.id)
        : Routes.channelPermission(channelId, op.id);
    return this.call(
      (signal) =>
        op.kind === "put"
          ? this.rest().put(route, {
              body: {
                allow: op.spec.allow.toString(),
                deny: op.spec.deny.toString(),
                type: op.spec.type,
              },
              reason: "Event leaders-only channel access",
              signal,
            })
          : this.rest().delete(route, {
              reason: "Event leaders-only channel access",
              signal,
            }),
      "set leaders-only channel access",
      // Setting or removing one overwrite twice leaves the same result, and
      // nothing else writes this channel's overwrites while the lock is held.
      true,
    );
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
    this.leadsChecked.delete(eventId);
    this.leadsWritten.delete(eventId);
    this.leadsEvict.delete(eventId);
    this.leadsProblems.delete(eventId);
    this.leadersNow.delete(eventId);
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
    this.channelWarnings
      .get(eventId)
      ?.delete(`${channelId}${ACCESS_WARNING_SUFFIX}`);
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

/** The name the host panel shows for a leads channel access problem. */
const LEADS_PROBLEM_NAME = "Leaders-only channel access";

const LEADS_PERMISSION_NAMES: Array<[string, bigint]> = [
  ["View Channel", PermissionFlagsBits.ViewChannel],
  ["Connect", PermissionFlagsBits.Connect],
  ["Speak", PermissionFlagsBits.Speak],
  ["Move Members", PermissionFlagsBits.MoveMembers],
  ["Manage Roles", PermissionFlagsBits.ManageRoles],
];

/** The permissions the bot needs in the category to grant the leads access, that it lacks. */
function missingLeadsPermissions(
  perms: Readonly<PermissionsBitField>,
): string[] {
  const names: string[] = [];
  for (const [name, bit] of LEADS_PERMISSION_NAMES) {
    if ((LEADS_REQUIRED_BOT_PERMISSIONS & bit) !== 0n && !perms.has(bit)) {
      names.push(name);
    }
  }
  return names;
}

/** A channel's overwrites as plain values (its cache, which a fresh fetch refreshes). */
function overwriteSpecsOf(channel: {
  permissionOverwrites?: {
    cache: Map<string, unknown> | { values(): Iterable<unknown> };
  };
}): OverwriteSpec[] {
  const specs: OverwriteSpec[] = [];
  const cache = channel.permissionOverwrites?.cache;
  if (!cache) return specs;
  for (const raw of cache.values()) {
    const o = raw as {
      id: string;
      type: OverwriteType;
      allow: { bitfield: bigint };
      deny: { bitfield: bigint };
    };
    specs.push({
      id: o.id,
      type: o.type,
      allow: o.allow.bitfield,
      deny: o.deny.bitfield,
    });
  }
  return specs;
}

/** An op that takes access away from a member (the only kind written with events off). */
function isMemberRevoke(op: LeadsOp): boolean {
  if (!op.revoke) return false;
  const type = op.kind === "put" ? op.spec.type : op.type;
  return type === OverwriteType.Member;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const handle = setTimeout(resolve, ms);
    handle.unref?.();
  });
}
