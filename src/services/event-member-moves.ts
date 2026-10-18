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
 *   (`voiceStates.fetch(id, { force: true })`) and an unreadable one skips
 *   that person. Every destination channel is force-fetched and must be a
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
  DiscordAPIError,
  PermissionFlagsBits,
  RateLimitError,
  Routes,
  type Client,
  type Guild,
  type REST,
  type VoiceChannel,
} from "discord.js";
import { Event, type IEvent } from "../models/event.js";

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
 * The most people one run asks Discord to move. A run holds the web request
 * open until it ends, so it is bounded; the rest are listed as not attempted
 * and the host runs the action again.
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
  groups?: Array<{
    key: string;
    name: string;
    kind?: string;
    size?: number | null;
    channelId?: string | null;
    memberIds?: string[];
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
}

let defaultDepsForTests: MoverDeps | undefined;
/** Tests of callers (the host routes): stand in for Discord for every run. */
export function setMoverDepsForTests(deps: MoverDeps | undefined): void {
  defaultDepsForTests = deps;
}

/** Thrown inside a move attempt when the live voice state no longer allows it. */
class MovedAwayError extends Error {
  constructor(readonly connected: boolean) {
    super("The member is no longer in an event channel");
    this.name = "MovedAwayError";
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
export function moveMembersBlocker(guild: Guild | undefined): string | null {
  if (!guild) return REFUSAL_TEXT["no-guild"];
  const me = guild.members?.me;
  if (!me) {
    return "The bot could not check its own permissions, so moving people is switched off.";
  }
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
export function moveEventMembers(opts: {
  client: Client;
  guildId: string;
  eventId: string;
  plan: (ctx: MovePlanContext) => MovePlan;
  /** People never moved by this run (the host, the acting user). */
  excludeUserIds?: readonly string[];
  deps?: MoverDeps;
}): Promise<MoveOutcome> {
  // Everything taken from the caller happens here, synchronously.
  const { client, guildId, eventId, plan } = opts;
  const deps = opts.deps ?? defaultDepsForTests;
  const exclude = new Set(opts.excludeUserIds ?? []);
  return withEventMoveLock(eventId, () =>
    runLocked({ client, guildId, eventId, plan, exclude, deps }),
  ).then((result) => (result.busy ? { status: "busy" } : result.value));
}

async function runLocked(opts: {
  client: Client;
  guildId: string;
  eventId: string;
  plan: (ctx: MovePlanContext) => MovePlan;
  exclude: Set<string>;
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
    return refuse("no-event");
  }
  if (!row || row.guildId !== guildId) return refuse("no-event");
  if (!OPEN_STATES.includes(row.state)) return refuse("not-open");
  if (row.groupsEnabled !== true || (row.groups ?? []).length === 0) {
    return refuse("no-groups");
  }

  const guild = client.guilds?.cache?.get(guildId);
  if (!guild) return refuse("no-guild");
  const blocker = moveMembersBlocker(guild);
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
  private readonly callOverride?: ApiCaller;
  private readonly paceMs: number;

  constructor(
    private readonly client: Client,
    private readonly guild: Guild,
    private readonly eventChannels: Set<string>,
    deps: MoverDeps = {},
  ) {
    this.restClient = deps.rest ?? null;
    this.callOverride = deps.call;
    this.paceMs = deps.paceMs ?? MOVE_PACE_MS;
  }

  async run(wishes: MoveWish[], exclude: Set<string>): Promise<MoveReport> {
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
    // moved into them. Occupancy is counted from here on as people arrive.
    const destinations = new Map<
      string,
      { limit: number; occupants: number } | { error: string }
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
        destinations.set(id, {
          limit: voice.userLimit ?? 0,
          occupants: voice.members.size,
        });
      } catch (error) {
        if (error instanceof RateLimitError) rateLimited = true;
        destinations.set(id, { error: describeWriteFailure(error) });
      }
    }

    let attempted = 0;
    let touched = false;
    for (const wish of queue) {
      const { userId, toChannelId } = wish;
      if (rateLimited) {
        skip(userId, "rate-limited");
        continue;
      }
      if (attempted >= MAX_MOVES_PER_RUN) {
        skip(userId, "over-limit");
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
      attempted += 1;
      if (touched && this.paceMs > 0) await sleep(this.paceMs);
      touched = true;

      // The person's voice state, from Discord.
      let sourceId: string | null;
      try {
        const state = await this.call(
          () => this.guild.voiceStates.fetch(userId, { force: true }),
          "read member voice state",
          true,
        );
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
      if (sourceId === toChannelId) {
        skip(userId, "already-there");
        continue;
      }
      if (dest.limit > 0 && dest.occupants >= dest.limit) {
        skip(userId, "group-full");
        continue;
      }
      if (!this.botMayMove(sourceId, toChannelId)) {
        skip(userId, "missing-permission");
        continue;
      }

      // Marked before the request: the join can reach the gateway first.
      markHostMove(this.guild.id, userId, toChannelId);
      try {
        await this.call(
          (signal) => {
            // The gateway's live state, in the same tick as the request: the
            // person may have left the event's channels since the read above.
            const live = this.guild.voiceStates.cache.get(userId)?.channelId;
            if (!live || !this.eventChannels.has(live)) {
              throw new MovedAwayError(!!live);
            }
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
        dest.occupants += 1;
        this.leave(destinations, sourceId);
      } catch (error) {
        if (error instanceof MovedAwayError) {
          unmarkHostMove(this.guild.id, userId, toChannelId);
          skip(userId, error.connected ? "elsewhere" : "not-connected");
        } else if (error instanceof RateLimitError) {
          unmarkHostMove(this.guild.id, userId, toChannelId);
          rateLimited = true;
          skip(userId, "rate-limited");
        } else if (error instanceof DiscordAPIError) {
          unmarkHostMove(this.guild.id, userId, toChannelId);
          if (error.code === DISCORD_NOT_IN_VOICE) {
            skip(userId, "not-connected");
          } else if (error.code === DISCORD_MISSING_PERMISSIONS) {
            skip(userId, "missing-permission");
          } else {
            skip(userId, "error", describeWriteFailure(error));
          }
        } else {
          // Timeout or a lost answer: it may have landed, so the mark stays
          // and the destination counts the person as arrived.
          report.unconfirmed.push(userId);
          dest.occupants += 1;
          this.leave(destinations, sourceId);
          logger.warn(
            `Event move of ${sanitizeForLog(userId)} not confirmed: ${sanitizeForLog(describeWriteFailure(error))}`,
          );
        }
      }
    }
    return report;
  }

  /** A person who left `channelId` frees a place there. */
  private leave(
    destinations: Map<
      string,
      { limit: number; occupants: number } | { error: string }
    >,
    channelId: string,
  ): void {
    const d = destinations.get(channelId);
    if (d && !("error" in d) && d.occupants > 0) d.occupants -= 1;
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
  if (destination === "main") {
    channelId = event.channelId;
  } else {
    channelId = (event.groups ?? []).find(
      (g) => g.key === destination,
    )?.channelId;
  }
  if (!channelId) {
    return {
      refuse:
        "That channel does not exist (yet), so nobody was moved. Pick another destination.",
    };
  }
  return [{ userId, toChannelId: channelId }];
}

/** The text of a finished run, for the host's flash. */
export function describeMoveReport(
  report: MoveReport,
  nameOf: (userId: string) => string,
): string {
  const parts: string[] = [`Moved ${report.moved.length}.`];
  const byReason = new Map<MoveSkipReason, MoveSkip[]>();
  for (const s of report.skipped) {
    const list = byReason.get(s.reason) ?? [];
    list.push(s);
    byReason.set(s.reason, list);
  }
  const quiet = byReason.get("already-there")?.length ?? 0;
  const loud = report.skipped.length - quiet;
  if (loud > 0) {
    const reasons = [...byReason.entries()]
      .filter(([reason]) => reason !== "already-there")
      .map(([reason, list]) => {
        const who = names(list.map((s) => nameOf(s.userId)));
        const detail = list.find((s) => s.detail)?.detail;
        return `${list.length} ${MOVE_SKIP_LABEL[reason]}${detail ? ` (${detail})` : ""} (${who})`;
      });
    parts.push(`Skipped ${loud}: ${reasons.join("; ")}.`);
  }
  if (quiet > 0) parts.push(`${quiet} already in the right channel.`);
  if (report.unconfirmed.length > 0) {
    parts.push(
      `Discord did not confirm ${report.unconfirmed.length}, who may or may not have moved: ${names(report.unconfirmed.map(nameOf))}. Check Discord before trying again.`,
    );
  }
  return parts.join(" ");
}

function names(list: string[], limit = 10): string {
  if (list.length <= limit) return list.join(", ");
  return `${list.slice(0, limit).join(", ")} and ${list.length - limit} more`;
}
