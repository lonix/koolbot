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
 * Deliberately kept simple (an append-only history, not a case-management
 * system): no appeals, expiry, or edit workflow. Indexed on
 * `(guildId, userId, createdAt)` so the per-user `/modlog` lookup and the
 * server-wide admin listing are both covered.
 */
export type ModerationAction =
  "warn" | "kick" | "ban" | "unban" | "timeout" | "untimeout";

export type ModerationSource = "command" | "audit";

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
   * mirrored from the guild audit log.
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
      enum: ["warn", "kick", "ban", "unban", "timeout", "untimeout"],
      required: true,
    },
    reason: { type: String, default: null },
    source: {
      type: String,
      enum: ["command", "audit"],
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
