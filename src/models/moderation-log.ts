import mongoose, { Document, Schema } from "mongoose";

/**
 * Moderation-log entry (issue #728). One append-only row per moderation
 * action taken against a member, keyed by the target user so a moderator can
 * ask "what's this person's history?" without scrolling Discord's native
 * audit log (which only retains ~45 days and has no per-user warn concept).
 *
 * Two write paths feed the same collection:
 *   - `warn` rows are KoolBot's own record, written by the `/warn` command —
 *     Discord has no native warning action, so this is the only place a warn
 *     exists.
 *   - every other action (`kick` / `ban` / `unban` / `timeout` / `untimeout`)
 *     is mirrored from a `GuildAuditLogEntryCreate` gateway event, so actions
 *     taken through Discord's native UI or another bot still land in one
 *     place. `source` records which path produced the row.
 *
 * Deliberately kept simple: an append-only history whose rows are never
 * edited, with no appeals or expiry of its own. Lifecycle state (a review
 * date and the outcome staff record when it comes due, issue #908) lives in
 * `moderation-case.ts` and points back at these rows, so the append-only
 * guarantee holds for every row here. Indexed on
 * `(guildId, userId, createdAt)` so the per-user `/modlog` lookup and the
 * server-wide admin listing are both covered.
 */
/**
 * Every action a row can record. The single source for the model enum, the Web
 * UI filter and the format tables, so they cannot drift apart.
 *
 * `quarantine`, `raid_lockdown` and `raid_clear` are written only by the
 * anti-raid service (#1045). The two `raid_*` rows are guild-level state
 * changes rather than actions against a member, so their `userId` is the
 * guild id: they appear in the server-wide
 * listing and never in any member's `/modlog` history.
 */
export const MODERATION_ACTIONS = [
  "warn",
  "kick",
  "ban",
  "unban",
  "timeout",
  "untimeout",
  "quarantine",
  "raid_lockdown",
  "raid_clear",
] as const;

export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

/** `raid` marks rows written by the anti-raid service (#1045). */
export const MODERATION_SOURCES = ["command", "audit", "raid"] as const;

export type ModerationSource = (typeof MODERATION_SOURCES)[number];

export interface IModerationLog extends Document {
  guildId: string;
  /** The member the action was taken against. */
  userId: string;
  /** The moderator who took the action. Null when Discord hid the executor. */
  moderatorId: string | null;
  action: ModerationAction;
  reason: string | null;
  /**
   * `"command"` for KoolBot-issued warns via `/warn`; `"audit"` for actions
   * mirrored from the guild audit log; `"raid"` for anti-raid actions.
   */
  source: ModerationSource;
  createdAt: Date;
}

const ModerationLogSchema = new Schema<IModerationLog>(
  {
    guildId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    moderatorId: { type: String, default: null },
    action: {
      type: String,
      enum: [...MODERATION_ACTIONS],
      required: true,
    },
    reason: { type: String, default: null },
    source: {
      type: String,
      enum: [...MODERATION_SOURCES],
      required: true,
      default: "command",
    },
    createdAt: { type: Date, required: true, default: Date.now, index: true },
  },
  { timestamps: false },
);

// Per-user history lookup (`/modlog <user>`) is the hot path: filter by
// (guildId, userId) and sort by newest first.
ModerationLogSchema.index({ guildId: 1, userId: 1, createdAt: -1 });
// Server-wide admin listing filters by guild and sorts by newest first.
ModerationLogSchema.index({ guildId: 1, createdAt: -1 });

export const ModerationLog = mongoose.model<IModerationLog>(
  "ModerationLog",
  ModerationLogSchema,
);
