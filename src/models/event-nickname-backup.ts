import mongoose, { Document, Schema } from "mongoose";

/**
 * Nickname backups for the temporary clan tags of an event (#1194, part of the
 * event groups epic #1187).
 *
 * One row means "this member's server nickname MAY currently carry an event
 * tag, and `original` is what to put back". The row is written BEFORE the
 * first nickname edit and deleted only after the nickname is confirmed
 * restored (or confirmed not to need restoring), so a crash at any point
 * between the two leaves a row for the startup reconcile and the periodic
 * sweep to finish. The row is the member's own data: it is classified in
 * `user-data-registry.ts` (`event-nickname-backup`), exported, and erased by
 * a member data reset (which restores the nickname first).
 *
 * Why a collection of its own rather than a field on the event: the event
 * row is rewritten by several services (the scan saves whole copies of it, the
 * teardown, the group channel pass), and a backup that must survive every one
 * of them is safest where none of them can touch it. The row still belongs to
 * an event (`eventId`) and is found from it.
 *
 * Uniqueness is (guild, member), not (event, member): a member can be in two
 * running events at once, and a second event that backed up the nickname
 * "[RED] Alice" as the original would double-tag it and then restore the tag
 * as if it were the member's own name. One tag owner per member; the second
 * event waits until the first has restored.
 */
export interface IEventNicknameBackup extends Document {
  guildId: string;
  eventId: string;
  /** The member the backup belongs to. */
  memberId: string;
  /** The server nickname before tagging; null = none (the global/display name shows). */
  original: string | null;
  /**
   * The name the tag was built around: `original`, or the member's display
   * name when they had no server nickname. Stored so a later pass can tell
   * "already tagged correctly" without asking Discord.
   */
  base: string;
  /** The target of the latest edit: the tagged nickname the bot means to have on now. */
  intended: string;
  /**
   * Every nickname the bot has set or may have set, most recent last. Appended
   * to BEFORE each edit and never overwritten, so an unconfirmed or abandoned
   * earlier target is still recognised as the bot's own at restore.
   */
  owned: string[];
  /** The target whose edit Discord confirmed; null while the latest edit is unconfirmed. */
  confirmedTarget: string | null;
  /** When the latest edit was started; an unconfirmed edit is not resolved before it has settled. */
  attemptedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const eventNicknameBackupSchema = new Schema<IEventNicknameBackup>(
  {
    guildId: { type: String, required: true },
    eventId: { type: String, required: true },
    memberId: { type: String, required: true },
    original: { type: String, default: null, maxlength: 32 },
    base: { type: String, required: true, maxlength: 64 },
    intended: { type: String, required: true, maxlength: 32 },
    owned: { type: [{ type: String, maxlength: 64 }], default: [] },
    confirmedTarget: { type: String, default: null, maxlength: 32 },
    attemptedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

// One tag owner per member of a guild (the claim is an upsert on this key).
eventNicknameBackupSchema.index({ guildId: 1, memberId: 1 }, { unique: true });
// The restore of an event, and the sweep, find backups by event.
eventNicknameBackupSchema.index({ eventId: 1 });

export const EventNicknameBackup = mongoose.model<IEventNicknameBackup>(
  "EventNicknameBackup",
  eventNicknameBackupSchema,
);
