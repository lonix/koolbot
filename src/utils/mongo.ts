/**
 * Shared MongoDB connection tracking for the services that persist their own
 * data (activity trackers, achievements, …).
 *
 * Each of those services used to carry a byte-identical pair of
 * `setupMongoConnectionHandlers()` / `ensureConnection()` methods, differing
 * only in the service name inside the log lines — and each re-inlined the
 * default connection URI, so the fallback lived in five places (#851).
 *
 * `MongoConnectionGuard` owns the `connected` flag, the `mongoose.connection`
 * listeners that maintain it, and the reconnect. Construct one per service:
 *
 * ```ts
 * private mongo = new MongoConnectionGuard("voice channel tracker");
 * // …then, before a query:
 * await this.mongo.ensureConnection();
 * ```
 */

import mongoose from "mongoose";
import { ConfigService } from "../services/config-service.js";
import { DEFAULT_MONGODB_URI } from "../config/env.js";
import logger from "./logger.js";

export class MongoConnectionGuard {
  private connected = false;

  /**
   * @param label Human-readable service name used in the log lines, e.g.
   * `"voice channel tracker"`.
   */
  constructor(private readonly label: string) {
    this.registerConnectionHandlers();
  }

  /** Whether the last observed connection event left the driver connected. */
  public get isConnected(): boolean {
    return this.connected;
  }

  private registerConnectionHandlers(): void {
    mongoose.connection.on("connected", () => {
      this.connected = true;
      logger.info(`MongoDB connection established for ${this.label}`);
    });

    mongoose.connection.on("disconnected", () => {
      this.connected = false;
      logger.warn(`MongoDB connection lost for ${this.label}`);
    });

    mongoose.connection.on("error", (error: Error) => {
      this.connected = false;
      logger.error(`MongoDB connection error in ${this.label}:`, error);
    });
  }

  /**
   * Reconnect if the connection was lost. A no-op while connected, so it is
   * cheap to call before every query.
   */
  public async ensureConnection(): Promise<void> {
    if (this.connected) return;

    try {
      const uri = await ConfigService.getInstance().getString(
        "MONGODB_URI",
        DEFAULT_MONGODB_URI,
      );
      await mongoose.connect(uri);
      logger.info(`Reconnected to MongoDB for ${this.label}`);
    } catch (error: unknown) {
      logger.error("Error reconnecting to MongoDB:", error);
      throw error;
    }
  }
}
