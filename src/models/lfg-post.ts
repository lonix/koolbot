import mongoose, { Schema, Document } from "mongoose";

/**
 * An ad-hoc "looking for group" post (#957).
 *
 * A member runs `/lfg` when they want to play *right now* and need a few
 * more people. KoolBot posts an embed with a live roster and Join / Leave /
 * Close buttons, and closes the post once the party fills up, the host
 * closes it, or it ages past `lfg.expiry_minutes`.
 *
 * Unlike an `Event`, an LFG post owns no channel lifecycle of its own. When
 * a voice channel is attached it is a plain dynamic channel created through
 * `VoiceChannelManager.createDynamicChannel`, so the existing ownership
 * tracking and empty-channel sweep clean it up — `voiceChannelId` here is a
 * reference for the embed, never a thing this feature deletes.
 *
 * The row is deliberately short-lived: a post lives at most
 * `lfg.expiry_minutes`, and it is removed an hour after that either by
 * `LfgService`'s sweep or, if the feature has since been switched off and the
 * sweep with it, by the TTL index below. It is persisted rather than held in
 * memory so the buttons keep working across a restart and so a post opened
 * before a restart still gets closed afterwards — the same "the row is the
 * source of truth" reasoning as the events feature.
 */

/**
 * How long a row outlives the post's expiry instant.
 *
 * Also the sweep's grace for a closed row, so the two agree: the slack exists
 * so a close whose message edit failed can be retried on a later tick before
 * the row goes away.
 */
export const LFG_ROW_TTL_SECONDS = 60 * 60;

/** Lifecycle states. `open → closed`; `closed` is terminal. */
export type LfgState = "open" | "closed";

/** Why a post closed, for the closed embed's wording. */
export type LfgCloseReason = "expired" | "full" | "cancelled";

export interface ILfgPost extends Document {
  guildId: string;
  /** The member who opened the post. Always also in `memberIds`. */
  hostId: string;
  /** What they want to play, as typed. */
  game: string;
  /** Optional free-text note ("mic required", "ranked only"). */
  note: string;
  /** How many people the party wants in total, host included. */
  partySize: number;
  /** Current roster, host first. Closing at `partySize` is enforced on join. */
  memberIds: string[];
  /** Text channel the post was sent to. */
  channelId: string;
  /** The post itself, once sent; null only if the send failed. */
  messageId: string | null;
  /** Dynamic voice channel attached to the post, if one was created. */
  voiceChannelId: string | null;
  state: LfgState;
  closeReason: LfgCloseReason | null;
  /**
   * Whether the closed post's message has been re-rendered as closed.
   *
   * Without it a swallowed edit failure would strand a post that still looks
   * open — the sweep only ever selects open rows, so nothing would try again.
   * The sweep retries any closed row still marked false, and only purges rows
   * it has confirmed rendered.
   */
  closeRendered: boolean;
  /** When the sweep should close the post if it is still open. */
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const LfgPostSchema = new Schema<ILfgPost>(
  {
    guildId: { type: String, required: true },
    hostId: { type: String, required: true },
    game: { type: String, required: true, maxlength: 100 },
    note: { type: String, default: "", maxlength: 500 },
    partySize: { type: Number, required: true },
    memberIds: { type: [String], default: [] },
    channelId: { type: String, required: true },
    messageId: { type: String, default: null },
    voiceChannelId: { type: String, default: null },
    state: {
      type: String,
      required: true,
      enum: ["open", "closed"],
      default: "open",
    },
    closeReason: {
      type: String,
      enum: ["expired", "full", "cancelled", null],
      default: null,
    },
    closeRendered: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true },
  },
  {
    timestamps: true,
  },
);

// Every query this feature makes is served by one of these two compound
// indexes, so neither `guildId` nor `state` carries a single-field index of
// its own: the sweep asks "which open posts are due?" (and later "which
// closed rows have aged out?") once a minute, and the per-host cap counts a
// member's open posts on every /lfg.
LfgPostSchema.index({ state: 1, expiresAt: 1 });
LfgPostSchema.index({ guildId: 1, hostId: 1, state: 1 });

// Backstop for the sweep, which only runs while `lfg.enabled` is on: turning
// the feature off mid-post would otherwise leave that post's host and roster
// ids sitting in the database indefinitely. Mongo removes the row an hour
// after the post was due to expire whatever the feature gate says, which is
// what lets the per-user data registry classify these ids as `expires`.
//
// The window is deliberately the same hour the sweep waits, which means a bot
// that stays down for more than an hour past a post's expiry can have the row
// removed before the sweep ever re-renders the message as closed. That costs a
// post whose embed still reads as open — its buttons answer "no longer open"
// either way — and the alternative, holding roster ids longer to tidy an
// embed, is the worse trade.
LfgPostSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: LFG_ROW_TTL_SECONDS },
);

export const LfgPost = mongoose.model<ILfgPost>("LfgPost", LfgPostSchema);
