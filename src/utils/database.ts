import mongoose from 'mongoose';
import { logger } from './logger';

// Connect to MongoDB
export async function connectDB() {
  try {
    const mongoURI = process.env.MONGODB_URI || 'mongodb://localhost:27017/koolbot';
    await mongoose.connect(mongoURI);
    logger.info('Connected to MongoDB');
  } catch (error) {
    logger.error('MongoDB connection error:', error);
    process.exit(1);
  }
}

// User Schema for points and inventory
export interface IUser {
  discordId: string;
  points: number;
  inventory: {
    itemId: string;
    quantity: number;
  }[];
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new mongoose.Schema<IUser>({
  discordId: { type: String, required: true, unique: true },
  points: { type: Number, default: 0 },
  inventory: [{
    itemId: { type: String, required: true },
    quantity: { type: Number, default: 1 }
  }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Shop Item Schema
export interface IShopItem {
  itemId: string;
  name: string;
  description: string;
  price: number;
  stock: number;
  createdAt: Date;
  updatedAt: Date;
}

const shopItemSchema = new mongoose.Schema<IShopItem>({
  itemId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  description: { type: String, required: true },
  price: { type: Number, required: true },
  stock: { type: Number, default: -1 }, // -1 means unlimited
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Transaction Schema for point history
export interface ITransaction {
  userId: string;
  type: 'ADD' | 'REMOVE' | 'PURCHASE' | 'SALE';
  amount: number;
  reason: string;
  createdAt: Date;
}

const transactionSchema = new mongoose.Schema<ITransaction>({
  userId: { type: String, required: true },
  type: { type: String, required: true, enum: ['ADD', 'REMOVE', 'PURCHASE', 'SALE'] },
  amount: { type: Number, required: true },
  reason: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

// Create models
export const User = mongoose.model<IUser>('User', userSchema);
export const ShopItem = mongoose.model<IShopItem>('ShopItem', shopItemSchema);
export const Transaction = mongoose.model<ITransaction>('Transaction', transactionSchema);

// Helper functions
export async function getUserPoints(discordId: string): Promise<number> {
  const user = await User.findOne({ discordId });
  return user?.points || 0;
}

export async function addPoints(discordId: string, amount: number, reason: string): Promise<number> {
  const user = await User.findOneAndUpdate(
    { discordId },
    { $inc: { points: amount } },
    { upsert: true, new: true }
  );

  await Transaction.create({
    userId: discordId,
    type: 'ADD',
    amount,
    reason
  });

  return user.points;
}

export async function removePoints(discordId: string, amount: number, reason: string): Promise<number> {
  const user = await User.findOneAndUpdate(
    { discordId },
    { $inc: { points: -amount } },
    { new: true }
  );

  if (!user) {
    throw new Error('User not found');
  }

  await Transaction.create({
    userId: discordId,
    type: 'REMOVE',
    amount,
    reason
  });

  return user.points;
}
