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

  async likeQuote(quoteId: string): Promise<void> {
    await this.model.findByIdAndUpdate(quoteId, { $inc: { likes: 1 } });
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
    await this.model.findOneAndUpdate(
      { messageId },
      { likes: Math.max(0, likes), dislikes: Math.max(0, dislikes) },
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
