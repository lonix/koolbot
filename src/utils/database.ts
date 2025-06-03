import { MongoClient } from "mongodb";
import logger from "./logger.js";

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017";
const client = new MongoClient(MONGODB_URI);

export async function connectToDatabase() {
  try {
    await client.connect();
    logger.info("Connected to MongoDB");
    return client.db("koolbot");
  } catch (error) {
    logger.error("Error connecting to MongoDB:", error);
    throw error;
  }
}

export async function closeDatabaseConnection() {
  try {
    await client.close();
    logger.info("Closed MongoDB connection");
  } catch (error) {
    logger.error("Error closing MongoDB connection:", error);
    throw error;
  }
}
