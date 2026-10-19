/**
 * Moving members between an event's voice channels (#1192): the one helper
 * behind the host panel's "send to groups", "return to main" and "move one
 * person", reusable by "end event now" (#1193), "pull leaders only" (#1195),
 * the leads channel (#1199) and live edits (#1197).
 *
 * ## What `moveEventMembers` promises
 *
 * - **One bulk move per event at a time** (`withEventMoveLock`): a second call
 *   answers `busy` at once. Live edits take the same lock.
 * - **Decides from fresh data, inside the lock.** The event is read again
 *   (`findById().lean()`), `events.enabled` is read, and the caller's planner
 *   runs on that fresh row. Nothing is decided from a copy loaded earlier.
 * - **Fails closed.** An unreadable event, switch, guild or bot membership
 *   refuses the whole run. Per person, the voice state is read from Discord
 *   (`GET /guilds/{guild}/voice-states/{user}`, the raw payload, see below)
 *   and an unreadable one skips that person. Every destination channel is force-fetched and must be a
 *   voice channel of this server that belongs to the event.
 * - **Only out of the event's own channels, only into them.** A person whose
 *   voice channel is not one of the event's (or who is not connected) is
 *   skipped and listed. The check is repeated against the live gateway state
 *   in the same tick as the write.
 * - **The host is never force-moved by a bulk action**: callers pass
 *   `excludeUserIds` (the event creator and the acting user).
 * - **Every Discord call goes through `CommandManager.makeDiscordApiCall`**
 *   on the no-retry write client, one person at a time, `MOVE_PACE_MS` apart.
 *   A move is never replayed after a timeout, and a timed-out move is
 *   reported as "may have moved", never as failed. A rate limit stops the run
 *   and lists the rest as not attempted.
 * - **A move never changes group membership.** Each move is marked
 *   (`markHostMove`) before it is sent, so `handleGroupSelfJoin` ignores the
 *   resulting voice join. Changing a person's group is the Assign section's
 *   job. So a move needs no member-reset admission ticket and writes nothing
 *   to the database.
 *
 * The planner returns `{ userId, toChannelId }` wishes; `toChannelId` must be
 * one of the event's channels. Never call this function (or
 * `withEventMoveLock`) from inside its own planner, and never from inside a
 * `withGroupLock` section: the planner must not wait for either.
 */

import {
  ChannelType,
  DefaultRestOptions,
  DiscordAPIError,
  HTTPError,
  PermissionFlagsBits,
  RateLimitError,
  Routes,
  Events,
  type Client,
  type Guild,
  type VoiceState,
  type REST,
  type RESTOptions,
  type VoiceChannel,
} from "discord.js";
import { Event, type IEvent } from "../models/event.js";
import { leadsLeaderIds } from "./event-leads-access.js";

// A lean row has the fields the presence helpers read, without Mongoose typing.
type PresenceRow = Pick<IEvent, "guildId" | "channelId" | "groups">;
type ChannelRow = Pick<IEvent, "channelId" | "groups">;
import {
  cancellableCall,
  createWriteRest,
  describeWriteFailure,
} from "../web/channel-write-rest.js";
import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";
import { env } from "../config/env.js";
import { shouldIgnoreGuild } from "../utils/guild-scope.js";
import { FLASH_MAX } from "../web/http-flash.js";
import { ConfigService } from "./config-service.js";
import {
  eventVoiceChannelIds,
  readEventPresence,
  type EventPresence,
} from "./event-group-presence.js";
import {
  markHostMove,
  unmarkHostMove,
  withEventMoveLock,
} from "./event-move-guard.js";

/** Pause between two people, so a big batch stays under Discord's limits. */
export const MOVE_PACE_MS = 500;
/**
 * The most people one run reads from Discord and moves. A run holds the web
 * request open until it ends, so it is bounded; the rest are listed as not
 * attempted and the host runs the action again. People the gateway already
 * shows in place, not connected or elsewhere cost no request and are not
 * counted, so a second run gets past the people the first run moved.
 */
export const MAX_MOVES_PER_RUN = 60;

const DISCORD_UNKNOWN_VOICE_STATE = 10065;
const DISCORD_NOT_IN_VOICE = 40032;
const DISCORD_MISSING_PERMISSIONS = 50013;
const OPEN_STATES = ["scheduled", "active"];

/** Why a person was not moved. */
export type MoveSkipReason =
  | "not-connected"
  | "elsewhere"
  | "moved-on"
  | "withdrawn"
  | "already-there"
  | "group-full"
  | "missing-permission"
  | "host"
  | "error"
  | "over-limit"
  | "rate-limited";

export const MOVE_SKIP_LABEL: Record<MoveSkipReason, string> = {
  "not-connected": "not connected to voice",
  elsewhere: "in a channel that is not part of the event",
  "moved-on": "no longer in the channel they were to be moved out of",
  withdrawn: "no longer to be moved",
  "already-there": "already in the right channel",
  "group-full": "group full",
  "missing-permission": "missing permission",
  host: "the host (never moved by a group action)",
  error: "error",
  "over-limit": `not attempted (over the limit of ${MAX_MOVES_PER_RUN} per run)`,
  "rate-limited": "not attempted (Discord is rate limiting)",
};

export interface MoveWish {
  userId: string;
  /** One of the event's channels (main or a group's). */
  toChannelId: string;
  /**
   * Only move the person if they are in THIS channel (checked from the cache
   * before any request, from Discord's own answer, and again in the same tick
   * as the request). Used by the leads channel (#1199) to move someone out of
   * it without touching a person who has walked somewhere else meanwhile.
   */
  fromChannelId?: string;
  /**
   * Asked synchronously just before the request is sent (and again when the
   * request leaves the write client's queue): true withdraws the wish. For a
   * decision the plan made that something has since overtaken, such as a
   * person who was reappointed leader while the run waited on Discord.
   */
  skipIf?: () => boolean;
}

export interface MoveSkip {
  userId: string;
  reason: MoveSkipReason;
  /** Extra text for an `error` (already safe to show). */
  detail?: string;
}

export interface MoveReport {
  /** Confirmed by Discord. */
  moved: string[];
  skipped: MoveSkip[];
  /** Discord did not answer in time; the person may or may not have moved. */
  unconfirmed: string[];
}

/** The fresh event row a planner and the mover work from. */
export interface MoveEventRow {
  _id: unknown;
  guildId: string;
  state: string;
  groupsEnabled?: boolean;
  channelId?: string | null;
  createdBy?: string;
  /** Read by the leader planner (#1195). */
  captainsEnabled?: boolean;
  leaderLabel?: string;
  groups?: Array<{
    key: string;
    name: string;
    kind?: string;
    size?: number | null;
    channelId?: string | null;
    memberIds?: string[];
    captainId?: string | null;
  }>;
}

export interface MovePlanContext {
  event: MoveEventRow;
  guild: Guild;
  /** Who is connected to the event's channels, from the gateway cache. */
  presence: EventPresence;
}

/** A planner answers with the moves, or a reason to refuse the whole run. */
export type MovePlan = MoveWish[] | { refuse: string };

export type MoveRefusalCode =
  | "events-off"
  | "no-event"
  | "not-open"
  | "no-groups"
  | "no-guild"
  | "no-permission"
  | "unreadable"
  | "plan";

export type MoveOutcome =
  | { status: "busy" }
  | { status: "refused"; code: MoveRefusalCode; message: string }
  | { status: "done"; report: MoveReport; considered: number };

type ApiCaller = <T>(
  fn: (signal: AbortSignal) => Promise<T>,
  name: string,
  retryOnTimeout: boolean,
) => Promise<T>;

/** Tests: stand in for the write client, `makeDiscordApiCall` and the pause. */
export interface MoverDeps {
  rest?: REST;
  call?: ApiCaller;
  paceMs?: number;
  /** Tests: the network under the guarded write client (default: discord.js's). */
  makeRequest?: RESTOptions["makeRequest"];
}

let defaultDepsForTests: MoverDeps | undefined;
/** Tests of callers (the host routes): stand in for Discord for every run. */
export function setMoverDepsForTests(deps: MoverDeps | undefined): void {
  defaultDepsForTests = deps;
}

/** Thrown when the member is already in the destination by the time of the write. */
class AlreadyThereError extends Error {
  constructor() {
    super("The member is already in the destination channel");
    this.name = "AlreadyThereError";
  }
}

/**
 * A rate limit, however it reached us: the write client's own rejection, or
 * wrapped by `makeDiscordApiCall` (`cause`), or a plain HTTP 429. A 429 means
 * the request did not run.
 */
function isRateLimited(error: unknown, depth = 0): boolean {
  if (depth > 3 || !error) return false;
  if (error instanceof RateLimitError) return true;
  if (
    (error instanceof DiscordAPIError || error instanceof HTTPError) &&
    error.status === 429
  ) {
    return true;
  }
  return isRateLimited((error as { cause?: unknown }).cause, depth + 1);
}

/** Thrown inside a move attempt when the destination filled up meanwhile. */
class DestinationFullError extends Error {
  constructor() {
    super("The destination channel is full");
    this.name = "DestinationFullError";
  }
}

/** Thrown inside a move attempt when the live voice state no longer allows it. */
class MovedAwayError extends Error {
  constructor(readonly connected: boolean) {
    super("The member is no longer in an event channel");
    this.name = "MovedAwayError";
  }
}

/** Thrown when the member is not in the channel a wish said to move them out of. */
class MovedOnError extends Error {
  constructor() {
    super(
      "The member is no longer in the channel they were to be moved out of",
    );
    this.name = "MovedOnError";
  }
}

/** Thrown when the wish was withdrawn between the plan and the request. */
class WithdrawnError extends Error {
  constructor() {
    super("The move was withdrawn");
    this.name = "WithdrawnError";
  }
}

const REFUSAL_TEXT: Record<MoveRefusalCode, string> = {
  "events-off":
    "Events are turned off, so nobody was moved. Turn on events.enabled first.",
  "no-event": "The event could not be read, so nobody was moved.",
  "not-open": "The event is no longer running, so nobody was moved.",
  "no-groups": "This event has no groups, so nobody was moved.",
  "no-guild":
    "The bot could not read this server's voice state, so nobody was moved.",
  "no-permission":
    "The bot lacks the Move Members permission, so nobody was moved. Grant it to the bot's role.",
  unreadable:
    "The bot could not check the voice channels, so nobody was moved.",
  plan: "Nobody was moved.",
};

/**
 * Why the bot cannot move members in this server, or null when it can. Used by
 * the host panel (to disable the buttons and say why) and by the run itself.
 * An unknown bot membership counts as "cannot".
 */
export function moveMembersBlocker(
  guild: Guild | undefined,
  channelScoped = false,
): string | null {
  if (!guild) return REFUSAL_TEXT["no-guild"];
  const me = guild.members?.me;
  if (!me) {
    return "The bot could not check its own permissions, so moving people is switched off.";
  }
  // Move Members granted on a category only is enough for the moves the
  // per-channel checks allow: the caller then leaves the decision to them.
  if (channelScoped) return null;
  try {
    return me.permissions.has(PermissionFlagsBits.MoveMembers)
      ? null
      : REFUSAL_TEXT["no-permission"];
  } catch {
    return "The bot could not check its own permissions, so moving people is switched off.";
  }
}

async function eventsEnabled(): Promise<boolean> {
  try {
    return await ConfigService.getInstance().getBoolean(
      "events.enabled",
      false,
    );
  } catch (error) {
    logger.warn("Could not read events.enabled for a host move:", error);
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const handle = setTimeout(resolve, ms);
    handle.unref?.();
  });
}

/**
 * Move people between an event's voice channels. See the module comment for
 * the rules; the caller supplies only what to move (`plan`, run on the fresh
 * row inside the lock) and who to leave alone (`excludeUserIds`).
 */
export function moveEventMembers(
  opts: MoveEventMembersOptions,
): Promise<MoveOutcome> {
  // Everything taken from the caller happens here, synchronously.
  const { eventId } = opts;
  const run = lockedRunOf(opts);
  return withEventMoveLock(eventId, run).then((result) =>
    result.busy ? { status: "busy" } : result.value,
  );
}

/**
 * The same run for a caller that ALREADY HOLDS `withEventMoveLock(eventId)`:
 * the host panel's live edit (#1242) takes that lock for a whole save and must
 * empty a group's channel inside it, where `moveEventMembers` would answer
 * `busy` to the very lock its caller holds. It never takes the lock itself, so
 * calling it without holding the lock lets a bulk move and this run interleave:
 * only the live-edit effects (`event-live-edit-effects.ts`) call it.
 */
export function moveEventMembersHoldingLock(
  opts: MoveEventMembersOptions,
): Promise<MoveOutcome> {
  return lockedRunOf(opts)();
}

export interface MoveEventMembersOptions {
  client: Client;
  guildId: string;
  eventId: string;
  plan: (ctx: MovePlanContext) => MovePlan;
  /** People never moved by this run (the host, the acting user). */
  excludeUserIds?: readonly string[];
  /**
   * Also run for an `ended` or `cancelled` event. Off by default: the host
   * actions only act on a running event. "End event now" (#1193) saves the
   * end state first and then has to empty the group channels, so it opts in.
   */
  allowFinished?: boolean;
  /**
   * Do not refuse the run for lacking Move Members server-wide: the per-move
   * checks (Move Members on the source channel, Connect on the destination)
   * decide. For callers whose permission is granted in the events category.
   */
  channelScopedPermissions?: boolean;
  deps?: MoverDeps;
}

/** The run of one call, with everything it needs taken from the caller now. */
function lockedRunOf(
  opts: MoveEventMembersOptions,
): () => Promise<MoveOutcome> {
  const { client, guildId, eventId, plan } = opts;
  const deps = opts.deps ?? defaultDepsForTests;
  const exclude = new Set(opts.excludeUserIds ?? []);
  const allowFinished = opts.allowFinished === true;
  const channelScoped = opts.channelScopedPermissions === true;
  return () =>
    runLocked({
      client,
      guildId,
      eventId,
      plan,
      exclude,
      allowFinished,
      channelScoped,
      deps,
    });
}

async function runLocked(opts: {
  client: Client;
  guildId: string;
  eventId: string;
  plan: (ctx: MovePlanContext) => MovePlan;
  exclude: Set<string>;
  allowFinished: boolean;
  channelScoped: boolean;
  deps?: MoverDeps;
}): Promise<MoveOutcome> {
  const { client, guildId, eventId, exclude } = opts;
  const refuse = (code: MoveRefusalCode, message?: string): MoveOutcome => ({
    status: "refused",
    code,
    message: message ?? REFUSAL_TEXT[code],
  });

  if (!(await eventsEnabled())) return refuse("events-off");

  // Fresh, inside the lock: the decision below is made from this row.
  let row: MoveEventRow | null;
  try {
    row = (await Event.findById(eventId).lean()) as MoveEventRow | null;
  } catch (error) {
    logger.error(
      `Event ${sanitizeForLog(eventId)}: could not read the event for a move:`,
      error,
    );
    // Not "no-event": the event may well exist, so a caller that owes moves
    // must be able to tell this from a deleted one and try again.
    return refuse(
      "unreadable",
      "The event could not be read, so nobody was moved.",
    );
  }
  if (!row || row.guildId !== guildId) return refuse("no-event");
  const states = opts.allowFinished
    ? [...OPEN_STATES, "ended", "cancelled"]
    : OPEN_STATES;
  if (!states.includes(row.state)) return refuse("not-open");
  if (row.groupsEnabled !== true || (row.groups ?? []).length === 0) {
    return refuse("no-groups");
  }

  const guild = client.guilds?.cache?.get(guildId);
  if (!guild) return refuse("no-guild");
  const blocker = moveMembersBlocker(guild, opts.channelScoped);
  if (blocker) {
    return refuse(
      blocker === REFUSAL_TEXT["no-permission"] ? "no-permission" : "no-guild",
      blocker,
    );
  }
  const presence = readEventPresence(client, row as unknown as PresenceRow);
  if (!presence.ok) return refuse("no-guild");

  const planned = opts.plan({ event: row, guild, presence });
  if (!Array.isArray(planned)) return refuse("plan", planned.refuse);

  const eventChannels = new Set(
    eventVoiceChannelIds(row as unknown as ChannelRow),
  );
  const mover = new Mover(client, guild, eventChannels, opts.deps);
  const report = await mover.run(planned, exclude);
  return { status: "done", report, considered: planned.length };
}

class Mover {
  private restClient: REST | null;
  private readonly baseMakeRequest?: RESTOptions["makeRequest"];
  private readonly callOverride?: ApiCaller;
  private readonly paceMs: number;
  /** People Discord confirmed moving, by destination (the gateway may lag). */
  private readonly confirmedTo = new Map<
    string,
    { from: string; to: string }
  >();
  /** People whose move was not confirmed: reserved a place at the destination
   * but never assumed to have left their source. */
  private readonly unconfirmedTo = new Map<string, string>();
  /**
   * For each member whose move is queued or in flight: the check that must
   * still hold at the moment the request actually goes out (see `rest()`).
   */
  private readonly dispatchGuards = new Map<string, () => void>();
  /** Moves sent and not answered yet: member -> destination. */
  private readonly inflight = new Map<string, string>();
  /** Members whose arrival at the destination was seen while in flight. */
  private readonly arrived = new Set<string>();
  private voiceListener: ((o: VoiceState, n: VoiceState) => void) | null = null;

  constructor(
    private readonly client: Client,
    private readonly guild: Guild,
    private readonly eventChannels: Set<string>,
    deps: MoverDeps = {},
  ) {
    this.baseMakeRequest = deps.makeRequest;
    this.restClient = deps.rest ?? null;
    this.callOverride = deps.call;
    this.paceMs = deps.paceMs ?? MOVE_PACE_MS;
  }

  async run(wishes: MoveWish[], exclude: Set<string>): Promise<MoveReport> {
    this.attach();
    try {
      return await this.runInner(wishes, exclude);
    } finally {
      this.detach();
    }
  }

  /**
   * Retire reconciliation entries as soon as the gateway shows the change they
   * stand in for, so later voice changes (someone going back to where they
   * came from) take precedence over a bookkeeping entry. Without a gateway
   * (a stand-in client) `occupancy` retires them by looking at the cache.
   */
  private attach(): void {
    const client = this.client as { on?: unknown; off?: unknown };
    if (typeof client.on !== "function") return;
    this.voiceListener = (_old, next): void => {
      if (shouldIgnoreGuild(next.guild.id, env.guildId)) return;
      if (next.guild.id !== this.guild.id || !next.id) return;
      const live = next.channelId ?? null;
      // The arrival can reach the gateway before the REST answer does: note
      // it for a move that is still in flight, so the answer does not create
      // an entry for a change that was already seen (and possibly undone).
      if (this.inflight.get(next.id) === live) this.arrived.add(next.id);
      this.retire(next.id, live);
    };
    this.client.on(Events.VoiceStateUpdate, this.voiceListener);
  }

  private detach(): void {
    if (!this.voiceListener) return;
    this.client.off?.(Events.VoiceStateUpdate, this.voiceListener);
    this.voiceListener = null;
  }

  /** The gateway says `userId` is in `live` (null = not connected). */
  private retire(userId: string, live: string | null): void {
    const confirmed = this.confirmedTo.get(userId);
    // Still in the source: the gateway is only lagging, keep the entry. Any
    // other state (arrived, or moved on by themselves) is the truth.
    if (confirmed && live !== confirmed.from) this.confirmedTo.delete(userId);
    if (this.unconfirmedTo.get(userId) === live) {
      this.unconfirmedTo.delete(userId);
    }
  }

  private async runInner(
    wishes: MoveWish[],
    exclude: Set<string>,
  ): Promise<MoveReport> {
    const report: MoveReport = { moved: [], skipped: [], unconfirmed: [] };
    const skip = (
      userId: string,
      reason: MoveSkipReason,
      detail?: string,
    ): void => {
      report.skipped.push({ userId, reason, ...(detail ? { detail } : {}) });
    };

    // One wish per person (the first), the host and the acting user out, and
    // only destinations that are the event's own channels.
    const seen = new Set<string>();
    const queue: MoveWish[] = [];
    for (const wish of wishes) {
      if (seen.has(wish.userId)) continue;
      seen.add(wish.userId);
      if (exclude.has(wish.userId)) {
        skip(wish.userId, "host");
        continue;
      }
      if (!this.eventChannels.has(wish.toChannelId)) {
        skip(wish.userId, "error", "that channel is not part of the event");
        continue;
      }
      queue.push(wish);
    }

    // Destinations are read from Discord, not the cache, before anyone is
    // moved into them. Their size is the channel's user limit; who is in them
    // is read live (`occupancy`) each time it matters.
    const destinations = new Map<
      string,
      { limit: number } | { error: string }
    >();
    let rateLimited = false;
    for (const id of new Set(queue.map((w) => w.toChannelId))) {
      try {
        const channel = await this.call(
          () => this.guild.channels.fetch(id, { force: true }),
          "read event channel",
          true,
        );
        if (
          !channel ||
          channel.type !== ChannelType.GuildVoice ||
          channel.guildId !== this.guild.id
        ) {
          destinations.set(id, { error: "it is not a voice channel here" });
          continue;
        }
        const voice = channel as VoiceChannel;
        destinations.set(id, { limit: voice.userLimit ?? 0 });
      } catch (error) {
        if (error instanceof RateLimitError) rateLimited = true;
        destinations.set(id, { error: describeWriteFailure(error) });
      }
    }

    let attempted = 0;
    let touched = false;
    for (const wish of queue) {
      const { userId, toChannelId, fromChannelId, skipIf } = wish;
      if (rateLimited) {
        skip(userId, "rate-limited");
        continue;
      }
      if (skipIf?.()) {
        skip(userId, "withdrawn");
        continue;
      }
      const dest = destinations.get(toChannelId);
      if (!dest || "error" in dest) {
        skip(
          userId,
          "error",
          dest && "error" in dest
            ? `the destination could not be checked (${dest.error})`
            : "the destination could not be checked",
        );
        continue;
      }
      // The gateway's own state settles the obvious cases before any request
      // is made, and these skips do not count against the per-run cap: a
      // second run over a long list must get past the people the first run
      // already moved. (Only a decision NOT to move is taken from the cache;
      // every move is decided from Discord's answer below.)
      const cachedChannel =
        this.guild.voiceStates.cache.get(userId)?.channelId ?? null;
      if (!cachedChannel) {
        skip(userId, "not-connected");
        continue;
      }
      if (!this.eventChannels.has(cachedChannel)) {
        skip(userId, "elsewhere");
        continue;
      }
      if (fromChannelId && cachedChannel !== fromChannelId) {
        skip(userId, "moved-on");
        continue;
      }
      if (cachedChannel === toChannelId) {
        skip(userId, "already-there");
        continue;
      }
      // A destination that is full right now costs no request either, so a
      // run whose first people all aim at full groups still reaches the rest.
      if (this.isFull(toChannelId, dest.limit)) {
        skip(userId, "group-full");
        continue;
      }
      // A permission the cache already shows missing costs no request either
      // (checked again after the read, from the Discord-read source channel).
      if (!this.botMayMove(cachedChannel, toChannelId)) {
        skip(userId, "missing-permission");
        continue;
      }
      if (attempted >= MAX_MOVES_PER_RUN) {
        skip(userId, "over-limit");
        continue;
      }
      attempted += 1;
      if (touched && this.paceMs > 0) await sleep(this.paceMs);
      touched = true;

      // The person's voice state, from Discord.
      let sourceId: string | null;
      try {
        // The raw payload, NOT `guild.voiceStates.fetch`: discord.js patches
        // an existing cached voice state with the REST answer
        // (`VoiceStateManager._add` -> `existing._patch(data)`, even with
        // `cache: false`), so an older answer arriving after a newer gateway
        // update would put the member back where the gateway just said they
        // no longer are. The gateway cache stays the gateway's.
        const raw = (await this.call(
          () =>
            this.client.rest.get(Routes.guildVoiceState(this.guild.id, userId)),
          "read member voice state",
          true,
        )) as { channel_id?: string | null };
        const state = { channelId: raw?.channel_id ?? null };
        sourceId = state.channelId ?? null;
      } catch (error) {
        if (
          error instanceof DiscordAPIError &&
          error.code === DISCORD_UNKNOWN_VOICE_STATE
        ) {
          skip(userId, "not-connected");
        } else if (error instanceof RateLimitError) {
          rateLimited = true;
          skip(userId, "rate-limited");
        } else {
          skip(userId, "error", describeWriteFailure(error));
        }
        continue;
      }
      if (!sourceId) {
        skip(userId, "not-connected");
        continue;
      }
      if (!this.eventChannels.has(sourceId)) {
        skip(userId, "elsewhere");
        continue;
      }
      if (fromChannelId && sourceId !== fromChannelId) {
        skip(userId, "moved-on");
        continue;
      }
      if (sourceId === toChannelId) {
        skip(userId, "already-there");
        continue;
      }
      // Live again: a join or a departure during the read above counts.
      if (this.isFull(toChannelId, dest.limit)) {
        skip(userId, "group-full");
        continue;
      }
      if (!this.botMayMove(sourceId, toChannelId)) {
        skip(userId, "missing-permission");
        continue;
      }

      // Marked before the request: the join can reach the gateway first.
      // Where the move really starts: the live channel in the same tick as
      // the request (the member may have gone from one event channel to
      // another since the read).
      let startsFrom: string = sourceId;
      const attempt = markHostMove(this.guild.id, userId, toChannelId);
      this.inflight.set(userId, toChannelId);
      this.arrived.delete(userId);
      // The checks that must hold when the request is sent: the member still
      // in an event channel (and not already in the destination), and the
      // destination not full. They run when the move is enqueued AND again,
      // through the write client's `makeRequest`, at the moment the request
      // actually goes out, so a rate-limit wait in the client's queue cannot
      // leave a stale decision behind.
      const assertMovable = (): string => {
        if (skipIf?.()) throw new WithdrawnError();
        const live = this.guild.voiceStates.cache.get(userId)?.channelId;
        if (!live || !this.eventChannels.has(live)) {
          throw new MovedAwayError(!!live);
        }
        if (fromChannelId && live !== fromChannelId) {
          throw new MovedOnError();
        }
        if (live === toChannelId) throw new AlreadyThereError();
        if (this.isFull(toChannelId, dest.limit)) {
          throw new DestinationFullError();
        }
        return live;
      };
      this.dispatchGuards.set(userId, () => {
        assertMovable();
      });
      try {
        await this.call(
          (signal) => {
            startsFrom = assertMovable();
            return this.rest().patch(
              Routes.guildMember(this.guild.id, userId),
              {
                body: { channel_id: toChannelId },
                reason: "Event host move",
                signal,
              },
            );
          },
          "move event member",
          // Never replayed: a second attempt could pull back someone who has
          // since moved on their own.
          false,
        );
        report.moved.push(userId);
        // Only a change the gateway has NOT shown yet needs an entry; one it
        // showed (even if the member has since gone back) is in the cache.
        const live = this.guild.voiceStates.cache.get(userId)?.channelId;
        if (!this.arrived.has(userId) && live !== toChannelId) {
          this.confirmedTo.set(userId, { from: startsFrom, to: toChannelId });
        }
      } catch (error) {
        if (error instanceof AlreadyThereError) {
          // Arrived on its own meanwhile: nothing was sent, and the join that
          // already happened must not be taken as ours.
          unmarkHostMove(this.guild.id, userId, toChannelId, attempt);
          skip(userId, "already-there");
        } else if (error instanceof DestinationFullError) {
          unmarkHostMove(this.guild.id, userId, toChannelId, attempt);
          skip(userId, "group-full");
        } else if (error instanceof WithdrawnError) {
          unmarkHostMove(this.guild.id, userId, toChannelId, attempt);
          skip(userId, "withdrawn");
        } else if (error instanceof MovedOnError) {
          unmarkHostMove(this.guild.id, userId, toChannelId, attempt);
          skip(userId, "moved-on");
        } else if (error instanceof MovedAwayError) {
          unmarkHostMove(this.guild.id, userId, toChannelId, attempt);
          skip(userId, error.connected ? "elsewhere" : "not-connected");
        } else if (isRateLimited(error)) {
          unmarkHostMove(this.guild.id, userId, toChannelId, attempt);
          rateLimited = true;
          skip(userId, "rate-limited");
        } else if (error instanceof DiscordAPIError) {
          unmarkHostMove(this.guild.id, userId, toChannelId, attempt);
          if (error.code === DISCORD_NOT_IN_VOICE) {
            skip(userId, "not-connected");
          } else if (error.code === DISCORD_MISSING_PERMISSIONS) {
            skip(userId, "missing-permission");
          } else {
            skip(userId, "error", describeWriteFailure(error));
          }
        } else {
          // Timeout or a lost answer: it may have landed, so the mark stays
          // and the destination keeps a place for the person. They are NOT
          // assumed to have left their source: that stays counted until the
          // gateway shows otherwise.
          report.unconfirmed.push(userId);
          if (!this.arrived.has(userId)) {
            this.unconfirmedTo.set(userId, toChannelId);
          }
          logger.warn(
            `Event move of ${sanitizeForLog(userId)} not confirmed: ${sanitizeForLog(describeWriteFailure(error))}`,
          );
        }
      } finally {
        this.dispatchGuards.delete(userId);
        this.inflight.delete(userId);
        this.arrived.delete(userId);
      }
    }
    return report;
  }

  /**
   * Who is in `channelId` now: the gateway's live members, plus the people this
   * run moved there (confirmed or not) that the gateway has not shown yet, and
   * minus the people Discord confirmed moving out of it that the gateway still
   * shows in their source. A person whose move was not confirmed keeps
   * counting at their source. An entry lasts only until the gateway shows the
   * arrival (or any other state than the source), so a later voice change
   * always wins. Counted by id, so nobody is counted twice. The guarantee is
   * the gateway cache plus these reservations; it is not Discord's own count.
   */
  private occupancy(channelId: string): number {
    // Look at the cache first: an entry whose change the gateway already
    // shows is done with, and what the gateway says from then on wins.
    for (const userId of [...this.confirmedTo.keys()]) {
      this.retire(
        userId,
        this.guild.voiceStates.cache.get(userId)?.channelId ?? null,
      );
    }
    for (const userId of [...this.unconfirmedTo.keys()]) {
      this.retire(
        userId,
        this.guild.voiceStates.cache.get(userId)?.channelId ?? null,
      );
    }
    const ids = new Set<string>();
    const channel = this.guild.channels.cache.get(channelId);
    if (channel?.isVoiceBased()) {
      for (const id of channel.members.keys()) ids.add(id);
    }
    for (const [userId, { to }] of this.confirmedTo) {
      if (to === channelId) ids.add(userId);
      else ids.delete(userId);
    }
    for (const [userId, to] of this.unconfirmedTo) {
      if (to === channelId) ids.add(userId);
    }
    return ids.size;
  }

  private isFull(channelId: string, limit: number): boolean {
    return limit > 0 && this.occupancy(channelId) >= limit;
  }

  /** The bot can move out of `from` and connect to `to` (cache; Discord has the last word). */
  private botMayMove(from: string, to: string): boolean {
    const me = this.guild.members?.me;
    if (!me) return false;
    try {
      const source = this.guild.channels.cache.get(from);
      const target = this.guild.channels.cache.get(to);
      if (!source || !target) return false;
      return (
        me.permissionsIn(source).has(PermissionFlagsBits.MoveMembers) &&
        me.permissionsIn(target).has(PermissionFlagsBits.Connect)
      );
    } catch {
      return false;
    }
  }

  private rest(): REST {
    if (!this.restClient) {
      if (!this.client.token) throw new Error("The bot is not logged in");
      const base = this.baseMakeRequest ?? DefaultRestOptions.makeRequest;
      const memberPath = new RegExp(
        `/guilds/${this.guild.id}/members/([^/]+)$`,
      );
      this.restClient = createWriteRest(this.client.token, (url, init) => {
        // Every dispatch (the first, and the one after a rate-limit wait)
        // passes here: re-check the member before the request really goes out.
        const id = memberPath.exec(String(url).split("?")[0])?.[1];
        if (id) this.dispatchGuards.get(id)?.();
        return base(url, init);
      });
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

// ---------------------------------------------------------------------
// Planners: what each host action asks the mover to do.
// ---------------------------------------------------------------------

/**
 * Send to groups: every assigned member of a team group goes to that group's
 * own channel, so nobody changes group. Groups without a channel yet are
 * left out (their members are not listed as moved or skipped, the host panel
 * says so beforehand); open and leads groups are never targets.
 */
export function planSendToGroups(event: MoveEventRow): MoveWish[] {
  const wishes: MoveWish[] = [];
  for (const group of event.groups ?? []) {
    if (group.kind !== "team" || !group.channelId) continue;
    for (const userId of group.memberIds ?? []) {
      wishes.push({ userId, toChannelId: group.channelId });
    }
  }
  return wishes;
}

/**
 * Return to main: everyone connected to a group channel goes to the main
 * channel. `leaveSpecial` keeps people in `open` and `leads` channels where
 * they are.
 */
export function planReturnToMain(
  event: MoveEventRow,
  presence: EventPresence,
  leaveSpecial: boolean,
): MovePlan {
  const main = event.channelId;
  if (!main) {
    return {
      refuse: "The event's main channel does not exist, so nobody was moved.",
    };
  }
  const groupChannels = new Map<string, string>();
  for (const g of event.groups ?? []) {
    if (g.channelId) groupChannels.set(g.channelId, g.kind ?? "team");
  }
  const wishes: MoveWish[] = [];
  for (const person of presence.members) {
    const kind = groupChannels.get(person.channelId);
    if (!kind || person.channelId === main) continue;
    if (leaveSpecial && kind !== "team") continue;
    wishes.push({ userId: person.id, toChannelId: main });
  }
  return wishes;
}

/** Move one person to the main channel (`"main"`) or to a group's channel (its key). */
export function planMoveOne(
  event: MoveEventRow,
  userId: string,
  destination: string,
): MovePlan {
  let channelId: string | null | undefined;
  let kind: string | undefined;
  if (destination === "main") {
    channelId = event.channelId;
  } else {
    const group = (event.groups ?? []).find((g) => g.key === destination);
    channelId = group?.channelId;
    kind = group?.kind;
  }
  if (!channelId) {
    return {
      refuse:
        "That channel does not exist (yet), so nobody was moved. Pick another destination.",
    };
  }
  // The leads channel is for the host and the leaders (#1199): putting anyone
  // else there would only be undone by the channel's own upkeep.
  if (
    kind === "leads" &&
    userId !== event.createdBy &&
    !leadsLeaderIds(event).includes(userId)
  ) {
    return {
      refuse:
        "Only the host and the leaders can be moved into the leaders-only channel, so nobody was moved.",
    };
  }
  return [{ userId, toChannelId: channelId }];
}

/**
 * The text of a finished run, for the host's flash. The flash is cut at
 * `FLASH_MAX` characters, so what matters most comes first and the optional
 * names last, each piece added only while it fits:
 *
 * 1. the number moved, the warning about moves Discord did not confirm (with
 *    "check Discord before trying again"), the skip counts by reason and the
 *    caller's `extra` sentences: always whole;
 * 2. then names, unconfirmed people first, trimmed ("and N more") or left out
 *    to stay inside the budget.
 */
export function describeMoveReport(
  report: MoveReport,
  nameOf: (userId: string) => string,
  extra: readonly string[] = [],
  budget: number = FLASH_MAX,
): string {
  const byReason = new Map<MoveSkipReason, MoveSkip[]>();
  for (const s of report.skipped) {
    const list = byReason.get(s.reason) ?? [];
    list.push(s);
    byReason.set(s.reason, list);
  }
  const quiet = byReason.get("already-there")?.length ?? 0;
  const loud = report.skipped.length - quiet;
  const core: string[] = [`Moved ${report.moved.length}.`];
  if (report.unconfirmed.length > 0) {
    core.push(
      `Discord did not confirm ${report.unconfirmed.length}, who may or may not have moved: check Discord before trying again.`,
    );
  }
  if (loud > 0) {
    const reasons = [...byReason.entries()]
      .filter(([reason]) => reason !== "already-there")
      .map(([reason, list]) => {
        return `${list.length} ${MOVE_SKIP_LABEL[reason]}`;
      });
    core.push(`Skipped ${loud}: ${reasons.join("; ")}.`);
  }
  if (quiet > 0) core.push(`${quiet} already in the right channel.`);
  core.push(...extra);

  let text = core.join(" ");
  const groups: Array<[string, string[]]> = [];
  if (report.unconfirmed.length > 0) {
    groups.push(["Not confirmed", report.unconfirmed.map(nameOf)]);
  }
  for (const [reason, list] of byReason) {
    if (reason === "already-there") continue;
    groups.push([
      MOVE_SKIP_LABEL[reason].replace(/^./, (c) => c.toUpperCase()),
      list.map((s) => nameOf(s.userId)),
    ]);
  }
  // Diagnostic details (a failure explanation can be long) only while they
  // fit, before the names: each distinct text once, shortened.
  const seenDetails = new Set<string>();
  for (const skip of report.skipped) {
    if (!skip.detail || seenDetails.has(skip.detail)) continue;
    seenDetails.add(skip.detail);
    for (const max of [160, 80, 40]) {
      const piece = ` ${MOVE_SKIP_LABEL[skip.reason].replace(/^./, (c) => c.toUpperCase())}: ${clip(skip.detail, max)}.`;
      if (text.length + piece.length <= budget) {
        text += piece;
        break;
      }
    }
  }
  for (const [label, who] of groups) {
    for (const limit of [10, 5, 2, 1]) {
      const piece = ` ${label}: ${names(who, limit)}.`;
      if (text.length + piece.length <= budget) {
        text += piece;
        break;
      }
    }
  }
  return text;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function names(list: string[], limit: number): string {
  if (list.length <= limit) return list.join(", ");
  return `${list.slice(0, limit).join(", ")} and ${list.length - limit} more`;
}
