import { Model, Document, model } from "mongoose";
import { quoteSchema } from "../database/schema.js";
import { ConfigService } from "./config-service.js";
import { CooldownManager } from "./cooldown-manager.js";

const configService = ConfigService.getInstance();

interface IQuote extends Document {
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
}

export const quoteService = new QuoteService();
