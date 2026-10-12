import mongoose from "mongoose";
import { afterAll, beforeAll, describe } from "@jest/globals";

/**
 * Shared setup for the real-MongoDB integration suites (#1106).
 *
 * These run under `jest.integration.config.js`, which does not load
 * `__tests__/setup.ts`, so `mongoose` here is the real driver. Each suite gets
 * its own throwaway database on the server named by `MONGODB_URI`, dropped
 * afterwards, so a developer's own data in the same server is never touched.
 */
export const MONGODB_URI = process.env.MONGODB_URI;

/** `describe` when `MONGODB_URI` is set, otherwise a clean skip. */
export const describeWithMongo = MONGODB_URI ? describe : describe.skip;

export function useRealMongo(): void {
  beforeAll(async () => {
    const dbName = `koolbot_it_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    await mongoose.connect(MONGODB_URI as string, { dbName });
  });

  afterAll(async () => {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
    }
    await mongoose.disconnect();
  });
}
