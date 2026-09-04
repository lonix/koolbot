import { Model, Document, model } from "mongoose";
import logger from "../utils/logger.js";

/** A Mongo ObjectId is a 24-character hex string. Matching with a regex avoids
 * importing `mongoose.Types` (which the test suite's mongoose mock omits). */
function isValidObjectId(id: string): boolean {
  return /^[a-f\d]{24}$/i.test(id);
}
import { quoteSchema } from "../database/schema.js";
import { ConfigService } from "./config-service.js";
import { CooldownManager } from "./cooldown-manager.js";

const configService = ConfigService.getInstance();

/**
 * Normalize a Discord user ID from various formats to a clean numeric ID
 * Handles: <@123>, <@!123>, @username, or plain 123
 * Returns the numeric ID or the original string if not parseable
 */
function normalizeUserId(input: string): string {
  // Extract ID from mention formats: <@123> or <@!123>
  const mentionMatch = input.match(/^<@!?(\d+)>$/);
  if (mentionMatch) {
    return mentionMatch[1];
  }

  // Remove leading @ if present
  const cleanInput = input.replace(/^@/, "");

  // If it's a numeric ID, return it
  if (/^\d+$/.test(cleanInput)) {
    return cleanInput;
  }

  // Return original if we can't parse it (might be a username)
  return input;
}

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

  async updateQuoteMessageId(
    quoteId: string,
    messageId: string,
  ): Promise<void> {
    await this.model.findByIdAndUpdate(quoteId, { messageId });
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
    const previousLikes = existing?.likes ?? 0;
    const delta = existing ? nextLikes - previousLikes : 0;

    if (delta === 0) {
      await this.model.findOneAndUpdate({ messageId }, tallies);
      return;
    }

    // Vote writes are debounced and fired without being awaited, so two
    // persists for the same message can overlap. The delta was measured
    // against `previousLikes`, so the write is guarded on that tally still
    // being current: the winner stamps atomically ($push, never a
    // read-modify-write of the array), and a loser — whose delta is now
    // measured against a stale count — records the latest tallies without
    // stamping rather than double-counting or clobbering the history.
    const stamped = await this.model.findOneAndUpdate(
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
    );

    if (!stamped) {
      await this.model.findOneAndUpdate({ messageId }, tallies);
      return;
    }

    await this.pruneLikeEvents(messageId, existing?.likeEvents);
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
   * Get the count of quotes added by a specific user
   * Handles legacy quote data with various ID formats (<@123>, <@!123>, @123, 123)
   */
  async getQuotesAddedByUser(userId: string): Promise<number> {
    const normalizedId = normalizeUserId(userId);
    // Query for both normalized ID and common legacy formats
    return this.model.countDocuments({
      addedById: {
        $in: [
          normalizedId,
          `<@${normalizedId}>`,
          `<@!${normalizedId}>`,
          `@${normalizedId}`,
        ],
      },
    });
  }

  /**
   * Get the count of quotes where a specific user is the author (being quoted)
   * Handles legacy quote data with various ID formats (<@123>, <@!123>, @123, 123)
   */
  async getQuotesAuthoredByUser(userId: string): Promise<number> {
    const normalizedId = normalizeUserId(userId);
    // Query for both normalized ID and common legacy formats
    return this.model.countDocuments({
      authorId: {
        $in: [
          normalizedId,
          `<@${normalizedId}>`,
          `<@!${normalizedId}>`,
          `@${normalizedId}`,
        ],
      },
    });
  }

  /**
   * Get the most liked quote for a specific author
   * Handles legacy quote data with various ID formats
   */
  async getMostLikedQuoteByAuthor(authorId: string): Promise<IQuote | null> {
    const normalizedId = normalizeUserId(authorId);
    return this.model
      .findOne({
        authorId: {
          $in: [
            normalizedId,
            `<@${normalizedId}>`,
            `<@!${normalizedId}>`,
            `@${normalizedId}`,
          ],
        },
      })
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
    const normalizedId = normalizeUserId(authorId);
    const count = await this.model.countDocuments({
      authorId: {
        $in: [
          normalizedId,
          `<@${normalizedId}>`,
          `<@!${normalizedId}>`,
          `@${normalizedId}`,
        ],
      },
      likes: { $gte: minLikes },
    });
    return count > 0;
  }
}

export const quoteService = new QuoteService();
