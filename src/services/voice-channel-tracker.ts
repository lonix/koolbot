import {
  VoiceState,
  GuildMember,
  VoiceChannel,
  Client,
  ButtonInteraction,
  User,
  MessageFlags,
} from "discord.js";
import logger, { isDebugMode } from "../utils/logger.js";
import { MongoConnectionGuard } from "../utils/mongo.js";
import { safeReply } from "../utils/safe-reply.js";
import { VoiceChannelTracking } from "../models/voice-channel-tracking.js";
import mongoose from "mongoose";
import { ConfigService } from "./config-service.js";
import { TrackingOptOutService } from "./tracking-opt-out-service.js";
import { AchievementsService } from "./achievements-service.js";

export type TimePeriod = "week" | "month" | "alltime";

interface IAggregatedUserStats {
  userId: string;
  username: string;
  totalTime: number;
}

interface IUserStats {
  userId: string;
  username: string;
  totalTime: number;
  lastSeen: Date;
  sessions: Array<{
    startTime: Date;
    endTime?: Date;
    duration?: number;
    channelId: string;
    channelName: string;
  }>;
}

interface VoiceSession {
  startTime: Date;
  channelId: string;
  channelName: string;
  /**
   * The guild the session is in, for the tracking opt-out checks at persist
   * time (#918). The tracking row itself is not guild-scoped.
   */
  guildId?: string;
  /**
   * Set while an `endTracking` call is persisting this session (#916).
   *
   * Discord's emitter does not await its handlers, so a switch still waiting
   * on its write and a disconnect arriving behind it both read the *same*
   * session out of `activeSessions` — and both would `$inc totalTime` and
   * `$push` it, counting one session twice. The flag is a synchronous
   * test-and-set on the session object, so only the first call persists it;
   * it is cleared again if that call fails, so the next disconnect retries.
   */
  persisting?: boolean;
}

/**
 * How many times `forgetActiveSession` will re-check for newly registered
 * persists before giving up. One round is enough once the session maps are
 * empty; the rest is belt and braces against an unbounded wait.
 */
const MAX_DRAIN_ROUNDS = 10;

/**
 * The per-session bookkeeping an `endTracking` call takes out of the shared
 * per-user maps before it starts awaiting (#916).
 */
interface ClaimedSessionState {
  encountered: Set<string> | undefined;
  since: Map<string, number> | undefined;
  seconds: Map<string, number> | undefined;
  firsts: { wasFirst: boolean; joinedExisting: string[] } | undefined;
}

/**
 * Close every still-open companion interval on one session's own maps.
 *
 * The same work as `accumulateCompanion`, but against maps a caller has
 * already claimed rather than the live per-user ones — which, by the time a
 * persist finishes, may belong to a session that started after it (#916).
 */
function closeCompanionIntervals(
  since: Map<string, number>,
  seconds: Map<string, number>,
): void {
  const now = Date.now();
  for (const [companionId, start] of Array.from(since.entries())) {
    const elapsed = Math.max(0, Math.floor((now - start) / 1000));
    seconds.set(companionId, (seconds.get(companionId) ?? 0) + elapsed);
    since.delete(companionId);
  }
}

/**
 * How long a purge will wait for in-flight persists before giving up on them.
 *
 * The round count alone does not bound the wait: an `endTracking` call keeps
 * going after its Mongo write — Discord fetches, accolade checks,
 * notifications — and one stalled call would otherwise hang the whole purge,
 * so the later collection deletes and the web-session revoke never run. A
 * timeout turns that into one incomplete step instead of a stuck purge.
 */
const DRAIN_TIMEOUT_MS = 15_000;

/** What `forgetActiveSession` had to do for a member (#916). */
export interface ForgottenSession {
  /** An in-memory session was dropped before it could be persisted. */
  discarded: boolean;
  /**
   * A persist that had already read its session was waited out rather than
   * left to land after the purge's delete.
   */
  drained: boolean;
  /**
   * A persist was still running when the wait timed out. Its write may yet
   * land after the purge's delete, so the caller reports the voice step as
   * incomplete — and carries on with the rest of the purge rather than
   * hanging on it.
   */
  timedOut: boolean;
}

/**
 * Wait for every promise to settle, or give up after `timeoutMs`. Returns
 * whether they all settled in time. `endTracking` swallows its own errors,
 * but `allSettled` is used anyway so one rejection cannot abandon the rest.
 */
async function settleWithin(
  promises: Iterable<Promise<unknown>>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    // Do not hold the process open just to time a drain out.
    timer.unref?.();
  });
  try {
    return await Promise.race([
      Promise.allSettled([...promises]).then(() => true),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class VoiceChannelTracker {
  private static instance: VoiceChannelTracker;
  private activeSessions: Map<string, VoiceSession> = new Map();
  private userChannels: Map<string, VoiceChannel> = new Map();
  private encounteredUsers: Map<string, Set<string>> = new Map(); // Track all users encountered during each session
  // Precise per-companion co-presence accounting (#570). For each tracked
  // session: `companionSince` holds the epoch-ms start of the *current* open
  // overlap interval with each presently-co-located user, and
  // `companionSeconds` accumulates closed intervals. A companion's interval
  // opens when both are in the channel and closes when either leaves (or the
  // session ends). `sessionFirsts` records the channel's emptiness and the
  // users already present at the tracked user's join.
  private companionSince: Map<string, Map<string, number>> = new Map();
  private companionSeconds: Map<string, Map<string, number>> = new Map();
  private sessionFirsts: Map<
    string,
    { wasFirst: boolean; joinedExisting: string[] }
  > = new Map();
  /**
   * In-flight `endTracking` calls, keyed by user id (#916).
   *
   * `endTracking` reads `activeSessions` at its top and only reaches its
   * `upsert: true` write many awaits later, so evicting the maps does not
   * stop a persist that already got past that read: its write can land
   * *after* a purge deleted the row and resurrect it. `forgetActiveSession`
   * drains this map so the purge can wait the window out rather than race it.
   *
   * It is a **set** per user, not one promise. `voiceStateUpdate` handlers
   * are async and the emitter does not serialise them, so a switch followed
   * closely by a disconnect can leave two `endTracking` calls running for
   * one member. Keeping only the latest meant the newer one finishing first
   * would clear the entry while the older write was still pending, and the
   * drain would sail straight past it.
   */
  private endingSessions: Map<string, Set<Promise<void>>> = new Map();
  /**
   * Bumped every time a member is evicted by a purge (#916).
   *
   * Draining `endTracking` is not enough on its own: a channel *switch*
   * awaits `endTracking` and then calls `startTracking`, so an update that
   * began before the eviction can restart tracking after the drain finished
   * — and the next disconnect upserts the row the purge just deleted. A
   * voice-state update reads this counter when it starts and checks it again
   * before restarting tracking; a bump in between means a purge happened and
   * the restart is abandoned.
   */
  private purgeGenerations: Map<string, number> = new Map();
  private client: Client;
  private mongo = new MongoConnectionGuard("voice channel tracker");
  private configService: ConfigService;

  private constructor(client: Client) {
    this.client = client;
    this.configService = ConfigService.getInstance();
  }

  public static getInstance(client: Client): VoiceChannelTracker {
    if (!VoiceChannelTracker.instance) {
      VoiceChannelTracker.instance = new VoiceChannelTracker(client);
    }
    return VoiceChannelTracker.instance;
  }

  public getActiveSession(userId: string): { channelName: string } | null {
    const session = this.activeSessions.get(userId);
    return session ? { channelName: session.channelName } : null;
  }

  /**
   * Drop every trace of a member's *in-flight* voice session from memory
   * (#914). Idempotent: a member with no open session is a no-op.
   *
   * A per-user purge needs this because `endTracking` persists with
   * `upsert: true`. Delete a member's `voice-channel-tracking` row while they
   * are still sitting in a voice channel and the row is *recreated* the
   * moment they disconnect, carrying `totalTime` for the whole session —
   * including the hours logged before the purge — and that resurrected total
   * is then fed straight into `checkAndAwardAccolades`. The race window is
   * the length of their current session: hours, not milliseconds.
   *
   * Evicting the member from `activeSessions` is what closes it: the
   * disconnect handler finds no session and returns before it writes. The
   * five companion maps are cleared alongside it so the eviction leaves no
   * orphaned co-presence state behind for a later session to inherit.
   *
   * The maps are private, so this cannot be done from outside the service.
   *
   * **Eviction alone is not enough**, which is why this is async. A
   * disconnect that reached `endTracking` before the eviction has already
   * read its session out of the map, and its `upsert: true` write is still
   * to come — clearing the maps cannot call that write back. So after
   * evicting, this waits for any persist already in flight for the member to
   * finish. The purge's own delete then runs strictly after it, and the row
   * stays deleted.
   *
   * Returns what it had to do, so the purge coordinator (#916) can record it:
   * a purge that caught a member mid-session is exactly the case an operator
   * reading a partial purge wants to see.
   */
  public async forgetActiveSession(userId: string): Promise<ForgottenSession> {
    const hadSession = this.activeSessions.has(userId);

    // Evict first: from here on, a disconnect finds no session and returns
    // before it writes anything. Only a persist already past that read is
    // left, and that is what the drain below waits for.
    // Bump first: an update already past its own read will now see a
    // different generation and abandon any restart.
    this.purgeGenerations.set(userId, this.purgeGeneration(userId) + 1);

    this.activeSessions.delete(userId);
    this.userChannels.delete(userId);
    this.encounteredUsers.delete(userId);
    this.companionSince.delete(userId);
    this.companionSeconds.delete(userId);
    this.sessionFirsts.delete(userId);

    const { drained, timedOut } = await this.drainEndingSessions(userId);

    if (hadSession) {
      logger.info(
        `Discarded in-flight voice session for user ${userId}; the disconnect handler will not persist it`,
      );
    }
    return { discarded: hadSession, drained, timedOut };
  }

  /**
   * Wait for every `endTracking` still running for a member.
   *
   * Loops rather than awaiting one snapshot: a call registered while we were
   * waiting on the previous batch would otherwise slip through. It
   * terminates because the eviction above has already emptied
   * `activeSessions`, so any call starting from here returns before it
   * writes — the bound is belt and braces against an unforeseen source of
   * new work, not a case we expect to hit.
   */
  private async drainEndingSessions(
    userId: string,
  ): Promise<{ drained: boolean; timedOut: boolean }> {
    let drainedAny = false;
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;

    for (let round = 0; round < MAX_DRAIN_ROUNDS; round++) {
      const pending = this.endingSessions.get(userId);
      if (!pending || pending.size === 0) {
        return { drained: drainedAny, timedOut: false };
      }

      if (!drainedAny) {
        logger.info(
          `Waiting for ${pending.size} in-flight voice session persist(s) for user ${userId} before the purge continues`,
        );
      }
      drainedAny = true;

      const remaining = deadline - Date.now();
      if (remaining <= 0 || !(await settleWithin(pending, remaining))) {
        // An `endTracking` call does more than its write — Discord fetches,
        // accolade checks — so a stall there must not take the rest of the
        // purge down with it. Report it and move on.
        logger.warn(
          `Timed out waiting for in-flight voice session persist(s) for user ${userId}; the purge will continue and report the step as incomplete`,
        );
        return { drained: drainedAny, timedOut: true };
      }
    }

    logger.warn(
      `Gave up draining in-flight voice session persists for user ${userId} after ${MAX_DRAIN_ROUNDS} rounds`,
    );
    return { drained: drainedAny, timedOut: true };
  }

  /** The member's current purge generation (see `purgeGenerations`). */
  private purgeGeneration(userId: string): number {
    return this.purgeGenerations.get(userId) ?? 0;
  }

  public async handleVoiceStateUpdate(
    oldState: VoiceState,
    newState: VoiceState,
  ): Promise<void> {
    try {
      const member = newState.member || oldState.member; // Try to get member from either state
      if (!member) {
        logger.info(`No member found in voice state update`);
        return;
      }
      // Before the first await, not after: a handler that yielded on the
      // config read below and resumed after a purge would otherwise read the
      // *new* generation and be waved through, installing a session for an
      // event that predates the erasure. Reading it here means every handler
      // already in flight carries a pre-purge token (#916).
      const generation = this.purgeGeneration(member.id);

      // Check if voice tracking is enabled
      const isEnabled = await this.configService.getBoolean(
        "voicetracking.enabled",
        false,
      );
      if (!isEnabled) {
        return; // Voice tracking is disabled
      }

      const oldChannel = oldState.channel;
      const newChannel = newState.channel;

      logger.info(
        `Voice state update for ${member.displayName} (${member.id}):`,
      );
      logger.info(
        `Old channel: ${oldChannel ? oldChannel.name : "none"} (${oldChannel?.id || "none"})`,
      );
      logger.info(
        `New channel: ${newChannel ? newChannel.name : "none"} (${newChannel?.id || "none"})`,
      );
      logger.info(
        `Active session exists: ${this.activeSessions.has(member.id)}`,
      );

      // User joined a channel (including initial join)
      if (!oldChannel && newChannel) {
        logger.info(
          `Starting tracking for user ${member.displayName} (${member.id}) in channel ${newChannel.name}`,
        );
        await this.startTracking(
          member,
          newChannel.id,
          newChannel.name,
          generation,
        );
      }
      // User switched channels
      else if (oldChannel && newChannel) {
        logger.info(
          `Ending tracking for user ${member.displayName} (${member.id}) in old channel ${oldChannel.name}`,
        );
        await this.endTrackingTracked(member.id);
        logger.info(
          `Starting tracking for user ${member.displayName} (${member.id}) in new channel ${newChannel.name}`,
        );
        // `startTracking` re-checks `generation` immediately before it
        // writes, so a purge landing anywhere in this transition — including
        // during its own config reads — cannot leave a session behind.
        await this.startTracking(
          member,
          newChannel.id,
          newChannel.name,
          generation,
        );
      }
      // User left a channel (disconnect) - handle both cases:
      // 1. oldChannel exists but newChannel is null (direct disconnect)
      // 2. both channels are null but we have an active session (final disconnect state)
      else if (
        (oldChannel && !newChannel) ||
        (!oldChannel && !newChannel && this.activeSessions.has(member.id))
      ) {
        logger.info(
          `User disconnected - Ending tracking for user ${member.displayName} (${member.id})`,
        );
        const activeSession = this.activeSessions.get(member.id);
        if (activeSession) {
          logger.info(
            `Found active session in channel ${activeSession.channelName} (${activeSession.channelId})`,
          );
        }
        await this.endTrackingTracked(member.id);
      }

      // Track users joining/leaving channels where we have active sessions
      // This ensures we capture all interactions even if users leave before the session ends.
      // Companion overlap accounting is extra per-update work, so only run it when
      // the feature is enabled (read the gate once for this update).
      const companionsEnabled = await this.configService.getBoolean(
        "voicetracking.companions.enabled",
        false,
      );
      if (oldChannel && !newChannel) {
        // User left a channel - record interaction for all active sessions in that channel
        this.recordUserInteraction(oldChannel.id, member.id);
        if (companionsEnabled) this.companionLeft(oldChannel.id, member.id);
      } else if (!oldChannel && newChannel) {
        // User joined a channel - record interaction for all active sessions in that channel
        this.recordUserInteraction(newChannel.id, member.id);
        if (companionsEnabled) this.companionJoined(newChannel.id, member.id);
      } else if (oldChannel && newChannel && oldChannel.id !== newChannel.id) {
        // User switched channels - record for both
        this.recordUserInteraction(oldChannel.id, member.id);
        this.recordUserInteraction(newChannel.id, member.id);
        if (companionsEnabled) {
          this.companionLeft(oldChannel.id, member.id);
          this.companionJoined(newChannel.id, member.id);
        }
      }
    } catch (error) {
      logger.error("Error handling voice state update in tracker:", error);
    }
  }

  /**
   * Records that a user was encountered in a channel for all active sessions in that channel
   */
  private recordUserInteraction(channelId: string, userId: string): void {
    // Find all active sessions in this channel
    for (const [sessionUserId, session] of this.activeSessions.entries()) {
      if (session.channelId === channelId && sessionUserId !== userId) {
        // Add this user to the encountered users set for this session
        const encounteredSet = this.encounteredUsers.get(sessionUserId);
        if (encounteredSet) {
          encounteredSet.add(userId);
        }
      }
    }
  }

  /**
   * Opens a co-presence interval between `companionId` and every tracked
   * session currently in `channelId`. Called when a user joins a channel.
   * In-memory only — persistence is gated separately in `endTracking`.
   */
  private companionJoined(channelId: string, companionId: string): void {
    const now = Date.now();
    for (const [sessionUserId, session] of this.activeSessions.entries()) {
      if (session.channelId !== channelId || sessionUserId === companionId) {
        continue;
      }
      const since = this.companionSince.get(sessionUserId);
      if (since && !since.has(companionId)) {
        since.set(companionId, now);
      }
    }
  }

  /**
   * Closes the open co-presence interval between `companionId` and every
   * tracked session in `channelId`, accumulating the elapsed seconds. Called
   * when a user leaves a channel.
   */
  private companionLeft(channelId: string, companionId: string): void {
    for (const [sessionUserId, session] of this.activeSessions.entries()) {
      if (session.channelId !== channelId || sessionUserId === companionId) {
        continue;
      }
      this.accumulateCompanion(sessionUserId, companionId);
    }
  }

  /**
   * Folds the currently-open interval for `(sessionUserId, companionId)` into
   * the accumulated total and clears it. Safe to call when no interval is
   * open (no-op).
   */
  private accumulateCompanion(
    sessionUserId: string,
    companionId: string,
  ): void {
    const since = this.companionSince.get(sessionUserId);
    const seconds = this.companionSeconds.get(sessionUserId);
    if (!since || !seconds) return;
    const start = since.get(companionId);
    if (start === undefined) return;
    const elapsed = Math.max(0, Math.floor((Date.now() - start) / 1000));
    seconds.set(companionId, (seconds.get(companionId) ?? 0) + elapsed);
    since.delete(companionId);
  }

  private async isChannelExcluded(channelId: string): Promise<boolean> {
    try {
      // Try new configuration key first, then fall back to old for backward compatibility
      let excludedChannels = await this.configService.get(
        "voicetracking.excluded_channels",
      );

      if (!excludedChannels) {
        // Fallback to old key
        excludedChannels = await this.configService.get("EXCLUDED_VC_CHANNELS");
      }

      if (!excludedChannels) return false;

      // Handle both string (comma-separated) and array formats
      if (typeof excludedChannels === "string") {
        return excludedChannels
          .split(",")
          .map((id) => id.trim())
          .includes(channelId);
      }

      if (Array.isArray(excludedChannels)) {
        return excludedChannels.includes(channelId);
      }

      return false;
    } catch (error: unknown) {
      logger.error("Error checking excluded channels:", error);
      return false;
    }
  }

  /**
   * @param generation the caller's purge generation, read before it started.
   *   Checked again immediately before the session maps are written: the
   *   config and Mongo work above yields to the event loop, so a purge can
   *   evict *between* the caller's own check and this write, and the session
   *   we are about to create would outlive it (#916).
   */
  private async startTracking(
    member: GuildMember,
    channelId: string,
    channelName: string,
    generation: number,
  ): Promise<void> {
    try {
      const debugModeEnabled = isDebugMode();
      await this.mongo.ensureConnection();

      // Check if channel is excluded
      if (await this.isChannelExcluded(channelId)) {
        if (debugModeEnabled) {
          logger.info(
            `[DEBUG] Channel ${channelName} (${channelId}) is excluded from tracking`,
          );
        }
        return;
      }

      // Last possible moment before the write, so nothing can slip between
      // the check and the mutation.
      if (this.purgeGeneration(member.id) !== generation) {
        logger.info(
          `Not starting tracking for user ${member.id}: their data was reset while this update was in flight`,
        );
        return;
      }

      // Member tracking opt-out (#918): no session, so nothing to persist.
      // Checked here, with the purge generation, for the same reason — the
      // awaits above leave time for an opt-out to land.
      const optOuts = TrackingOptOutService.getInstance();
      const guildId = member.guild?.id;
      if (guildId && optOuts.isOptedOut(member.id, guildId)) {
        if (debugModeEnabled) {
          logger.info(
            `[DEBUG] Not tracking user ${member.id}: they opted out of tracking`,
          );
        }
        return;
      }

      this.activeSessions.set(member.id, {
        startTime: new Date(),
        channelId,
        channelName,
        guildId,
      });

      // Initialize encountered users Set with current channel members
      const encounteredSet = new Set<string>();
      // Companion overlap (#570): open an interval for every user already in
      // the channel at the moment this user joins, and snapshot that set for
      // the "firsts" capture.
      const now = Date.now();
      const since = new Map<string, number>();
      const presentAtJoin: string[] = [];
      const guild = member.guild;
      if (guild) {
        const channel = guild.channels.cache.get(channelId) as VoiceChannel;
        if (channel) {
          this.userChannels.set(member.id, channel);
          // Add all current members except the joining user
          if (channel.members) {
            channel.members.forEach((m) => {
              // An opted-out member is not recorded as co-present in
              // anyone else's session either (#918).
              if (m.id !== member.id && !optOuts.isOptedOut(m.id, guild.id)) {
                encounteredSet.add(m.id);
                since.set(m.id, now);
                presentAtJoin.push(m.id);
              }
            });
          }
        }
      }
      this.encounteredUsers.set(member.id, encounteredSet);
      this.companionSince.set(member.id, since);
      this.companionSeconds.set(member.id, new Map());
      this.sessionFirsts.set(member.id, {
        wasFirst: presentAtJoin.length === 0,
        joinedExisting: presentAtJoin,
      });

      if (debugModeEnabled) {
        logger.info(
          `[DEBUG] Started tracking user ${member.displayName} (${member.id}) in channel ${channelName}, initial users: ${encounteredSet.size}`,
        );
      }
    } catch (error: unknown) {
      logger.error("Error starting voice tracking:", error);
    }
  }

  /**
   * Run `endTracking` while recording it as in flight, so
   * `forgetActiveSession` can wait for it (#916). Every call site goes
   * through here; calling `endTracking` directly reopens the race.
   */
  private async endTrackingTracked(userId: string): Promise<void> {
    const pending = this.endingSessions.get(userId) ?? new Set();
    this.endingSessions.set(userId, pending);

    const running: Promise<void> = this.endTracking(userId).finally(() => {
      pending.delete(running);
      if (pending.size === 0) this.endingSessions.delete(userId);
    });
    pending.add(running);
    await running;
  }

  private async endTracking(userId: string): Promise<void> {
    // Hoisted so the failure path can hand the claimed bookkeeping back:
    // `activeSessions` is deliberately left in place when the persist throws,
    // so the session is retried on the next disconnect, and it has to be
    // retried with the co-presence it was claimed with (#916).
    let session: VoiceSession | undefined;
    let claimed: ClaimedSessionState | undefined;

    try {
      const debugModeEnabled = isDebugMode();
      await this.mongo.ensureConnection();

      session = this.activeSessions.get(userId);
      if (session?.persisting) {
        // Another handler is already writing this very session. Persisting
        // it again would double-count it (#916).
        logger.info(
          `Skipping end-tracking for user ${userId}: this session is already being persisted`,
        );
        return;
      }
      if (!session) {
        if (debugModeEnabled) {
          logger.info(
            `[DEBUG] No active session found for user ${userId} when attempting to end tracking`,
          );
        }
        return;
      }

      // The member opted out of tracking mid-session (#918): drop the
      // session instead of persisting it. Synchronous, so no other handler
      // can claim it between the check and the discard.
      const optOuts = TrackingOptOutService.getInstance();
      if (session.guildId && optOuts.isOptedOut(userId, session.guildId)) {
        this.activeSessions.delete(userId);
        this.userChannels.delete(userId);
        this.encounteredUsers.delete(userId);
        this.companionSince.delete(userId);
        this.companionSeconds.delete(userId);
        this.sessionFirsts.delete(userId);
        logger.info(
          `Discarded voice session for user ${userId}: they opted out of tracking`,
        );
        return;
      }
      // Other members who opted out while co-present stay out of this row.
      const guildId = session.guildId;
      const tracked = (id: string): boolean =>
        !guildId || !optOuts.isOptedOut(id, guildId);

      // Take this session's bookkeeping out of the shared per-user maps in
      // one synchronous step (#916). Everything below awaits — a user fetch,
      // a config read, the write itself — and a rejoin in that window
      // installs a *new* session against the same keys. Sharing them would
      // count the new session's co-presence into this document and then wipe
      // it along with this one, so the rejoin's own disconnect would find
      // nothing to record.
      // Claimed synchronously, before the first await below, so a handler
      // arriving behind this one sees the flag rather than the session.
      session.persisting = true;
      claimed = {
        encountered: this.encounteredUsers.get(userId),
        since: this.companionSince.get(userId),
        seconds: this.companionSeconds.get(userId),
        firsts: this.sessionFirsts.get(userId),
      };
      this.encounteredUsers.delete(userId);
      this.companionSince.delete(userId);
      this.companionSeconds.delete(userId);
      this.sessionFirsts.delete(userId);

      const endTime = new Date();
      const duration = Math.floor(
        (endTime.getTime() - session.startTime.getTime()) / 1000,
      );

      if (debugModeEnabled) {
        logger.info(
          `[DEBUG] Ending session for user ${userId} in channel ${session.channelName} (${session.channelId})`,
        );
      }

      // Get user info from Discord
      const user: User = await this.client.users.fetch(userId);
      if (!user) {
        logger.error(`Could not find user ${userId} when ending tracking`);
        return;
      }

      // Get accumulated users from the encountered users Set
      const otherUsers: string[] = claimed.encountered
        ? Array.from(claimed.encountered).filter(tracked)
        : [];

      // Build the optional companion/firsts payload only when the feature is
      // enabled, so disabled deployments persist exactly the legacy shape and
      // skip the interval-closing / map churn entirely.
      const companionsEnabled = await this.configService.getBoolean(
        "voicetracking.companions.enabled",
        false,
      );
      const sessionDoc: Record<string, unknown> = {
        startTime: session.startTime,
        endTime,
        duration,
        channelId: session.channelId,
        channelName: session.channelName,
        otherUsers,
      };
      if (companionsEnabled) {
        // Close any still-open companion intervals so the final session
        // reflects everyone who was co-present right up to the disconnect.
        // On copies of the claimed maps: `accumulateCompanion` reads
        // `this.companionSince`, which by now may belong to a rejoin, and
        // the claimed maps themselves must survive intact in case the write
        // below fails and this session is handed back for a retry.
        const since = new Map(claimed.since ?? []);
        const seconds = new Map(claimed.seconds ?? []);
        closeCompanionIntervals(since, seconds);
        sessionDoc.companions = Array.from(seconds.entries())
          .filter(([id]) => tracked(id))
          .map(([id, secs]) => ({
            userId: id,
            seconds: secs,
          }));
        sessionDoc.wasFirst = claimed.firsts
          ? claimed.firsts.wasFirst
          : otherUsers.length === 0;
        sessionDoc.joinedExisting = claimed.firsts
          ? claimed.firsts.joinedExisting.filter(tracked)
          : [];
      }

      // Update or create user tracking record
      await VoiceChannelTracking.findOneAndUpdate(
        { userId },
        {
          $set: {
            username: user.username,
            lastSeen: endTime,
          },
          $inc: { totalTime: duration },
          $push: {
            sessions: sessionDoc,
          },
        },
        { upsert: true, new: true },
      );

      // Only the session this call actually persisted. A rejoin during the
      // write above installs a new one, and clearing that here would lose it
      // outright — its own disconnect would find no session to record (#916).
      // The companion maps need no cleanup: they were claimed at the top, so
      // anything under these keys now belongs to a later session.
      if (this.activeSessions.get(userId) === session) {
        this.activeSessions.delete(userId);
        this.userChannels.delete(userId);
      }

      if (debugModeEnabled) {
        logger.info(
          `[DEBUG] Saved voice session for user ${user.username} (${userId}) - Duration: ${duration}s, Other users: ${otherUsers.length}`,
        );
      }

      // Check for accolades and achievements after session ends
      try {
        const achievementsService = AchievementsService.getInstance(
          this.client,
        );
        const newAccolades = await achievementsService.checkAndAwardAccolades(
          userId,
          user.username,
        );

        if (newAccolades.length > 0) {
          // Send DM notification for accolades
          await achievementsService.notifyUserOfAccolades(userId, newAccolades);
          // Loud, server-wide shout-out for any marquee crossings (#657,
          // Part 2). Reuses this same detection point; gated/no-ops unless
          // celebrations are enabled and a channel is configured.
          await achievementsService.announceMilestones(
            userId,
            user.username,
            newAccolades,
          );
        }

        // Check for weekly achievements (these are NOT sent as DM notifications)
        await achievementsService.checkAndAwardAchievements(
          userId,
          user.username,
        );
      } catch (error: unknown) {
        logger.error("Error checking achievements/accolades:", error);
        // Don't let achievement errors break voice tracking
      }
    } catch (error: unknown) {
      logger.error("Error ending voice tracking:", error);
      // The session stays in `activeSessions` for the next disconnect to
      // retry, so its bookkeeping has to go back too — otherwise the retry
      // persists a session with no companions and no encountered users.
      this.returnClaimedState(userId, session, claimed);
    }
  }

  /**
   * Hand a failed persist's claimed bookkeeping back to the live maps.
   *
   * Only while the same session still owns the key: a rejoin that started
   * during the failed persist has its own, newer state under these keys and
   * must not be overwritten by a session that is already over. Each map is
   * restored only if nothing has been put there since, for the same reason.
   */
  private returnClaimedState(
    userId: string,
    session: VoiceSession | undefined,
    claimed: ClaimedSessionState | undefined,
  ): void {
    if (!session || !claimed) return;
    // Released either way: the session stays in `activeSessions` for the
    // next disconnect to retry, and a retry has to be allowed to run.
    session.persisting = false;
    if (this.activeSessions.get(userId) !== session) return;

    if (claimed.encountered && !this.encounteredUsers.has(userId)) {
      this.encounteredUsers.set(userId, claimed.encountered);
    }
    if (claimed.since && !this.companionSince.has(userId)) {
      this.companionSince.set(userId, claimed.since);
    }
    if (claimed.seconds && !this.companionSeconds.has(userId)) {
      this.companionSeconds.set(userId, claimed.seconds);
    }
    if (claimed.firsts && !this.sessionFirsts.has(userId)) {
      this.sessionFirsts.set(userId, claimed.firsts);
    }
  }

  public async getUserStats(
    userId: string,
    timePeriod: TimePeriod = "alltime",
  ): Promise<IUserStats | null> {
    try {
      const user = await VoiceChannelTracking.findOne({ userId });
      if (!user) return null;

      const now = new Date();
      let startDate: Date;
      let filteredSessions;
      let totalTime;

      switch (timePeriod) {
        case "week":
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          filteredSessions = user.sessions.filter(
            (session) => session.startTime >= startDate,
          );
          totalTime = filteredSessions.reduce(
            (total, session) => total + (session.duration || 0),
            0,
          );
          break;
        case "month":
          startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          filteredSessions = user.sessions.filter(
            (session) => session.startTime >= startDate,
          );
          totalTime = filteredSessions.reduce(
            (total, session) => total + (session.duration || 0),
            0,
          );
          break;
        case "alltime":
          return {
            userId: user.userId,
            username: user.username,
            totalTime: user.totalTime,
            lastSeen: user.lastSeen,
            sessions: user.sessions,
          };
      }

      return {
        userId: user.userId,
        username: user.username,
        totalTime: totalTime || 0,
        lastSeen: user.lastSeen,
        sessions: filteredSessions || [],
      };
    } catch (error) {
      logger.error("Error getting user stats:", error);
      return null;
    }
  }

  public async getTopUsers(
    limit: number = 10,
    timePeriod: TimePeriod = "alltime",
  ): Promise<IAggregatedUserStats[]> {
    try {
      const now = new Date();
      let startDate: Date;
      let users;

      // Server-side safety cap. A positive `limit` (e.g. the user-supplied
      // `/voicestats top` count) is clamped to the configurable maximum so a
      // single request can never materialise an unbounded result set. A
      // non-positive `limit` is the documented "all ranked users" sentinel
      // used by internal aggregation consumers (weekly digest fan-out,
      // leaderboard-role reconcile), which still receive every row.
      //
      // Both values are sanitised to a finite positive integer: `$limit` must
      // be an integer, and a fractional/NaN/Infinity config value would
      // otherwise produce an invalid stage or silently disable the cap.
      const rawMax = await this.configService.getNumber(
        "voicetracking.stats.leaderboard_max_results",
        50,
      );
      const maxResults =
        Number.isFinite(rawMax) && rawMax >= 1 ? Math.floor(rawMax) : 50;
      const requestedLimit = Number.isFinite(limit) ? Math.floor(limit) : 0;
      const effectiveLimit =
        requestedLimit > 0 ? Math.min(requestedLimit, maxResults) : 0;
      const limitStage = effectiveLimit > 0 ? [{ $limit: effectiveLimit }] : [];

      // Pre-filter on the multikey `sessions.startTime` index *before*
      // unwinding: `$match` ahead of `$unwind` can use the index and only
      // materialises users who have at least one session in the window,
      // whereas unwinding first flattened every session of every user in
      // memory on each call (#842). The second `$match` after `$unwind` is
      // still required to drop that user's out-of-window sessions.
      const windowedTotalsPipeline = (
        since: Date,
      ): mongoose.PipelineStage[] => [
        { $match: { "sessions.startTime": { $gte: since } } },
        { $unwind: "$sessions" },
        { $match: { "sessions.startTime": { $gte: since } } },
        {
          $group: {
            _id: "$userId",
            username: { $first: "$username" },
            totalTime: { $sum: "$sessions.duration" },
          },
        },
        { $sort: { totalTime: -1 } },
        ...limitStage,
      ];

      switch (timePeriod) {
        case "week":
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          users = await VoiceChannelTracking.aggregate(
            windowedTotalsPipeline(startDate),
          );
          break;
        case "month":
          startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          users = await VoiceChannelTracking.aggregate(
            windowedTotalsPipeline(startDate),
          );
          break;
        case "alltime":
          users = await VoiceChannelTracking.aggregate([
            {
              $group: {
                _id: "$userId",
                username: { $first: "$username" },
                totalTime: { $sum: "$totalTime" },
              },
            },
            { $sort: { totalTime: -1 } },
            ...limitStage,
          ]);
          break;
      }

      return users.map((user) => ({
        userId: user._id,
        username: user.username,
        totalTime: user.totalTime || 0,
      }));
    } catch (error) {
      logger.error("Error getting top users:", error);
      return [];
    }
  }

  public async getUserLastSeen(userId: string): Promise<Date | null> {
    try {
      const user = await VoiceChannelTracking.findOne({ userId });
      return user?.lastSeen || null;
    } catch (error) {
      logger.error("Error getting user last seen:", error);
      return null;
    }
  }

  private async handleButtonInteraction(
    interaction: ButtonInteraction,
  ): Promise<void> {
    try {
      if (!interaction.guild) {
        await interaction.reply({
          content: "This command can only be used in a server.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const channel = await this.client.channels.fetch(interaction.channelId);
      if (!channel || !(channel instanceof VoiceChannel)) {
        return;
      }

      const entries = Array.from(this.userChannels.entries());
      const foundEntry = entries.find(([, vc]) => vc.id === channel.id);
      const userId = foundEntry ? foundEntry[0] : null;

      if (!userId || userId !== interaction.user.id) {
        return;
      }

      let response;
      switch (interaction.customId) {
        case "rename":
          response = "Please enter the new name for your channel:";
          break;
        case "public":
          await channel.permissionOverwrites.edit(
            interaction.guild.roles.everyone,
            {
              ViewChannel: true,
              Connect: true,
            },
          );
          response = "Channel is now public.";
          break;
        case "private":
          await channel.permissionOverwrites.edit(
            interaction.guild.roles.everyone,
            {
              ViewChannel: false,
              Connect: false,
            },
          );
          response = "Channel is now private.";
          break;
        case "invite":
          response = "Please mention the user you want to invite:";
          break;
        case "kick":
          response = "Please mention the user you want to kick:";
          break;
        default:
          response = "Unknown action.";
      }

      await interaction.reply({
        content: response,
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      logger.error("Error handling button interaction:", error);
      await safeReply(interaction, {
        content: "An error occurred while processing your request.",
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  async initialize(): Promise<void> {
    try {
      await this.mongo.ensureConnection();
      logger.info("VoiceChannelTracker initialized");
    } catch (error) {
      logger.error("Error initializing VoiceChannelTracker:", error);
      throw error;
    }
  }
}
