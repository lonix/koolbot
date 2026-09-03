/**
 * Builds a member's "my data" export for `/me/privacy/export` (#719).
 *
 * What goes in is decided by `user-data-registry.ts`, not by this file: every
 * exportable entry in the registry has exactly one reader here, and
 * `__tests__/services/user-data-export-service.test.ts` asserts the two sets
 * match. Adding a collection to the registry without a reader (or the other
 * way round) fails the build rather than silently shipping a hole.
 *
 * Three properties the readers below have to hold to:
 *
 * 1. **Self-scope.** Every query filters on the member's own id, and on
 *    `guildId` for the collections that carry one. The registry records which
 *    do — the three keyed on `userId` alone are a cross-guild read the day the
 *    bot stops being single-guild.
 * 2. **No third-party leakage.** Three collections are shared aggregates
 *    (`poll-turnout`, `event`, `leaderboard-role-assignment`): their rows are
 *    projected down to the member's own slice so an export can never become a
 *    roster of everyone else. Fields that live *inside* the member's own
 *    document and are already shown back to them (voice companions, quote
 *    attribution) are kept as stored.
 * 3. **Bounded output.** Voice sessions and recent-message detail are
 *    append-only arrays with no per-row ceiling, so everything is capped at
 *    `privacy.export.max_items` and the payload names what it truncated. The
 *    JSON is emitted as a stream of chunks rather than one buffered string.
 */

import mongoose from "mongoose";
import { ConfigService } from "./config-service.js";
import {
  EXCLUDED_USER_DATA,
  EXPORTABLE_COLLECTIONS,
} from "./user-data-registry.js";
import { quoteSchema } from "../database/schema.js";
import { ChannelInvite } from "../models/channel-invite.js";
import { DigestState } from "../models/digest-state.js";
import { Event } from "../models/event.js";
import { LeaderboardRoleAssignment } from "../models/leaderboard-role-assignment.js";
import { MessageActivityTracking } from "../models/message-activity-tracking.js";
import { PollParticipationTracking } from "../models/poll-participation-tracking.js";
import { PollTurnout } from "../models/poll-turnout.js";
import { ReactionActivityTracking } from "../models/reaction-activity-tracking.js";
import { Reminder } from "../models/reminder.js";
import { RewindNudgeState } from "../models/rewind-nudge-state.js";
import { RewindSnapshot } from "../models/rewind-snapshot.js";
import { UserAchievements } from "../models/user-achievements.js";
import { UserBirthday } from "../models/user-birthday.js";
import { UserNotificationPrefs } from "../models/user-notification-prefs.js";
import { UserVoicePreferences } from "../models/user-voice-preferences.js";
import { VoiceChannelTracking } from "../models/voice-channel-tracking.js";

/** Bumped when the payload's shape changes in a way a consumer would notice. */
export const EXPORT_SCHEMA_VERSION = 1;

/** Default ceiling on rows/array entries per collection. */
export const DEFAULT_MAX_ITEMS = 5000;

/** Mutable running tally the route reads back for its audit row. */
export interface ExportProgress {
  /** Collections that produced at least one row (in emission order). */
  collections: string[];
  /** Collections whose output hit the `privacy.export.max_items` ceiling. */
  truncated: string[];
}

export function createExportProgress(): ExportProgress {
  return { collections: [], truncated: [] };
}

interface ReadContext {
  userId: string;
  guildId: string;
  maxItems: number;
}

interface CollectionResult {
  /** The value stored under this collection's key, or null when no rows. */
  value: unknown;
  /** Whether the ceiling clipped the result. */
  truncated?: boolean;
}

type CollectionReader = (ctx: ReadContext) => Promise<CollectionResult>;

/** Strip Mongo bookkeeping a member has no use for. */
function toPlain(doc: unknown): Record<string, unknown> {
  const obj = { ...(doc as Record<string, unknown>) };
  delete obj._id;
  delete obj.__v;
  return obj;
}

/** Apply the ceiling to a list read with `limit(maxItems + 1)`. */
function capped<T>(
  rows: T[],
  maxItems: number,
): { rows: T[]; truncated: boolean } {
  if (rows.length > maxItems) {
    return { rows: rows.slice(0, maxItems), truncated: true };
  }
  return { rows, truncated: false };
}

/**
 * The quote model is constructed by `QuoteService`'s constructor, and
 * `mongoose.model()` throws `OverwriteModelError` on a second registration —
 * so reuse the compiled model when it already exists rather than assuming
 * either service ran first.
 */
function quoteModel(): mongoose.Model<Record<string, unknown>> {
  const existing = mongoose.models.Quote as
    mongoose.Model<Record<string, unknown>> | undefined;
  return (
    existing ??
    mongoose.model<Record<string, unknown>>(
      "Quote",
      quoteSchema as unknown as mongoose.Schema<Record<string, unknown>>,
    )
  );
}

/**
 * One reader per exportable collection in the registry. Keys are the
 * registry's `collection` labels and become the keys of the payload's `data`
 * object, so renaming one changes every future export.
 */
const READERS: Record<string, CollectionReader> = {
  "voice-channel-tracking": async ({ userId, maxItems }) => {
    const doc = await VoiceChannelTracking.findOne({ userId }).lean();
    if (!doc) return { value: null };
    const plain = toPlain(doc);
    const sessions = Array.isArray(plain.sessions) ? plain.sessions : [];
    // Append-only and unbounded: keep the most RECENT window, which is the
    // half a member asking "what do you know about me" actually wants.
    const truncated = sessions.length > maxItems;
    return {
      value: {
        ...plain,
        totalSessionsStored: sessions.length,
        sessions: truncated ? sessions.slice(-maxItems) : sessions,
      },
      truncated,
    };
  },

  "message-activity-tracking": async ({ userId, guildId, maxItems }) => {
    const doc = await MessageActivityTracking.findOne({
      userId,
      guildId,
    }).lean();
    if (!doc) return { value: null };
    const plain = toPlain(doc);
    const recent = Array.isArray(plain.recentMessages)
      ? plain.recentMessages
      : [];
    const truncated = recent.length > maxItems;
    return {
      value: {
        ...plain,
        totalRecentMessagesStored: recent.length,
        recentMessages: truncated ? recent.slice(-maxItems) : recent,
      },
      truncated,
    };
  },

  "reaction-activity-tracking": async ({ userId, guildId }) => {
    const doc = await ReactionActivityTracking.findOne({
      userId,
      guildId,
    }).lean();
    return { value: doc ? toPlain(doc) : null };
  },

  "poll-participation-tracking": async ({ userId, guildId }) => {
    const doc = await PollParticipationTracking.findOne({
      userId,
      guildId,
    }).lean();
    return { value: doc ? toPlain(doc) : null };
  },

  // Shared aggregate: one row per poll, holding every voter's id. The member
  // gets the polls they voted on and the turnout total — never the roster.
  "poll-turnout": async ({ userId, guildId, maxItems }) => {
    const rows = await PollTurnout.find({ guildId, voterIds: userId })
      .sort({ postedAt: -1 })
      .limit(maxItems + 1)
      .lean();
    const { rows: kept, truncated } = capped(rows, maxItems);
    return {
      value: kept.map((row) => ({
        messageId: row.messageId,
        channelId: row.channelId,
        question: row.question,
        postedAt: row.postedAt,
        youVoted: true,
        totalVoters: Array.isArray(row.voterIds) ? row.voterIds.length : 0,
      })),
      truncated,
    };
  },

  "user-achievements": async ({ userId }) => {
    const doc = await UserAchievements.findOne({ userId }).lean();
    return { value: doc ? toPlain(doc) : null };
  },

  "user-birthday": async ({ userId, guildId }) => {
    const doc = await UserBirthday.findOne({ userId, guildId }).lean();
    return { value: doc ? toPlain(doc) : null };
  },

  "user-notification-prefs": async ({ userId, guildId }) => {
    const doc = await UserNotificationPrefs.findOne({ userId, guildId }).lean();
    return { value: doc ? toPlain(doc) : null };
  },

  "user-voice-preferences": async ({ userId }) => {
    const doc = await UserVoicePreferences.findOne({ userId }).lean();
    return { value: doc ? toPlain(doc) : null };
  },

  "rewind-snapshot": async ({ userId, guildId, maxItems }) => {
    const rows = await RewindSnapshot.find({ userId, guildId })
      .sort({ year: -1 })
      .limit(maxItems + 1)
      .lean();
    const { rows: kept, truncated } = capped(rows, maxItems);
    return { value: kept.map(toPlain), truncated };
  },

  "rewind-nudge-state": async ({ userId, guildId, maxItems }) => {
    const rows = await RewindNudgeState.find({ userId, guildId })
      .sort({ year: -1 })
      .limit(maxItems + 1)
      .lean();
    const { rows: kept, truncated } = capped(rows, maxItems);
    return { value: kept.map(toPlain), truncated };
  },

  "digest-state": async ({ userId, guildId }) => {
    const doc = await DigestState.findOne({ userId, guildId }).lean();
    return { value: doc ? toPlain(doc) : null };
  },

  reminder: async ({ userId, guildId, maxItems }) => {
    const rows = await Reminder.find({ userId, guildId })
      .sort({ remindAt: -1 })
      .limit(maxItems + 1)
      .lean();
    const { rows: kept, truncated } = capped(rows, maxItems);
    return { value: kept.map(toPlain), truncated };
  },

  // Shared aggregate: an event row carries every attendee's RSVP plus the
  // organiser's id. Projected down to the event and the member's own answer.
  "event-rsvp": async ({ userId, guildId, maxItems }) => {
    const rows = await Event.find({ guildId, "rsvps.userId": userId })
      .sort({ startTime: -1 })
      .limit(maxItems + 1)
      .lean();
    const { rows: kept, truncated } = capped(rows, maxItems);
    return {
      value: kept.map((row) => {
        const rsvps = (Array.isArray(row.rsvps) ? row.rsvps : []) as Array<{
          userId: string;
          status: string;
          respondedAt: Date;
        }>;
        const mine = rsvps.find((rsvp) => rsvp.userId === userId);
        return {
          title: row.title,
          startTime: row.startTime,
          timezone: row.timezone,
          state: row.state,
          yourRsvp: mine
            ? { status: mine.status, respondedAt: mine.respondedAt }
            : null,
        };
      }),
      truncated,
    };
  },

  // Shared aggregate: the row lists every current holder of the reward role.
  // The member learns which roles list them, not who else is on them.
  "leaderboard-role-assignment": async ({ userId, guildId, maxItems }) => {
    const rows = await LeaderboardRoleAssignment.find({
      guildId,
      userIds: userId,
    })
      .limit(maxItems + 1)
      .lean();
    const { rows: kept, truncated } = capped(rows, maxItems);
    return {
      value: kept.map((row) => ({
        roleId: row.roleId,
        topN: row.topN,
        updatedAt: row.updatedAt,
      })),
      truncated,
    };
  },

  // Two distinct user fields on one schema: quotes the member said, and
  // quotes they saved for someone else. Both are their own activity, and a
  // quote is already public in the quote channel, so rows are kept as stored
  // with a `role` marker saying which side of the row matched.
  quote: async ({ userId, maxItems }) => {
    const rows = await quoteModel()
      .find({ $or: [{ authorId: userId }, { addedById: userId }] })
      .sort({ addedAt: -1 })
      .limit(maxItems + 1)
      .lean();
    const { rows: kept, truncated } = capped(rows, maxItems);
    return {
      value: kept.map((row) => {
        const plain = toPlain(row);
        const said = plain.authorId === userId;
        const added = plain.addedById === userId;
        return {
          ...plain,
          yourRole: said && added ? "said-and-added" : said ? "said" : "added",
        };
      }),
      truncated,
    };
  },

  "channel-invite": async ({ userId, maxItems }) => {
    const rows = await ChannelInvite.find({
      $or: [{ userId }, { invitedBy: userId }],
    })
      .sort({ createdAt: -1 })
      .limit(maxItems + 1)
      .lean();
    const { rows: kept, truncated } = capped(rows, maxItems);
    return {
      value: kept.map((row) => {
        const plain = toPlain(row);
        return {
          ...plain,
          yourRole: plain.userId === userId ? "invited" : "inviter",
        };
      }),
      truncated,
    };
  },
};

/** Collection labels that have a reader. Exported for the parity test. */
export const READER_COLLECTIONS: readonly string[] = Object.keys(READERS);

const ABOUT =
  "Everything Koolbot has stored about you on this server, as of the time " +
  "shown above. Moderation records, admin audit logs and session rows are " +
  "deliberately not included — see the `excluded` list. Long append-only " +
  "histories are capped at `maxItemsPerCollection`; anything clipped is " +
  "named in `truncated`.";

export class UserDataExportService {
  private static instance: UserDataExportService | null = null;

  static getInstance(): UserDataExportService {
    if (!UserDataExportService.instance) {
      UserDataExportService.instance = new UserDataExportService();
    }
    return UserDataExportService.instance;
  }

  /** Per-collection ceiling; `0` or junk falls back to the default. */
  async getMaxItems(): Promise<number> {
    const configured = await ConfigService.getInstance().getNumber(
      "privacy.export.max_items",
      DEFAULT_MAX_ITEMS,
    );
    return Number.isFinite(configured) && configured > 0
      ? Math.floor(configured)
      : DEFAULT_MAX_ITEMS;
  }

  /**
   * Read one collection. Exposed so a single reader can be unit-tested (and
   * so a future deletion pass in #906 can walk the same table).
   */
  async readCollection(
    collection: string,
    ctx: ReadContext,
  ): Promise<CollectionResult> {
    const reader = READERS[collection];
    if (!reader) throw new Error(`No export reader for "${collection}"`);
    return reader(ctx);
  }

  /**
   * Emit the export as a stream of JSON text chunks.
   *
   * The header goes out first, then one chunk per collection, then the
   * trailer — so no single string ever holds the whole payload, and a member
   * with years of voice history doesn't cost a multi-megabyte allocation.
   * `progress` is filled in as we go; the caller reads it back after the
   * generator finishes to audit what was served.
   */
  async *streamJson(
    userId: string,
    guildId: string,
    progress: ExportProgress,
  ): AsyncGenerator<string> {
    const maxItems = await this.getMaxItems();
    const ctx: ReadContext = { userId, guildId, maxItems };

    yield "{\n" +
      `  "schemaVersion": ${EXPORT_SCHEMA_VERSION},\n` +
      `  "generatedAt": ${JSON.stringify(new Date().toISOString())},\n` +
      `  "userId": ${JSON.stringify(userId)},\n` +
      `  "guildId": ${JSON.stringify(guildId)},\n` +
      `  "maxItemsPerCollection": ${maxItems},\n` +
      `  "about": ${JSON.stringify(ABOUT)},\n` +
      `  "excluded": ${JSON.stringify(excludedSummary())},\n` +
      '  "data": {';

    let first = true;
    for (const collection of EXPORTABLE_COLLECTIONS) {
      const { value, truncated } = await this.readCollection(collection, ctx);
      if (truncated) progress.truncated.push(collection);
      if (!isEmptyResult(value)) progress.collections.push(collection);
      yield `${first ? "" : ","}\n    ${JSON.stringify(collection)}: ` +
        JSON.stringify(value ?? null);
      first = false;
    }

    yield "\n  },\n" +
      `  "truncated": ${JSON.stringify(progress.truncated)}\n` +
      "}\n";
  }
}

/** A collection contributed nothing when it has no document and no rows. */
function isEmptyResult(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** The "what isn't in here" list, straight from the registry. */
function excludedSummary(): Array<{ collection: string; reason: string }> {
  const seen = new Map<string, string>();
  for (const entry of EXCLUDED_USER_DATA) {
    if (!seen.has(entry.collection)) seen.set(entry.collection, entry.note);
  }
  return [...seen].map(([collection, reason]) => ({ collection, reason }));
}
