import mongoose, { Schema, Document } from "mongoose";

/**
 * One row per poll message, recording how that poll did (#816).
 *
 * `PollItem` is the poll *template library* (`usageCount` / `lastUsed`) — it
 * says how often a question has been reused, not what happened when it ran.
 * `PollParticipationTracking` counts votes per member, which answers "how
 * many members voted this week" but not "across how many polls". This
 * collection closes that gap: it is the log of polls that actually ran, with
 * their turnout, so the weekly recap (#777) can state "N members voted across
 * M polls this week."
 *
 * Rows are written from two places, both gated on
 * `polls.participation.enabled`:
 *
 * - `PollService` upserts a row when it posts a scheduled poll, which is the
 *   only moment `question` and an exact `postedAt` are known.
 * - `PollParticipationTracker` upserts on every captured vote, so polls the
 *   bot did not post (a member's own poll, or one from before the schedule
 *   existed) still get a row and count toward turnout. This matches how the
 *   recap's member count is computed — it also counts votes on any guild
 *   poll — so the two halves of the sentence cover the same polls.
 *
 * Because either writer can create the row, the vote path fills fields in on
 * first sight rather than on insert: `firstVoteAt` is stamped by the first
 * vote even when the row already existed (a scheduled poll that had not been
 * voted on yet), and a `question` learned from a later cached vote fills a
 * row first seen through a partial message. Whatever is already stored wins.
 *
 * Distinct turnout needs to know *who* voted, so `voterIds` holds the set of
 * members seen voting on that poll; `votesCast` counts vote events, which is
 * higher on a multiselect poll where one member picks several answers. Vote
 * *removals* are not tracked (Discord's
 * `messagePollVoteRemove` would need its own bookkeeping to know whether a
 * member has any answers left), so a voter who later retracts still counts —
 * the same "votes cast" semantics the per-member counters already use.
 *
 * Retention: `PollParticipationTracker`'s daily pass deletes rows whose
 * `postedAt` is older than `polls.turnout.retention_days`, which also bounds
 * how long the per-poll voter ids are kept.
 */
export interface IPollTurnout extends Document {
  guildId: string;
  /** Discord message id of the poll — the natural per-poll key. */
  messageId: string;
  channelId: string | null;
  /** Poll question, when known (bot-posted polls, or a non-partial vote). */
  question: string | null;
  /** When the poll message was created (best effort for observed polls). */
  postedAt: Date;
  firstVoteAt: Date | null;
  lastVoteAt: Date | null;
  /** Vote events captured (a multiselect vote counts once per answer). */
  votesCast: number;
  /** Distinct members seen voting on this poll. */
  voterIds: string[];
}

const PollTurnoutSchema = new Schema({
  guildId: { type: String, required: true },
  messageId: { type: String, required: true },
  channelId: { type: String, default: null },
  question: { type: String, default: null },
  postedAt: { type: Date, required: true },
  firstVoteAt: { type: Date, default: null },
  lastVoteAt: { type: Date, default: null },
  votesCast: { type: Number, default: 0 },
  voterIds: { type: [String], default: [] },
});

// One row per poll message; the upsert paths key off this pair.
PollTurnoutSchema.index({ guildId: 1, messageId: 1 }, { unique: true });
// "Polls with turnout in this window" (the recap) and the retention sweep.
PollTurnoutSchema.index({ guildId: 1, lastVoteAt: -1 });
PollTurnoutSchema.index({ postedAt: 1 });

export const PollTurnout = mongoose.model<IPollTurnout>(
  "PollTurnout",
  PollTurnoutSchema,
);
