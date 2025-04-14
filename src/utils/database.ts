import mongoose from "mongoose";
import Logger from "./logger.js";

const logger = Logger.getInstance();

export async function connectToDatabase(): Promise<void> {
  try {
    const uri = process.env.MONGODB_URI || "mongodb://mongodb:27017/koolbot";
    await mongoose.connect(uri);
    logger.info("Connected to MongoDB");
  } catch (error) {
    logger.error("Failed to connect to MongoDB:", error);
    throw error;
  }
} 
