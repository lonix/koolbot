#!/usr/bin/env node
/**
 * Test script to validate MongoDB connection without Discord
 * Used in CI/CD to verify database connectivity
 */

import mongoose from "mongoose";
import { config as dotenvConfig } from "dotenv";
import logger from "../utils/logger.js";

dotenvConfig();

const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://mongodb:27017/koolbot";
const TIMEOUT_MS = 30000; // 30 seconds

async function testMongoDBConnection(): Promise<void> {
  console.log("=== MongoDB Connection Test ===");
  console.log(`Connecting to: ${MONGODB_URI}`);

  try {
    // Set connection timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Connection timeout after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);
    });

    // Attempt to connect to MongoDB
    const connectPromise = mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
    });

    await Promise.race([connectPromise, timeoutPromise]);

    console.log("✓ Successfully connected to MongoDB");
    console.log(`Connection state: ${mongoose.connection.readyState}`);
    console.log(`Database name: ${mongoose.connection.db?.databaseName}`);

    // Test basic database operations
    console.log("\n=== Testing Database Operations ===");

    // Ping the database
    const pingResult = await mongoose.connection.db?.admin().ping();
    console.log("✓ Database ping successful:", pingResult);

    // List collections (should work even if empty)
    const collections = await mongoose.connection.db
      ?.listCollections()
      .toArray();
    console.log(`✓ Found ${collections?.length || 0} collections`);

    // Test write operation by creating a test document
    const TestSchema = new mongoose.Schema({
      testField: String,
      timestamp: Date,
    });
    const TestModel = mongoose.model("CiTest", TestSchema);

    const testDoc = new TestModel({
      testField: "ci-test",
      timestamp: new Date(),
    });

    await testDoc.save();
    console.log("✓ Successfully created test document");

    // Read back the document
    const foundDoc = await TestModel.findOne({ testField: "ci-test" });
    if (foundDoc) {
      console.log("✓ Successfully retrieved test document");
    } else {
      throw new Error("Failed to retrieve test document");
    }

    // Clean up test document
    await TestModel.deleteMany({ testField: "ci-test" });
    console.log("✓ Successfully cleaned up test document");

    console.log("\n=== All MongoDB Tests Passed ===");

    // Close connection
    await mongoose.connection.close();
    console.log("✓ Connection closed successfully");

    process.exit(0);
  } catch (error) {
    console.error("\n❌ MongoDB Connection Test Failed");
    console.error("Error:", error);
    logger.error("MongoDB connection test failed:", error);

    // Try to close connection if it was opened
    try {
      if (mongoose.connection.readyState !== 0) {
        await mongoose.connection.close();
      }
    } catch (closeError) {
      console.error("Error closing connection:", closeError);
    }

    process.exit(1);
  }
}

// Run the test
testMongoDBConnection();
