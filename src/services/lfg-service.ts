import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  DiscordAPIError,
  EmbedBuilder,
  type GuildTextBasedChannel,
} from "discord.js";
import { isValidObjectId } from "mongoose";
import { ScheduledService } from "./scheduled-service.js";
import { VoiceChannelManager } from "./voice-channel-manager.js";
import {
  LfgPost,
  LFG_ROW_TTL_SECONDS,
  type ILfgPost,
  type LfgCloseReason,
} from "../models/lfg-post.js";
import {
  clampToLimit,
  DISCORD_EMBED_FIELD_VALUE_LIMIT,
} from "../utils/discord-limits.js";
import { createKeyedLock } from "../utils/keyed-lock.js";
import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";

/**
 * Ad-hoc "looking for group" posts (#957).
 *
 * The immediate counterpart to the Events feature: `/event` schedules a
 * gathering for later, `/lfg` says "I'm playing now, who's in?". A post is a
 * single embed with a live roster and Join / Leave / Close buttons, and it
 * closes as soon as the party fills, the host closes it, or it ages past
 * `lfg.expiry_minutes`.
 *
 * Two deliberate non-features, both because the infrastructure already
 * exists:
 *
 * - **No channel lifecycle.** An attached voice channel is a plain dynamic
 *   channel created through `VoiceChannelManager.createDynamicChannel`, so
 *   its ownership tracking and empty-channel sweep own the cleanup. Closing
 *   an LFG post never deletes a channel — members may still be in it.
 * - **No per-post timer.** Expiry is decided by a once-a-minute scan from the
 *   stored `expiresAt`, mirroring `EventService`, so it is idempotent and a
 *   restart loses nothing.
 */

const TICK_CRON = "* * * * *"; // every minute
const MS_PER_MINUTE = 60 * 1000;
const DISCORD_UNKNOWN_MESSAGE = 10008;

/**
 * How long a closed post's row is kept before the sweep deletes it.
 *
 * Not a retention setting: the row has no value once its message has been
 * re-rendered as closed. The slack is there so a re-render that failed on the
 * tick that closed the post can be retried before the row goes away. Shared
 * with the model's TTL index, which enforces the same window from the
 * database side when the feature (and therefore this sweep) is switched off.
 */
const CLOSED_ROW_RETENTION_MS = LFG_ROW_TTL_SECONDS * 1000;

/**
 * Most posts one sweep will close, and likewise the most it will retry.
 *
 * Renders are serial, so an unbounded query after an outage could hold
 * thousands of rows in memory and run for many minutes — and because ticks
 * coalesce, newly due posts would not even be queried until that backlog
 * drained. A bounded, oldest-first batch keeps each tick short; the rest is
 * picked up by the next one. Mirrors `ReminderService`'s `SCAN_BATCH_SIZE`,
 * which exists for exactly this reason.
 */
const SCAN_BATCH_SIZE = 100;

/**
 * Serialises voice-channel resolution per host.
 *
 * `VoiceChannelManager` tracks one dynamic channel per owner, and the check
 * for an existing one is not atomic with creating a new one. Where
 * `lfg.max_active_per_user` allows a second post, two `/lfg` runs by the same
 * member could both look while the other was still awaiting Discord, and each
 * make a room — leaving one empty, pointed at by a live post, for the
 * empty-channel sweep to delete out from under it. Taking turns per host is
 * enough: the second run then sees the room the first one made.
 */
const voiceResolution = createKeyedLock();

/** Smallest party worth advertising: the host plus one. */
export const MIN_PARTY_SIZE = 2;
/** Roster mentions have to stay inside one embed field. */
export const MAX_PARTY_SIZE = 25;

const COLOR_OPEN = 0x5865f2; // blurple
const COLOR_CLOSED = 0x99aab5; // grey

export interface CreateLfgInput {
  guildId: string;
  hostId: string;
  game: string;
  note: string;
  partySize: number;
  /** Channel to post in when `lfg.channel_id` is unset. */
  fallbackChannelId: string;
}

export type CreateLfgResult =
  | { status: "created"; post: ILfgPost }
  | { status: "at_limit"; limit: number }
  | { status: "no_channel" }
  | { status: "post_failed" };

export type JoinLfgResult =
  | { status: "joined"; post: ILfgPost; filled: boolean }
  | { status: "already_joined"; post: ILfgPost }
  | { status: "full"; post: ILfgPost }
  | { status: "closed" };

export type LeaveLfgResult =
  | { status: "left"; post: ILfgPost }
  | { status: "host"; post: ILfgPost }
  | { status: "not_joined"; post: ILfgPost }
  | { status: "closed" };

export type CloseLfgResult =
  | { status: "closed"; post: ILfgPost }
  | { status: "not_host" }
  | { status: "closed_already" };

/** What one sweep did, for the logs and the tests. */
export interface LfgSweepSummary {
  /** Open posts whose expiry had passed. */
  expired: number;
  /** Closed posts whose message was re-rendered on a later attempt. */
  retried: number;
  /** Closed rows aged out of the database. */
  purged: number;
}

// ---------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------

/**
 * Clamp a requested party size into the range the embed can render, falling
 * back to the configured default when the member didn't ask for one.
 */
export function resolvePartySize(
  requested: number | null | undefined,
  configuredDefault: number,
): number {
  const raw =
    requested ?? (Number.isFinite(configuredDefault) ? configuredDefault : 4);
  const rounded = Math.round(raw);
  if (!Number.isFinite(rounded)) return MIN_PARTY_SIZE;
  return Math.min(MAX_PARTY_SIZE, Math.max(MIN_PARTY_SIZE, rounded));
}

/**
 * Whether a post is open *and* has not run past its advertised closing time.
 *
 * The sweep closes an expired post within a minute, but a click landing in
 * that minute — or any time after, if the feature was switched off and the
 * sweep with it — must not be accepted: the post says when it closes, and a
 * late join could otherwise close it as `full` when it had already expired.
 * Every interactive mutation therefore carries the same condition in its
 * filter, and this is what the re-read uses to explain the miss.
 */
export function isStillOpen(
  post: { state: string; expiresAt: Date },
  now: Date = new Date(),
): boolean {
  return post.state === "open" && post.expiresAt.getTime() > now.getTime();
}

/** Whether the roster has reached the requested party size. */
export function isPartyFull(post: {
  memberIds: string[];
  partySize: number;
}): boolean {
  return post.memberIds.length >= post.partySize;
}

/** How many more people the post is still looking for. */
export function spotsLeft(post: {
  memberIds: string[];
  partySize: number;
}): number {
  return Math.max(0, post.partySize - post.memberIds.length);
}

/** The line under the title of a closed post. */
export function closedSummary(reason: LfgCloseReason | null): string {
  switch (reason) {
    case "full":
      return "Party filled up.";
    case "cancelled":
      return "Closed by the host.";
    case "expired":
      return "Expired before the party filled.";
    default:
      return "Closed.";
  }
}

/** Roster as mentions, clamped to one embed field. */
export function formatRoster(memberIds: readonly string[]): string {
  if (memberIds.length === 0) return "_nobody yet_";
  return clampToLimit(
    memberIds.map((id) => `<@${id}>`),
    DISCORD_EMBED_FIELD_VALUE_LIMIT,
    { separator: " · " },
  );
}

export class LfgService extends ScheduledService<LfgSweepSummary> {
  private static instance: LfgService;

  private constructor(client: Client) {
    super(client, {
      label: "LFG service",
      disabledMessage: "LFG posts are disabled",
      cronContext: "lfg",
      runLabel: "LFG sweep",
    });
  }

  protected async isEnabled(): Promise<boolean> {
    return this.configService.getBoolean("lfg.enabled", false);
  }

  /** Posts expire on a fixed tick rather than an admin-set schedule. */
  protected async resolveSchedule(): Promise<string> {
    return TICK_CRON;
  }

  public static getInstance(client: Client): LfgService {
    if (!LfgService.instance) {
      LfgService.instance = new LfgService(client);
    } else if (LfgService.instance.client !== client) {
      throw new Error("LfgService already initialised with a different client");
    }
    return LfgService.instance;
  }

  public static reset(): void {
    if (LfgService.instance) {
      LfgService.instance.destroy();
    }
    LfgService.instance = undefined as unknown as LfgService;
  }

  // ---------------------------------------------------------------
  // Sweep
  // ---------------------------------------------------------------

  protected async runOnce(): Promise<LfgSweepSummary> {
    const now = new Date();
    const summary: LfgSweepSummary = { expired: 0, purged: 0, retried: 0 };

    const due = await LfgPost.find({
      state: "open",
      expiresAt: { $lte: now },
    })
      .sort({ expiresAt: 1 })
      .limit(SCAN_BATCH_SIZE);

    for (const post of due) {
      try {
        const closed = await this.closePost(String(post._id), "expired");
        if (!closed) continue;
        summary.expired += 1;
        await this.renderAndSettle(closed);
      } catch (error) {
        logger.error(
          `Error expiring LFG post ${sanitizeForLog(String(post._id))}:`,
          error,
        );
      }
    }

    // Any post whose message is known to disagree with its row: a close whose
    // edit failed, a restart between the two, or a click whose edit failed on
    // a post that is still open. Nothing else would ever look at these again —
    // every other query here is on the expiry path — so retry until the
    // message agrees with the row.
    //
    // Ordered by when each was last attempted (never-attempted rows sort
    // first, since a missing field sorts before any value), so a row that
    // keeps failing rotates to the back of the batch rather than occupying it
    // and starving every newer post behind it.
    const pending = await LfgPost.find({ renderPending: true })
      .sort({ lastRenderAttemptAt: 1 })
      .limit(SCAN_BATCH_SIZE);
    for (const post of pending) {
      try {
        if (await this.renderAndSettle(post)) summary.retried += 1;
      } catch (error) {
        logger.error(
          `Error re-rendering LFG post ${sanitizeForLog(String(post._id))}:`,
          error,
        );
      }
    }

    // Only rows whose message has been confirmed closed are dropped: purging
    // a pending one would strand a post that still looks open forever.
    const purge = await LfgPost.deleteMany({
      state: "closed",
      renderPending: false,
      updatedAt: { $lte: new Date(now.getTime() - CLOSED_ROW_RETENTION_MS) },
    });
    summary.purged = purge.deletedCount ?? 0;

    return summary;
  }

  // ---------------------------------------------------------------
  // Public API (command + button handlers)
  // ---------------------------------------------------------------

  /**
   * Open a post: reserve the row, claim the host's slot, optionally attach a
   * voice channel, and send the embed.
   *
   * The order matters. The row is saved first so the buttons can carry its
   * id and so the per-host cap can be settled against rows that already
   * exist; the voice channel is only created once the post is known to be
   * keeping its slot, so a refused `/lfg` can't leave a channel behind; and
   * the message goes last, because a send that fails takes the row with it
   * rather than leaving a post nobody can see or close.
   */
  public async createPost(input: CreateLfgInput): Promise<CreateLfgResult> {
    const channelId =
      (await this.configService.getString("lfg.channel_id", "")) ||
      input.fallbackChannelId;
    const channel = await this.fetchPostChannel(channelId);
    if (!channel) return { status: "no_channel" };

    const expiryMinutes = await this.configService.getNumber(
      "lfg.expiry_minutes",
      60,
    );
    const post = new LfgPost({
      guildId: input.guildId,
      hostId: input.hostId,
      game: input.game,
      note: input.note,
      partySize: input.partySize,
      memberIds: [input.hostId],
      channelId: channel.id,
      voiceChannelId: null,
      state: "open",
      expiresAt: new Date(
        Date.now() + Math.max(1, expiryMinutes) * MS_PER_MINUTE,
      ),
    });
    await post.save();

    if (!(await this.claimHostSlot(post))) {
      await LfgPost.deleteOne({ _id: post._id }).catch(() => undefined);
      return {
        status: "at_limit",
        limit: await this.configService.getNumber("lfg.max_active_per_user", 1),
      };
    }

    const voiceChannelId = await voiceResolution.run(input.hostId, () =>
      this.resolveVoiceChannel(input.guildId, input.hostId, input.game),
    );
    if (voiceChannelId) post.voiceChannelId = voiceChannelId;

    let message;
    try {
      message = await channel.send(this.buildPayload(post));
    } catch (error) {
      logger.error("Failed to post LFG embed; dropping the post:", error);
      await LfgPost.deleteOne({ _id: post._id }).catch(() => undefined);
      return { status: "post_failed" };
    }

    post.messageId = message.id;
    try {
      await post.save();
    } catch (error) {
      // The message is already out. Dropping the row on its own would leave
      // a post that looks live but can never be joined, closed or expired —
      // nothing would reference it again — so take the message down first and
      // only then release the row.
      logger.error(
        "Failed to record the LFG message id; removing the post again:",
        error,
      );
      await message.delete().catch((deleteError) => {
        logger.error(
          "Failed to remove the orphaned LFG message; it will have to be deleted by hand:",
          deleteError,
        );
      });
      await LfgPost.deleteOne({ _id: post._id }).catch(() => undefined);
      return { status: "post_failed" };
    }

    logger.info(
      `Opened LFG post ${sanitizeForLog(String(post._id))} for ${sanitizeForLog(input.game)}`,
    );
    return { status: "created", post };
  }

  /**
   * Add a member to the roster, closing the post in the same write if that
   * fills the party.
   *
   * Everything runs server-side as a single `findOneAndUpdate`: the filter
   * carries every precondition (still open, not already on the roster, not
   * yet full) and the pipeline appends the member and then conditionally
   * flips `state`/`closeReason` from the *post-append* roster. A
   * fetch/modify/save would let two clicks in the same tick both see the last
   * free slot (the lost-update defence `EventService.setRsvp` exists for),
   * and appending in one write then closing in another would let a Leave
   * land between them and close a post as `full` with an underfilled roster.
   * A miss is re-read afterwards purely to tell the member *why* they didn't
   * get in.
   */
  public async joinPost(
    postId: string,
    userId: string,
  ): Promise<JoinLfgResult> {
    if (!isValidObjectId(postId)) return { status: "closed" };

    const joined = await LfgPost.findOneAndUpdate(
      {
        _id: postId,
        state: "open",
        expiresAt: { $gt: new Date() },
        memberIds: { $ne: userId },
        $expr: { $lt: [{ $size: "$memberIds" }, "$partySize"] },
      },
      [
        { $set: { memberIds: { $concatArrays: ["$memberIds", [userId]] } } },
        {
          $set: {
            state: {
              $cond: [
                { $gte: [{ $size: "$memberIds" }, "$partySize"] },
                "closed",
                "$state",
              ],
            },
            closeReason: {
              $cond: [
                { $gte: [{ $size: "$memberIds" }, "$partySize"] },
                "full",
                "$closeReason",
              ],
            },
          },
        },
      ],
      { new: true },
    );

    if (!joined) {
      const current = await LfgPost.findById(postId);
      if (!current || !isStillOpen(current)) return { status: "closed" };
      if (current.memberIds.includes(userId)) {
        return { status: "already_joined", post: current };
      }
      return { status: "full", post: current };
    }

    return {
      status: "joined",
      post: joined,
      filled: joined.state === "closed",
    };
  }

  /**
   * Drop a member from the roster. The host cannot leave their own post —
   * leaving would strand a roster with no owner, so they close it instead.
   */
  public async leavePost(
    postId: string,
    userId: string,
  ): Promise<LeaveLfgResult> {
    if (!isValidObjectId(postId)) return { status: "closed" };

    const left = await LfgPost.findOneAndUpdate(
      {
        _id: postId,
        state: "open",
        expiresAt: { $gt: new Date() },
        hostId: { $ne: userId },
        memberIds: userId,
      },
      { $pull: { memberIds: userId } },
      { new: true },
    );
    if (left) return { status: "left", post: left };

    const current = await LfgPost.findById(postId);
    if (!current || !isStillOpen(current)) return { status: "closed" };
    if (current.hostId === userId) return { status: "host", post: current };
    return { status: "not_joined", post: current };
  }

  /** Close a post on the host's request, rejecting anyone else. */
  public async closeByHost(
    postId: string,
    userId: string,
  ): Promise<CloseLfgResult> {
    if (!isValidObjectId(postId)) return { status: "closed_already" };

    const closed = await this.closePost(postId, "cancelled", userId);
    if (closed) return { status: "closed", post: closed };

    const current = await LfgPost.findById(postId);
    if (current && current.state === "open" && current.hostId !== userId) {
      return { status: "not_host" };
    }
    return { status: "closed_already" };
  }

  public async getPost(postId: string): Promise<ILfgPost | null> {
    if (!isValidObjectId(postId)) return null;
    return LfgPost.findById(postId).catch(() => null);
  }

  /**
   * Decide whether a freshly saved post keeps its slot under
   * `lfg.max_active_per_user`.
   *
   * Counting before inserting would let two `/lfg` runs in the same instant
   * both see a count below the cap and both post. Counting *after* the
   * insert, over the member's older open rows only, cannot — and the reason
   * is worth writing down, because it looks racy and is not.
   *
   * Each caller awaits its own insert before it counts, and reads go to the
   * primary (the connection sets no read preference), so a caller's own row
   * is committed before its count runs. For two callers to both accept, each
   * would have to count before the other's insert committed:
   *
   *     A.insert < A.count < B.insert < B.count < A.insert
   *
   * which is a cycle, so at most one can accept. ObjectId monotonicity then
   * decides *which*: the later one sees the earlier as older and stands down.
   * Pointing the connection at a secondary would break the first premise.
   *
   * A cap of 0 (or less) means no cap and skips the query entirely.
   */
  private async claimHostSlot(post: ILfgPost): Promise<boolean> {
    const limit = await this.configService.getNumber(
      "lfg.max_active_per_user",
      1,
    );
    if (limit <= 0) return true;

    const older = await LfgPost.countDocuments({
      guildId: post.guildId,
      hostId: post.hostId,
      state: "open",
      // Same condition the interactive writes use: a post that has run past
      // its closing time accepts nobody, so it must not hold a slot either.
      // Without this a member is locked out of /lfg for up to a minute after
      // their own post died, waiting on the sweep to relabel it.
      expiresAt: { $gt: new Date() },
      _id: { $lt: post._id },
    });
    return older < limit;
  }

  /**
   * Flip a post to `closed`.
   *
   * The `state: "open"` filter makes this a compare-and-set, so concurrent
   * closers (the sweep and a Close click, say) cannot both report having
   * closed the post — only the caller whose write landed gets the row back.
   * Passing `hostId` narrows the same write to the owner.
   *
   * Deliberately does not re-render the message: a button handler renders by
   * acknowledging its own interaction, and a second edit from here would be
   * a wasted API call. The sweep renders explicitly.
   */
  private async closePost(
    postId: string,
    reason: LfgCloseReason,
    hostId?: string,
  ): Promise<ILfgPost | null> {
    const filter: Record<string, unknown> = { _id: postId, state: "open" };
    if (hostId) filter.hostId = hostId;
    return LfgPost.findOneAndUpdate(
      filter,
      // The embed still reads as open until something re-renders it, so the
      // close itself records that the message is out of date.
      { $set: { state: "closed", closeReason: reason, renderPending: true } },
      { new: true },
    );
  }

  // ---------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------

  /**
   * Build the post's embed + buttons. Synchronous so a button handler can
   * refresh the message inside a single `interaction.update`.
   */
  public buildPayload(post: ILfgPost): {
    embeds: EmbedBuilder[];
    components: ActionRowBuilder<ButtonBuilder>[];
  } {
    const closed = post.state === "closed";
    const embed = new EmbedBuilder()
      .setColor(closed ? COLOR_CLOSED : COLOR_OPEN)
      .setTitle(closed ? `🎮 ${post.game} (closed)` : `🎮 LFG — ${post.game}`)
      .addFields(
        { name: "Host", value: `<@${post.hostId}>`, inline: true },
        {
          name: "Party",
          value: `${post.memberIds.length}/${post.partySize}`,
          inline: true,
        },
        { name: "Roster", value: formatRoster(post.memberIds), inline: false },
      );

    if (post.note) embed.setDescription(post.note);
    if (post.voiceChannelId && !closed) {
      embed.addFields({
        name: "Voice channel",
        value: `<#${post.voiceChannelId}>`,
        inline: false,
      });
    }
    if (closed) {
      embed.setFooter({ text: closedSummary(post.closeReason) });
    } else {
      // A Discord relative timestamp keeps counting down without an edit,
      // so the post stays honest between sweeps.
      embed.addFields({
        name: "Closes",
        value: `<t:${Math.floor(post.expiresAt.getTime() / 1000)}:R>`,
        inline: false,
      });
    }

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`lfg_join_${post._id}`)
        .setLabel("Join")
        .setEmoji("✅")
        .setStyle(ButtonStyle.Success)
        .setDisabled(closed),
      new ButtonBuilder()
        .setCustomId(`lfg_leave_${post._id}`)
        .setLabel("Leave")
        .setEmoji("🚪")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(closed),
      new ButtonBuilder()
        .setCustomId(`lfg_close_${post._id}`)
        .setLabel("Close")
        .setEmoji("🔒")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(closed),
    );

    return { embeds: [embed], components: [row] };
  }

  /**
   * Re-render a post's message in place, reporting whether the message now
   * agrees with the row. Used by the sweep.
   *
   * A message that has been deleted counts as rendered: there is nothing
   * stale left on screen, so retrying forever would be pointless.
   */
  public async renderToMessage(post: ILfgPost): Promise<boolean> {
    if (!post.messageId) return true;
    const channel = await this.fetchPostChannel(post.channelId);
    if (!channel) return false;
    try {
      const message = await channel.messages.fetch(post.messageId);
      await message.edit(this.buildPayload(post));
      return true;
    } catch (error) {
      if (
        error instanceof DiscordAPIError &&
        error.code === DISCORD_UNKNOWN_MESSAGE
      ) {
        logger.warn(
          `LFG message ${sanitizeForLog(post.messageId)} is gone; skipping edit`,
        );
        return true;
      }
      logger.error("Failed to update LFG post:", error);
      return false;
    }
  }

  /**
   * Re-render a post and record the outcome: cleared when the message now
   * agrees with the row, and either way stamped with the attempt so a row
   * that keeps failing cannot hold the front of the retry batch.
   */
  private async renderAndSettle(post: ILfgPost): Promise<boolean> {
    const rendered = await this.renderToMessage(post);
    await this.recordRenderAttempt(String(post._id), rendered);
    return rendered;
  }

  /**
   * Record a render attempt: stamp it, and clear the pending flag if the
   * message now matches.
   *
   * Public because the button handlers render by acknowledging their own
   * interaction rather than through `renderToMessage`, so only they know how
   * their edit went. They call this only when there is something to change —
   * a post they just closed, or one carrying a previous failure — so an
   * ordinary click still costs one write, not two.
   */
  public async recordRenderAttempt(
    postId: string,
    rendered: boolean,
  ): Promise<void> {
    if (!isValidObjectId(postId)) return;
    const update: Record<string, unknown> = { lastRenderAttemptAt: new Date() };
    if (rendered) update.renderPending = false;
    await LfgPost.updateOne({ _id: postId }, { $set: update }).catch((error) =>
      logger.error("Failed to record an LFG render attempt:", error),
    );
  }

  /**
   * Flag a post's message as out of date, for the sweep to re-render.
   *
   * The button handlers call this when their own edit failed: the write is
   * already committed, so without it the visible roster would disagree with
   * the row until someone else clicked or the post closed.
   */
  public async markRenderPending(postId: string): Promise<void> {
    if (!isValidObjectId(postId)) return;
    await LfgPost.updateOne(
      { _id: postId },
      { $set: { renderPending: true, lastRenderAttemptAt: new Date() } },
    ).catch((error) =>
      logger.error("Failed to flag an LFG post for re-rendering:", error),
    );
  }

  // ---------------------------------------------------------------
  // Plumbing
  // ---------------------------------------------------------------

  /**
   * The voice channel to advertise, if any.
   *
   * A channel is only attached when the host is **in voice right now**, and
   * a newly created one has the host moved into it immediately. That is not a
   * nicety: `VoiceChannelManager.cleanupEmptyChannels` deletes every empty
   * managed channel on its five-minute sweep, so a channel created for a host
   * who is not there to occupy it would be gone — and the post left pointing
   * at a dead channel — within minutes. The lobby path has the same
   * constraint and solves it the same way (`handleLobbyJoin` moves the member
   * into the channel it just made).
   *
   * A host who already owns a dynamic channel gets that one, and only while
   * they are sitting in it: `createDynamicChannel` tracks one channel per
   * owner, so making a second would drop the first out of the ownership map.
   *
   * Creation is gated on `voicechannels.enabled` as well as
   * `lfg.voice_channel.enabled` — with voice management off nothing would
   * ever sweep the channel away again.
   */
  private async resolveVoiceChannel(
    guildId: string,
    hostId: string,
    game: string,
  ): Promise<string | null> {
    if (
      !(await this.configService.getBoolean("lfg.voice_channel.enabled", true))
    ) {
      return null;
    }
    if (
      !(await this.configService.getBoolean("voicechannels.enabled", false))
    ) {
      logger.debug(
        "LFG: voice channel management is disabled — posting without a channel",
      );
      return null;
    }

    try {
      const guild = await this.client.guilds.fetch(guildId).catch(() => null);
      if (!guild) return null;
      const host = await guild.members.fetch(hostId).catch(() => null);
      if (!host?.voice.channelId) {
        logger.debug(
          "LFG: host is not in a voice channel — posting without one",
        );
        return null;
      }

      const manager = VoiceChannelManager.getInstance(this.client);
      const owned = manager.getUserChannel(hostId);
      if (owned) {
        // Their own room, but only while they are in it — an empty one is
        // the next sweep's to delete, whoever made it.
        return host.voice.channelId === owned.id ? owned.id : null;
      }

      const prefix = await this.configService.getString(
        "voicechannels.channel.prefix",
        "🎮",
      );
      const name = `${prefix} ${game}`.trim().slice(0, 100);
      const created = await manager.createDynamicChannel(guild, hostId, name);
      if (!created) return null;

      try {
        await host.voice.setChannel(created.id);
      } catch (error) {
        // Nobody is in it and nobody is going to be, so it is already the
        // sweep's. Don't advertise a channel that is about to disappear.
        logger.error(
          "LFG: could not move the host into their new voice channel:",
          error,
        );
        return null;
      }
      return created.id;
    } catch (error) {
      logger.error("LFG: failed to attach a voice channel:", error);
      return null;
    }
  }

  private async fetchPostChannel(
    channelId: string,
  ): Promise<GuildTextBasedChannel | null> {
    if (!channelId) return null;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || channel.isDMBased()) {
        logger.warn(
          `LFG channel ${sanitizeForLog(channelId)} is not a guild text channel`,
        );
        return null;
      }
      return channel;
    } catch (error) {
      logger.error("LFG: failed to fetch the post channel:", error);
      return null;
    }
  }
}
