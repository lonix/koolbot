import { Model, Document, model } from "mongoose";
import { getErrorMessage } from "../utils/error-guards.js";
import logger from "../utils/logger.js";
import { isMissingPostError } from "../utils/discord.js";

/** A Mongo ObjectId is a 24-character hex string. Matching with a regex avoids
 * importing `mongoose.Types` (which the test suite's mongoose mock omits). */
function isValidObjectId(id: string): boolean {
  return /^[a-f\d]{24}$/i.test(id);
}
import { quoteSchema } from "../database/schema.js";
import { ConfigService } from "./config-service.js";
import { ANONYMISED_USER_ID } from "./user-data-registry.js";
import { CooldownManager } from "./cooldown-manager.js";
import { normalizeUserId, userIdMatchForms } from "../utils/user-id.js";

const configService = ConfigService.getInstance();

/** One timestamped change to a quote's 👍 tally (#817). */
export interface QuoteLikeEvent {
  at: Date;
  delta: number;
}

export interface IQuote extends Document {
  content: string;
  authorId: string;
  addedById: string;
  channelId: string;
  messageId: string;
  /** Channel the quote-channel post went to (see `database/schema.ts`). */
  postChannelId?: string;
  createdAt: Date;
  addedAt: Date;
  likes: number;
  dislikes: number;
  /** Timestamped like deltas within the retention window (#817). */
  likeEvents?: QuoteLikeEvent[];
}

/** Fallback retention for per-vote like timing, in days. */
const DEFAULT_VOTE_HISTORY_DAYS = 30;

/**
 * Hard cap on stored like events per quote. Retention alone is not a bound —
 * a reaction war on a single quote could otherwise grow the document without
 * limit — so the newest events win once the cap is reached.
 */
export const MAX_LIKE_EVENTS = 200;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Resolve a retention setting to a cutoff date. A misconfigured (or
 * non-numeric) value must not silently disable pruning, so it falls back to
 * the default rather than producing a NaN cutoff.
 */
export function likeEventCutoff(now: Date, retentionDays: number): Date {
  const days =
    Number.isFinite(retentionDays) && retentionDays > 0
      ? retentionDays
      : DEFAULT_VOTE_HISTORY_DAYS;
  return new Date(now.getTime() - days * MS_PER_DAY);
}

/** True when any stored event predates `cutoff` and is therefore prunable. */
export function hasExpiredLikeEvents(
  events: QuoteLikeEvent[] | undefined | null,
  cutoff: Date,
): boolean {
  for (const event of events ?? []) {
    if (!event || !event.at) continue;
    const at = new Date(event.at);
    if (Number.isNaN(at.getTime())) continue;
    if (at < cutoff) return true;
  }
  return false;
}

/**
 * Net likes a quote gained at or after `since`. Negative deltas (a like that
 * was taken back) count against the window, so a quote cannot ride a vote it
 * no longer has.
 */
export function sumLikeEventsSince(
  events: QuoteLikeEvent[] | undefined | null,
  since: Date,
): number {
  let total = 0;
  for (const event of events ?? []) {
    if (!event || !event.at) continue;
    const at = new Date(event.at);
    if (Number.isNaN(at.getTime()) || at < since) continue;
    if (!Number.isFinite(event.delta)) continue;
    total += event.delta;
  }
  return total;
}

/** Bumped if the export shape ever changes in a backwards-incompatible way. */
export const QUOTE_EXPORT_VERSION = 1;

/** One quote in a backup file. `id` is the original Mongo `_id` so it can be
 * preserved across a reinstall (it is what the quote embed footer shows). */
export interface QuoteExportEntry {
  id?: string;
  content: string;
  authorId: string;
  addedById: string;
  channelId: string;
  messageId: string;
  /** Channel the quote-channel post went to (see `database/schema.ts`). */
  postChannelId?: string;
  likes: number;
  dislikes: number;
  createdAt?: string;
  addedAt?: string;
}

export interface QuoteExport {
  version: number;
  exportedAt: string;
  quotes: QuoteExportEntry[];
}

export interface QuoteImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

/**
 * The one thing the purge needs from `QuoteChannelManager`, injected rather
 * than imported: `quote-channel-manager.ts` already imports this module's
 * singleton, so a static import back would be a cycle. It is a required
 * argument, not an optional one, because skipping it is precisely the bug
 * described below — a deleted row whose Discord post lives on forever.
 */
export interface QuoteMessageDeleter {
  /**
   * Delete a quote-channel post. Resolves `true` only when the post is
   * *gone* — an already-missing message counts, an unreachable channel or a
   * refused delete does not (#916). A purge reports this back to the member
   * as posts removed, so "no exception escaped" is not good enough.
   */
  deleteQuoteMessage(messageId: string, postedIn?: string): Promise<boolean>;
  /**
   * Re-render a quote-channel post from the row's current values. A purge
   * needs this because the embed prints "Added by @member": anonymising the
   * row alone leaves the member's name on a public post (#916). Rejects when
   * the edit did not land.
   */
  updateQuoteMessage(
    messageId: string,
    quoteId: string,
    content: string,
    authorId: string,
    addedById: string,
    postedIn?: string,
  ): Promise<void>;
}

/** What a purge did to a quote row while its post was being published (#916). */
export interface QuotePublicationResult {
  /** False when the row was deleted before the post id could be recorded. */
  stillExists: boolean;
  /**
   * True when the row's saver attribution is the anonymisation sentinel, so
   * the post just published names someone whose data has been erased.
   */
  attributionCleared: boolean;
  /**
   * False when the row does not carry this post's id — the write did not
   * land, or could not be verified. Nothing then points at the post, and the
   * channel sweep only collects non-bot messages, so the caller has to take
   * it down itself.
   */
  recorded: boolean;
}

/** What a per-user quote purge did (#914). */
export interface QuotePurgeResult {
  /** Quotes attributed to the member that the purge found. */
  authored: number;
  /** Of those, the ones actually deleted. */
  deleted: number;
  /**
   * Why the row delete did not finish, when it did not (#916). Recorded
   * rather than thrown so the posts already deleted above it, and the
   * anonymisation below it, are not lost with it.
   */
  deleteError?: string;
  /** Quote-channel posts the purge tried to delete (rows with a messageId). */
  messagesAttempted: number;
  /** Of those, the ones confirmed gone. */
  messagesDeleted: number;
  /**
   * Of those, the ones that may still be visible in Discord (#916). The row
   * is deleted regardless — see `purgeForUser` — so this is the member's
   * erasure being *incomplete*, and the caller has to report it rather than
   * count a failed delete as a success.
   */
  messagesFailed: number;
  /** Quotes the member saved for someone else that the purge found. */
  saverMatched: number;
  /**
   * Of those, the ones whose attribution was actually cleared. A row that
   * changed between the snapshot and the write is deliberately kept — see
   * `purgeForUser` — so a shortfall here is a purge that has to be run again.
   */
  anonymised: number;
  /**
   * Of those, the quote-channel posts re-rendered so the embed stops naming
   * the member as the saver (#916).
   */
  attributionsRerendered: number;
  /**
   * Posts that still print the member's name because the edit failed. The
   * row is anonymised either way, so this is the visible half left behind.
   *
   * Only genuine failures count here: a post that is already gone is a
   * completed erasure, not a stale one (#916) — see `attributionsGone`.
   */
  attributionsStale: number;
  /**
   * Posts that needed no re-render because they no longer exist. Expected
   * rather than exceptional: `messageId` starts life as the *original*
   * message id and is only overwritten once the quote-channel post goes up,
   * so an older row points at a message the purge has no business editing.
   */
  attributionsGone: number;
  /** Why the anonymisation did not finish, when it did not (#916). */
  anonymiseError?: string;
}

/** Read a publication's outcome off the row as it now stands (#916). */
function publicationOutcome(
  row: IQuote | null,
  messageId: string,
): QuotePublicationResult {
  if (!row) {
    return { stillExists: false, attributionCleared: false, recorded: false };
  }
  return {
    stillExists: true,
    attributionCleared: row.addedById === ANONYMISED_USER_ID,
    recorded: row.messageId === messageId,
  };
}

export class QuoteService {
  private model: Model<IQuote>;
  private cooldownManager: CooldownManager;

  constructor() {
    this.model = model<IQuote>("Quote", quoteSchema);
    this.cooldownManager = new CooldownManager();
  }

  async addQuote(
    content: string,
    authorId: string,
    addedById: string,
    channelId: string,
    messageId: string,
  ): Promise<IQuote> {
    // Check if quotes are enabled
    const enabled = await configService.getBoolean("quotes.enabled");
    if (!enabled) {
      throw new Error("Quote system is disabled");
    }

    // Check cooldown
    const cooldown = await configService.getNumber("quotes.cooldown", 60);
    if (this.cooldownManager.isOnCooldown(addedById, "quote_add", cooldown)) {
      throw new Error(
        `Please wait ${cooldown} seconds before adding another quote`,
      );
    }

    // Check quote length
    const maxLength = await configService.getNumber("quotes.max_length", 1000);
    if (content.length > maxLength) {
      throw new Error(
        `Quote is too long. Maximum length is ${maxLength} characters`,
      );
    }

    const quote = new this.model({
      content,
      authorId,
      addedById,
      channelId,
      messageId,
      createdAt: new Date(),
      addedAt: new Date(),
      likes: 0,
      dislikes: 0,
    });

    await quote.save();
    this.cooldownManager.setCooldown(addedById, "quote_add");
    return quote;
  }

  async getRandomQuote(): Promise<IQuote> {
    const count = await this.model.countDocuments();
    if (count === 0) {
      throw new Error("No quotes available");
    }

    const random = Math.floor(Math.random() * count);
    const quote = await this.model.findOne().skip(random);
    if (!quote) {
      throw new Error("Failed to fetch random quote");
    }
    return quote;
  }

  async searchQuotes(query: string): Promise<IQuote[]> {
    return this.model
      .find({
        content: { $regex: query, $options: "i" },
      })
      .limit(10);
  }

  async deleteQuote(
    quoteId: string,
    userId: string,
    userRoles: string[],
  ): Promise<void> {
    const quote = await this.model.findById(quoteId);
    if (!quote) {
      throw new Error("Quote not found");
    }

    // Check if user has permission to delete
    const deleteRolesStr = await configService.getString(
      "quotes.delete_roles",
      "",
    );
    const deleteRoles = deleteRolesStr.split(",").filter(Boolean);
    const hasPermission =
      deleteRoles.length === 0 || // Empty means only admins
      userRoles.some((role) => deleteRoles.includes(role)) ||
      quote.addedById === userId; // Allow users to delete their own quotes

    if (!hasPermission) {
      throw new Error("You do not have permission to delete quotes");
    }

    await this.model.findByIdAndDelete(quoteId);
  }

  /**
   * Configured retention for like-event timing, in days (#817).
   */
  private async getVoteHistoryDays(): Promise<number> {
    return configService.getNumber(
      "quotes.vote_history_days",
      DEFAULT_VOTE_HISTORY_DAYS,
    );
  }

  async likeQuote(quoteId: string): Promise<void> {
    // Record *when* the like landed alongside the lifetime counter (#817), so
    // the weekly recap can rank by votes cast in the window. `$slice` bounds
    // the array without a read-modify-write.
    await this.model.findByIdAndUpdate(quoteId, {
      $inc: { likes: 1 },
      $push: {
        likeEvents: {
          $each: [{ at: new Date(), delta: 1 }],
          $slice: -MAX_LIKE_EVENTS,
        },
      },
    });
  }

  async dislikeQuote(quoteId: string): Promise<void> {
    await this.model.findByIdAndUpdate(quoteId, { $inc: { dislikes: 1 } });
  }

  async listQuotes(
    page: number = 1,
    limit: number = 10,
  ): Promise<{ quotes: IQuote[]; total: number; totalPages: number }> {
    const skip = (page - 1) * limit;
    const total = await this.model.countDocuments();
    const totalPages = Math.ceil(total / limit);

    const quotes = await this.model
      .find()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    return { quotes, total, totalPages };
  }

  async getQuoteById(quoteId: string): Promise<IQuote | null> {
    return this.model.findById(quoteId);
  }

  /**
   * Record the quote-channel post id on a quote row.
   *
   * Reports what the purge did to the row while the post was being published
   * (#916), because the post is written from a snapshot taken before the
   * insert and the publisher is the only one left who can repair it:
   *
   *  - `stillExists: false` — the row was deleted, so nothing will ever
   *    point at the post just made (`cleanupUnauthorizedMessages` sweeps
   *    only non-bot messages). The caller deletes it.
   *  - `attributionCleared: true` — the row survived but its saver
   *    attribution was anonymised, and the purge's own re-render aimed at
   *    the *old* `messageId` (a quote row carries the originating message id
   *    until this write overwrites it), so it never touched the post now on
   *    screen. The row already holds the sentinel, so no later purge will
   *    find it either. The caller redraws or removes the post.
   */
  async updateQuoteMessageId(
    quoteId: string,
    messageId: string,
    postChannelId?: string,
  ): Promise<QuotePublicationResult> {
    try {
      const updated = await this.model.findByIdAndUpdate(
        quoteId,
        // The channel goes with the id: without it nothing can find this post
        // again once the quote channel is moved (#916).
        postChannelId ? { messageId, postChannelId } : { messageId },
        { new: true },
      );
      return publicationOutcome(updated, messageId);
    } catch (error) {
      // The write may have applied and lost only its acknowledgement, and a
      // concurrent purge may have anonymised the row in the meantime — in
      // which case the post just made names an erased member behind a
      // sentinel row no later purge can select. Re-read and report what is
      // actually there; the caller repairs or removes the post from that.
      logger.error(
        `Failed to record the quote-channel post for quote ${quoteId}:`,
        error,
      );
      try {
        return publicationOutcome(
          await this.model.findById(quoteId),
          messageId,
        );
      } catch (reread) {
        logger.error(
          `Could not re-read quote ${quoteId} after a failed publication write:`,
          reread,
        );
        // Unverifiable: treat the post as unrecorded, which has the caller
        // take it down. A row left pointing at a deleted message is the
        // recoverable direction — `/quote reset` republishes it — while an
        // orphaned post is not.
        return {
          stillExists: true,
          attributionCleared: false,
          recorded: false,
        };
      }
    }
  }

  /**
   * Persist the live 👍/👎 tallies for the quote posted as `messageId`.
   *
   * The reaction handlers only ever know the Discord message ID, so the
   * lookup is by `messageId` rather than `_id`. This is what makes votes
   * "stick": without it the counts live only on the Discord message and are
   * lost the moment the channel is re-synced (e.g. after a reinstall).
   */
  async setVoteCountsByMessageId(
    messageId: string,
    likes: number,
    dislikes: number,
  ): Promise<void> {
    if (!messageId) return;
    const nextLikes = Math.max(0, likes);
    const nextDislikes = Math.max(0, dislikes);
    const tallies = { likes: nextLikes, dislikes: nextDislikes };

    // Reactions arrive as an absolute snapshot, so the difference against the
    // stored tally is how many likes were gained (or taken back) since the
    // last write. Stamping that delta is what makes "most-liked this week"
    // answerable for a quote added long ago (#817).
    const existing = await this.model.findOne({ messageId });
    // Nothing to update: the message is not (or is no longer) a stored quote,
    // and there is no upsert to perform.
    if (!existing) return;

    const previousLikes = existing.likes ?? 0;
    const delta = nextLikes - previousLikes;

    // Vote writes are debounced and fired without being awaited, so two
    // persists for the same message can overlap. The delta was measured
    // against `previousLikes`, so the write is guarded on that tally still
    // being current: the winner stamps atomically ($push, never a
    // read-modify-write of the array), and a loser — whose delta is now
    // measured against a stale count — records the latest tallies without
    // stamping rather than double-counting or clobbering the history.
    const stamped =
      delta !== 0 &&
      Boolean(
        await this.model.findOneAndUpdate(
          { messageId, likes: previousLikes },
          {
            $set: tallies,
            $push: {
              likeEvents: {
                $each: [{ at: new Date(), delta }],
                $slice: -MAX_LIKE_EVENTS,
              },
            },
          },
        ),
      );

    if (!stamped) {
      await this.model.findOneAndUpdate({ messageId }, tallies);
    }

    // Every persist is an opportunity to enforce retention, not just one that
    // stamped: a quote whose 👍 tally has settled (only 👎 changed, or a burst
    // came back to where it started) would otherwise keep expired history
    // indefinitely, bounded by the entry cap but never by age.
    await this.pruneLikeEvents(messageId, existing.likeEvents);
  }

  /**
   * Drop like events that have aged out of the retention window. `$slice`
   * on the stamping write bounds the array's size; this bounds its age. The
   * pre-read history is only used to skip the write when there is nothing to
   * prune — the `$pull` itself is evaluated server-side, so it stays correct
   * under concurrent persists.
   */
  private async pruneLikeEvents(
    messageId: string,
    events: QuoteLikeEvent[] | undefined,
  ): Promise<void> {
    const cutoff = likeEventCutoff(new Date(), await this.getVoteHistoryDays());
    if (!hasExpiredLikeEvents(events, cutoff)) return;
    await this.model.updateOne(
      { messageId },
      { $pull: { likeEvents: { at: { $lt: cutoff } } } },
    );
  }

  /**
   * Serialise every quote (including its vote tallies) into a backup
   * structure suitable for JSON export. The original `_id` is preserved as
   * `id` so a restore can reproduce the same quote IDs shown in embed footers.
   */
  async exportQuotes(): Promise<QuoteExport> {
    const quotes = await this.model.find().sort({ createdAt: 1 });
    return {
      version: QUOTE_EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      quotes: quotes.map((q) => ({
        id: q._id.toString(),
        content: q.content,
        authorId: q.authorId,
        addedById: q.addedById,
        channelId: q.channelId,
        messageId: q.messageId,
        // Goes with `messageId`: without it a restored row cannot say which
        // channel its post is in, and a purge would look in whichever one is
        // configured at the time (#916).
        ...(q.postChannelId ? { postChannelId: q.postChannelId } : {}),
        likes: q.likes ?? 0,
        dislikes: q.dislikes ?? 0,
        createdAt: q.createdAt?.toISOString(),
        addedAt: q.addedAt?.toISOString(),
      })),
    };
  }

  /**
   * Ingest a backup produced by {@link exportQuotes}. Entries whose original
   * `id` (or identical content+author) already exist are skipped, so a
   * restore is idempotent and safe to re-run. Vote tallies are restored as-is.
   */
  async importQuotes(payload: unknown): Promise<QuoteImportResult> {
    const result: QuoteImportResult = { imported: 0, skipped: 0, errors: [] };

    const source = payload as Partial<QuoteExport> | null | undefined;
    if (!source || !Array.isArray(source.quotes)) {
      result.errors.push("Invalid backup: expected { quotes: [...] }");
      return result;
    }

    for (let i = 0; i < source.quotes.length; i++) {
      const entry = source.quotes[i];
      if (!entry || typeof entry.content !== "string" || !entry.content) {
        result.errors.push(`Quote ${i + 1}: missing content`);
        result.skipped++;
        continue;
      }
      if (!entry.authorId || !entry.addedById) {
        result.errors.push(`Quote ${i + 1}: missing author or addedBy`);
        result.skipped++;
        continue;
      }

      try {
        // Skip if the original id already exists (re-running a restore) or an
        // identical quote (same text + author) is already stored. When the id
        // is valid we still also match on content+author so a re-import under a
        // new id cannot duplicate an existing quote (the idempotency contract).
        const validId =
          Boolean(entry.id) && isValidObjectId(entry.id as string);
        const contentMatch = {
          content: entry.content,
          authorId: entry.authorId,
        };
        const duplicate = await this.model.findOne(
          validId ? { $or: [{ _id: entry.id }, contentMatch] } : contentMatch,
        );
        if (duplicate) {
          result.skipped++;
          continue;
        }

        await this.model.create({
          // Preserve the original _id when valid so footer IDs survive a
          // reinstall; otherwise let Mongo assign a fresh one.
          ...(validId ? { _id: entry.id } : {}),
          content: entry.content,
          authorId: entry.authorId,
          addedById: entry.addedById,
          channelId: entry.channelId || "imported",
          // messageId is required by the schema; the channel re-sync overwrites
          // it with the real message ID once the quote is re-posted.
          messageId: entry.messageId || `imported-${entry.id ?? i}`,
          // Only when the backup carried one: inventing a channel would turn
          // a guess into a recorded fact.
          ...(entry.postChannelId
            ? { postChannelId: entry.postChannelId }
            : {}),
          createdAt: entry.createdAt ? new Date(entry.createdAt) : new Date(),
          addedAt: entry.addedAt ? new Date(entry.addedAt) : new Date(),
          likes: Math.max(0, entry.likes ?? 0),
          dislikes: Math.max(0, entry.dislikes ?? 0),
        });
        result.imported++;
      } catch (error) {
        logger.error(`Error importing quote ${i + 1}:`, error);
        result.errors.push(
          `Quote ${i + 1}: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
        result.skipped++;
      }
    }

    return result;
  }

  async editQuote(
    quoteId: string,
    content: string,
    authorId: string,
  ): Promise<void> {
    const quote = await this.model.findById(quoteId);
    if (!quote) {
      throw new Error("Quote not found");
    }

    // Check quote length
    const maxLength = await configService.getNumber("quotes.max_length", 1000);
    if (content.length > maxLength) {
      throw new Error(
        `Quote is too long. Maximum length is ${maxLength} characters`,
      );
    }

    // Normalize authorId to prevent double @ issues with legacy data
    const normalizedAuthorId = normalizeUserId(authorId);

    // Validate that the normalized authorId is a valid Discord user ID (numeric)
    if (!/^\d+$/.test(normalizedAuthorId)) {
      throw new Error(
        "Invalid author ID format. Please select a valid Discord user.",
      );
    }

    await this.model.findByIdAndUpdate(quoteId, {
      content,
      authorId: normalizedAuthorId,
    });
  }

  async getAllQuotes(): Promise<IQuote[]> {
    return this.model.find().sort({ createdAt: -1 });
  }

  /**
   * Return the most-liked quote added since `since`, for the public weekly
   * recap (#777). Only quotes with at least one like qualify, so a quiet week
   * surfaces nothing rather than an arbitrary zero-vote quote. Scoped by
   * `createdAt` (when the quote was added), which approximates "top-voted
   * this week" as "most-liked among quotes added this week".
   *
   * Since #817 this is the *fallback*: prefer
   * {@link getTopQuoteByVotesSince}, which ranks by votes actually cast in
   * the window, and fall back here when no vote timing has been captured yet
   * (an install that has had quotes for longer than it has recorded votes).
   * Returns null when nothing qualifies.
   */
  async getTopQuoteSince(since: Date): Promise<IQuote | null> {
    return this.model
      .findOne({
        createdAt: { $gte: since },
        likes: { $gt: 0 },
      })
      .sort({ likes: -1 });
  }

  /**
   * Return the quote that gained the most likes *within* the window starting
   * at `since`, regardless of when it was added (#817) — the pick the weekly
   * recap actually wants. Ranking happens in memory because the candidate set
   * is only the quotes voted on during the window, and each one's score is
   * the sum of its like deltas inside it.
   *
   * Only votes recorded after the timing feature shipped can be windowed;
   * quotes with no events in range simply do not qualify, and callers fall
   * back to {@link getTopQuoteSince}. Returns null when nothing qualifies.
   */
  async getTopQuoteByVotesSince(
    since: Date,
  ): Promise<{ quote: IQuote; likes: number } | null> {
    const candidates = await this.model.find({
      likeEvents: { $elemMatch: { at: { $gte: since }, delta: { $gt: 0 } } },
    });

    let best: IQuote | null = null;
    let bestLikes = 0;
    for (const quote of candidates ?? []) {
      const gained = sumLikeEventsSince(quote.likeEvents, since);
      if (gained <= 0) continue;
      // Ties go to the quote with the higher lifetime tally, so the pick is
      // stable rather than dependent on document order.
      if (
        gained > bestLikes ||
        (gained === bestLikes && (quote.likes ?? 0) > (best?.likes ?? 0))
      ) {
        best = quote;
        bestLikes = gained;
      }
    }

    return best ? { quote: best, likes: bestLikes } : null;
  }

  /**
   * Erase a member from the quote collection (#914).
   *
   * The two user fields on a quote row are two different people, so they get
   * two different treatments — which is why this is one method rather than a
   * `deleteMany`:
   *
   * - `authorId === userId` — the quote is a record of what *they* said, so
   *   the row goes, **and so does the bot's post in the quote channel** —
   *   and when the post cannot be deleted the row still goes, but the
   *   failure is counted as a failure so the caller can say so (#916).
   *   Deleting only the row would leave the member's words visible in Discord
   *   forever: `quote-channel-manager.cleanupUnauthorizedMessages()` sweeps
   *   only messages whose author is *not* the bot, so a bot-posted quote
   *   orphaned by a database delete is never collected by anything.
   * - `addedById === userId` — the quote belongs to whoever said it, so the
   *   row stays and only the saver's attribution is cleared, to the
   *   `ANONYMISED_USER_ID` sentinel (the field is `required: true` and cannot
   *   be nulled). **The channel post is re-rendered too**: its embed prints
   *   "Added by @member", so clearing the row alone would leave the member
   *   named on a public message (#916).
   *
   * Authored rows are removed first so a quote the member both said *and*
   * saved is deleted rather than anonymised.
   *
   * This deliberately does not route through `deleteQuote`, which enforces
   * `quotes.delete_roles`: a member erasing their own data is not a
   * moderator deleting someone else's quote, and the call site must not be
   * the place that decides to skip a permission check.
   */
  async purgeForUser(
    userId: string,
    messages: QuoteMessageDeleter,
  ): Promise<QuotePurgeResult> {
    const idForms = userIdMatchForms(userId);

    // The authored half and the anonymisation are independent policies on
    // the same collection, so the lookup that only the first one needs must
    // not be able to skip the second (#916).
    let authored: IQuote[] = [];
    let messagesAttempted = 0;
    let messagesDeleted = 0;
    let messagesFailed = 0;
    let deleted = 0;
    let deleteError: string | undefined;

    try {
      authored = await this.model.find({ authorId: { $in: idForms } });
    } catch (error) {
      deleteError = getErrorMessage(error);
      logger.error(`Failed to look up quotes authored by ${userId}:`, error);
    }

    // Rows whose post is confirmed gone — or that never had one. Only these
    // are deleted below: the row holds the only `messageId`/`postChannelId`
    // by which a post can be found, so deleting it after a failed delete
    // strands the post for good and leaves a retry nothing to work with
    // (#916). The same call the birthday purge makes for a role it could not
    // revoke.
    const clearable: IQuote[] = [];

    for (const quote of authored) {
      if (!quote.messageId) {
        clearable.push(quote);
        continue;
      }
      messagesAttempted++;
      // `messageId` is overloaded: it starts life as the *original* Discord
      // message id and is overwritten by `updateQuoteMessageId` with the
      // quote-channel post id. So it may well point at a message that is not
      // in the quote channel, or is long gone — a miss is expected, and is
      // reported as gone rather than as a failure.
      try {
        if (
          await messages.deleteQuoteMessage(
            quote.messageId,
            quote.postChannelId,
          )
        ) {
          messagesDeleted++;
          clearable.push(quote);
        } else {
          messagesFailed++;
          logger.warn(
            `Quote message ${quote.messageId} could not be deleted while purging user ${userId}; keeping the row so a retry can still find the post`,
          );
        }
      } catch (error) {
        messagesFailed++;
        logger.warn(
          `Could not delete quote message ${quote.messageId} while purging user ${userId}; keeping the row so a retry can still find the post:`,
          error,
        );
      }
    }

    // Each write stands on its own, and by this point Discord posts have
    // already been deleted — so none of them may take the whole call down
    // and leave the caller believing nothing happened (#916).
    // `$or: []` is rejected by MongoDB, and a member who only ever saved
    // other people's quotes has an empty snapshot — so the delete is skipped
    // rather than issued with a filter the server refuses.
    if (!deleteError && clearable.length > 0) {
      try {
        // By `_id` *and* the `messageId` we inspected, not by a fresh
        // `authorId` re-match (#916). Two orderings to survive:
        //
        //  - a quote created *after* the snapshot would be deleted by an
        //    `authorId` re-match without its post ever being inspected, so
        //    the ids pin the delete to what we actually looked at;
        //  - a quote whose post went up *between* the snapshot and here has
        //    a new `messageId`, and deleting it would strand that post with
        //    no row pointing at it. Matching on the old value means such a
        //    row does not match, and `deleteQuoteMessage` on the caller's
        //    side never saw the post — so the row survives with its cleanup
        //    metadata and the next purge collects both.
        const removal = await this.model.deleteMany({
          $or: clearable.map((quote) => ({
            _id: quote._id,
            messageId: quote.messageId ?? null,
          })),
        });
        deleted = removal?.deletedCount ?? 0;
        if (deleted < clearable.length) {
          const stranded = clearable.length - deleted;
          deleteError = `${stranded} quote(s) were published while the purge ran and were left in place rather than orphaning their channel posts; run the reset again to clear them`;
          logger.warn(
            `Purge for ${userId}: ${stranded} quote row(s) changed mid-purge and were kept`,
          );
        }
      } catch (error) {
        deleteError = getErrorMessage(error);
        logger.error(`Failed to delete quotes authored by ${userId}:`, error);
      }
    }

    if (!deleteError && messagesFailed > 0) {
      deleteError = `${messagesFailed} quote(s) were kept because their channel post could not be deleted; the row is the only handle left on that post, so a retry can still remove both`;
    }

    let anonymised = 0;
    let anonymiseError: string | undefined;
    let attributionsRerendered = 0;
    let attributionsStale = 0;
    let attributionsGone = 0;

    // Snapshot the rows this pass will act on. Everything below works from
    // it: the posts are redrawn from these values, and the write is pinned
    // to exactly these rows as they were read.
    let saved: IQuote[] = [];
    try {
      saved = await this.model.find({ addedById: { $in: idForms } });
    } catch (error) {
      anonymiseError = getErrorMessage(error);
      logger.error(
        `Failed to find the quotes ${userId} saved for others:`,
        error,
      );
    }

    // Posts first, rows second (#916). The sentinel is what makes a row
    // invisible to the next purge, so writing it before the post is repaired
    // means anything that goes wrong in between — a rejected edit, a lost
    // acknowledgement, the process dying — leaves an embed naming the member
    // with nothing left that could ever select it again. Redrawing first can
    // only show the sentinel on a post slightly before the database catches
    // up, and the row stays selectable until it does.
    // Only rows whose post no longer names the member get the sentinel
    // below. The sentinel is what makes a row invisible to the next purge,
    // so writing it over a post that still credits them would leave that
    // embed standing with nothing able to select it again (#916).
    const repaired: IQuote[] = [];

    for (const quote of saved) {
      if (!quote.messageId) {
        repaired.push(quote);
        continue;
      }
      try {
        await messages.updateQuoteMessage(
          quote.messageId,
          quote._id.toString(),
          quote.content,
          quote.authorId,
          ANONYMISED_USER_ID,
          quote.postChannelId,
        );
        attributionsRerendered++;
        repaired.push(quote);
      } catch (error) {
        if (isMissingPostError(error)) {
          // Nothing to re-render and nothing on screen: the post, or the
          // whole quote channel, is gone. Counting it as stale would keep
          // the purge report failing over a member's name that no longer
          // appears anywhere (#916).
          attributionsGone++;
          repaired.push(quote);
          continue;
        }
        // The embed still names them, so the row keeps the real saver and
        // stays selectable: anonymising it would make the post unfindable.
        attributionsStale++;
        logger.warn(
          `Could not re-render quote post ${quote.messageId} while anonymising ${userId}; keeping the row so a retry can still repair it:`,
          error,
        );
      }
    }

    if (!anonymiseError && repaired.length > 0) {
      try {
        // Pinned to the rows just inspected, and to the `messageId` each one
        // had when its post was redrawn — the same CAS the authored delete
        // uses. A row that gained a post in between does not match, so it
        // keeps the real saver and stays selectable, and the next purge
        // redraws *that* post before clearing it. Anonymising it here would
        // leave a fresh post crediting the member with a sentinel row no
        // retry can find.
        const anonymisation = await this.model.updateMany(
          {
            $or: repaired.map((quote) => ({
              _id: quote._id,
              messageId: quote.messageId ?? null,
            })),
          },
          { $set: { addedById: ANONYMISED_USER_ID } },
        );
        anonymised = anonymisation?.modifiedCount ?? 0;
        if (anonymised < repaired.length) {
          const kept = repaired.length - anonymised;
          anonymiseError = `${kept} quote(s) the member saved changed while the purge ran and were left attributed rather than stranding a fresh post; run the reset again to clear them`;
          logger.warn(
            `Purge for ${userId}: ${kept} saved-quote row(s) changed mid-purge and were kept`,
          );
        }
      } catch (error) {
        anonymiseError = getErrorMessage(error);
        logger.error(
          `Failed to clear the saver attribution of ${userId}:`,
          error,
        );
      }
    }

    const result: QuotePurgeResult = {
      authored: authored.length,
      deleted,
      deleteError,
      messagesAttempted,
      messagesDeleted,
      messagesFailed,
      saverMatched: saved.length,
      anonymised,
      attributionsRerendered,
      attributionsStale,
      attributionsGone,
      anonymiseError,
    };

    logger.info(
      `Purged quotes for user ${userId}: deleted ${result.deleted} row(s) and ${result.messagesDeleted} channel post(s) ` +
        `(${result.messagesFailed} post(s) could not be deleted), anonymised ${result.anonymised} row(s) ` +
        `and re-rendered ${result.attributionsRerendered} post(s) ` +
        `(${result.attributionsGone} post(s) already gone, ${result.attributionsStale} still naming them)`,
    );
    return result;
  }

  /**
   * Get the count of quotes added by a specific user
   * Handles legacy quote data with various ID formats (<@123>, <@!123>, @123, 123)
   */
  async getQuotesAddedByUser(userId: string): Promise<number> {
    return this.model.countDocuments({
      addedById: { $in: userIdMatchForms(userId) },
    });
  }

  /**
   * Get the count of quotes where a specific user is the author (being quoted)
   * Handles legacy quote data with various ID formats (<@123>, <@!123>, @123, 123)
   */
  async getQuotesAuthoredByUser(userId: string): Promise<number> {
    return this.model.countDocuments({
      authorId: { $in: userIdMatchForms(userId) },
    });
  }

  /**
   * Get the most liked quote for a specific author
   * Handles legacy quote data with various ID formats
   */
  async getMostLikedQuoteByAuthor(authorId: string): Promise<IQuote | null> {
    return this.model
      .findOne({ authorId: { $in: userIdMatchForms(authorId) } })
      .sort({ likes: -1 });
  }

  /**
   * Check if user has a quote with at least the specified number of likes
   * Handles legacy quote data with various ID formats
   */
  async hasQuoteWithLikes(
    authorId: string,
    minLikes: number,
  ): Promise<boolean> {
    const count = await this.model.countDocuments({
      authorId: { $in: userIdMatchForms(authorId) },
      likes: { $gte: minLikes },
    });
    return count > 0;
  }
}

export const quoteService = new QuoteService();
