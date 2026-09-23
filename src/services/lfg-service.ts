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
  type ILfgPost,
  type LfgCloseReason,
} from "../models/lfg-post.js";
import {
  clampToLimit,
  DISCORD_EMBED_FIELD_VALUE_LIMIT,
} from "../utils/discord-limits.js";
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
 * re-rendered as closed. The hour is slack for a re-render that failed on
 * the tick that closed the post, so the next tick can retry before the row
 * goes away.
 */
const CLOSED_ROW_RETENTION_MS = 60 * MS_PER_MINUTE;

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
      return "Expired — nobody else joined in time.";
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
    const summary: LfgSweepSummary = { expired: 0, purged: 0 };

    const due = await LfgPost.find({
      state: "open",
      expiresAt: { $lte: now },
    });

    for (const post of due) {
      try {
        const closed = await this.closePost(String(post._id), "expired");
        if (!closed) continue;
        summary.expired += 1;
        await this.renderToMessage(closed);
      } catch (error) {
        logger.error(
          `Error expiring LFG post ${sanitizeForLog(String(post._id))}:`,
          error,
        );
      }
    }

    // Closed rows have done their job once the message shows as closed.
    const purge = await LfgPost.deleteMany({
      state: "closed",
      updatedAt: { $lte: new Date(now.getTime() - CLOSED_ROW_RETENTION_MS) },
    });
    summary.purged = purge.deletedCount ?? 0;

    return summary;
  }

  // ---------------------------------------------------------------
  // Public API (command + button handlers)
  // ---------------------------------------------------------------

  /**
   * Open a post: create the row, optionally attach a voice channel, and send
   * the embed. The row is saved before the message so the buttons can carry
   * its id; a send that fails takes the row with it rather than leaving a
   * post nobody can see or close.
   */
  public async createPost(input: CreateLfgInput): Promise<CreateLfgResult> {
    const channelId =
      (await this.configService.getString("lfg.channel_id", "")) ||
      input.fallbackChannelId;
    const channel = await this.fetchPostChannel(channelId);
    if (!channel) return { status: "no_channel" };

    const limit = await this.configService.getNumber(
      "lfg.max_active_per_user",
      1,
    );
    if (limit > 0) {
      const open = await LfgPost.countDocuments({
        guildId: input.guildId,
        hostId: input.hostId,
        state: "open",
      });
      if (open >= limit) return { status: "at_limit", limit };
    }

    const expiryMinutes = await this.configService.getNumber(
      "lfg.expiry_minutes",
      60,
    );
    const voiceChannelId = await this.resolveVoiceChannel(
      input.guildId,
      input.hostId,
      input.game,
    );

    const post = new LfgPost({
      guildId: input.guildId,
      hostId: input.hostId,
      game: input.game,
      note: input.note,
      partySize: input.partySize,
      memberIds: [input.hostId],
      channelId: channel.id,
      voiceChannelId,
      state: "open",
      expiresAt: new Date(
        Date.now() + Math.max(1, expiryMinutes) * MS_PER_MINUTE,
      ),
    });
    await post.save();

    try {
      const message = await channel.send(this.buildPayload(post));
      post.messageId = message.id;
      await post.save();
    } catch (error) {
      logger.error("Failed to post LFG embed; dropping the post:", error);
      await LfgPost.deleteOne({ _id: post._id }).catch(() => undefined);
      return { status: "post_failed" };
    }

    logger.info(
      `Opened LFG post ${sanitizeForLog(String(post._id))} for ${sanitizeForLog(input.game)}`,
    );
    return { status: "created", post };
  }

  /**
   * Add a member to the roster.
   *
   * The push runs server-side as a single `findOneAndUpdate` whose filter
   * carries every precondition — still open, not already on the roster, and
   * not yet full. A fetch/modify/save would let two clicks in the same tick
   * both see a free slot and overflow the party (the lost-update defence
   * `EventService.setRsvp` exists for). A miss is re-read afterwards purely
   * to tell the member *why* they didn't get in.
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
        memberIds: { $ne: userId },
        $expr: { $lt: [{ $size: "$memberIds" }, "$partySize"] },
      },
      { $push: { memberIds: userId } },
      { new: true },
    );

    if (!joined) {
      const current = await LfgPost.findById(postId);
      if (!current || current.state !== "open") return { status: "closed" };
      if (current.memberIds.includes(userId)) {
        return { status: "already_joined", post: current };
      }
      return { status: "full", post: current };
    }

    if (!isPartyFull(joined)) {
      return { status: "joined", post: joined, filled: false };
    }

    // The join that completes the party closes it: nobody should be able to
    // click Join on a party that has everyone it asked for.
    const closed = await this.closePost(postId, "full");
    return { status: "joined", post: closed ?? joined, filled: true };
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
        hostId: { $ne: userId },
        memberIds: userId,
      },
      { $pull: { memberIds: userId } },
      { new: true },
    );
    if (left) return { status: "left", post: left };

    const current = await LfgPost.findById(postId);
    if (!current || current.state !== "open") return { status: "closed" };
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
      { $set: { state: "closed", closeReason: reason } },
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

  /** Re-render a post's message in place. Used by the sweep. */
  public async renderToMessage(post: ILfgPost): Promise<void> {
    if (!post.messageId) return;
    const channel = await this.fetchPostChannel(post.channelId);
    if (!channel) return;
    try {
      const message = await channel.messages.fetch(post.messageId);
      await message.edit(this.buildPayload(post));
    } catch (error) {
      if (
        error instanceof DiscordAPIError &&
        error.code === DISCORD_UNKNOWN_MESSAGE
      ) {
        logger.warn(
          `LFG message ${sanitizeForLog(post.messageId)} is gone; skipping edit`,
        );
        return;
      }
      logger.error("Failed to update LFG post:", error);
    }
  }

  // ---------------------------------------------------------------
  // Plumbing
  // ---------------------------------------------------------------

  /**
   * The voice channel to advertise, if any.
   *
   * Reuses the host's existing dynamic channel when they already own one —
   * `createDynamicChannel` tracks one channel per owner, so creating a second
   * would drop the first out of the ownership map. Creation is gated on
   * `voicechannels.enabled` as well as `lfg.voice_channel.enabled`: with
   * voice management off nothing would ever sweep the channel away again.
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
      const manager = VoiceChannelManager.getInstance(this.client);
      const existing = manager.getUserChannel(hostId);
      if (existing) return existing.id;

      const guild = await this.client.guilds.fetch(guildId).catch(() => null);
      if (!guild) return null;

      const prefix = await this.configService.getString(
        "voicechannels.channel.prefix",
        "🎮",
      );
      const name = `${prefix} ${game}`.trim().slice(0, 100);
      const created = await manager.createDynamicChannel(guild, hostId, name);
      return created?.id ?? null;
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
