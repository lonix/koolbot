import { Model } from 'mongoose';
import { quoteSchema } from '../database/schema.js';
import { ConfigService } from './config-service.js';
import { CooldownManager } from './cooldown-manager.js';
import mongoose from 'mongoose';

const configService = ConfigService.getInstance();

export class QuoteService {
  private model: Model<any>;
  private cooldownManager: CooldownManager;

  constructor() {
    this.model = mongoose.model('Quote', quoteSchema);
    this.cooldownManager = new CooldownManager();
  }

  async addQuote(content: string, authorId: string, addedById: string, channelId: string, messageId: string): Promise<any> {
    // Check if quotes are enabled
    const enabled = await configService.get<boolean>('quotes.enabled');
    if (!enabled) {
      throw new Error('Quote system is disabled');
    }

    // Check cooldown
    const cooldown = await configService.get<number>('quotes.cooldown');
    if (this.cooldownManager.isOnCooldown(addedById, 'quote_add', cooldown)) {
      throw new Error(`Please wait ${cooldown} seconds before adding another quote`);
    }

    // Check quote length
    const maxLength = await configService.get<number>('quotes.max_length');
    if (content.length > maxLength) {
      throw new Error(`Quote is too long. Maximum length is ${maxLength} characters`);
    }

    const quote = new this.model({
      content,
      authorId,
      addedById,
      channelId,
      messageId,
      createdAt: new Date(),
      addedAt: new Date()
    });

    await quote.save();
    this.cooldownManager.setCooldown(addedById, 'quote_add');
    return quote;
  }

  async getRandomQuote(): Promise<any> {
    const count = await this.model.countDocuments();
    if (count === 0) {
      throw new Error('No quotes available');
    }

    const random = Math.floor(Math.random() * count);
    return this.model.findOne().skip(random);
  }

  async searchQuotes(query: string): Promise<any[]> {
    return this.model.find({
      content: { $regex: query, $options: 'i' }
    }).limit(10);
  }

  async deleteQuote(quoteId: string, userId: string, userRoles: string[]): Promise<void> {
    const quote = await this.model.findById(quoteId);
    if (!quote) {
      throw new Error('Quote not found');
    }

    // Check if user has permission to delete
    const deleteRoles = (await configService.get<string>('quotes.delete_roles')).split(',').filter(Boolean);
    const hasPermission = deleteRoles.length === 0 || // Empty means only admins
      userRoles.some(role => deleteRoles.includes(role)) ||
      quote.addedById === userId; // Allow users to delete their own quotes

    if (!hasPermission) {
      throw new Error('You do not have permission to delete quotes');
    }

    await this.model.findByIdAndDelete(quoteId);
  }

  async likeQuote(quoteId: string, userId: string): Promise<void> {
    await this.model.findByIdAndUpdate(quoteId, { $inc: { likes: 1 } });
  }

  async dislikeQuote(quoteId: string, userId: string): Promise<void> {
    await this.model.findByIdAndUpdate(quoteId, { $inc: { dislikes: 1 } });
  }
}

export const quoteService = new QuoteService();
