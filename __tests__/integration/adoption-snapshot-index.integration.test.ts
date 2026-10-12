import { it, expect, beforeAll, beforeEach } from "@jest/globals";
import { describeWithMongo, useRealMongo } from "./mongo-harness.js";
import { AdoptionSnapshot } from "../../src/models/adoption-snapshot.js";
import {
  BUSY_MESSAGE,
  MongoAdoptionStore,
} from "../../src/services/server-adoption-service.js";

/**
 * A duplicate `guildId` index definition made Mongoose silently drop the
 * unique partial index, so the "one active apply per server" lock was never
 * created (#1102). A mock cannot show whether the constraint exists; this
 * builds the indexes on a real server and trips it.
 */
describeWithMongo(
  "AdoptionSnapshot indexes against a real MongoDB (#1102)",
  () => {
    useRealMongo();

    beforeAll(async () => {
      await AdoptionSnapshot.init();
    });

    beforeEach(async () => {
      await AdoptionSnapshot.deleteMany({});
    });

    const snapshot = (guildId: string, active: boolean) => ({
      planId: `plan-${Math.random()}`,
      guildId,
      appliedBy: "admin",
      status: active ? "applying" : "applied",
      plan: {},
      baseline: {},
      active,
    });

    it("creates the unique partial index on { guildId, active }", async () => {
      const indexes = await AdoptionSnapshot.collection.indexes();
      const lock = indexes.find(
        (i) => i.key && i.key.guildId === 1 && i.key.active === 1,
      );
      expect(lock).toBeDefined();
      expect(lock?.unique).toBe(true);
      expect(lock?.partialFilterExpression).toEqual({ active: true });
    });

    it("rejects a second active snapshot for the same guild with 11000", async () => {
      await AdoptionSnapshot.create(snapshot("guild-1", true));
      await expect(
        AdoptionSnapshot.create(snapshot("guild-1", true)),
      ).rejects.toMatchObject({ code: 11000 });
    });

    it("accepts inactive snapshots and active ones for other guilds", async () => {
      await AdoptionSnapshot.create(snapshot("guild-1", true));
      await AdoptionSnapshot.create(snapshot("guild-1", false));
      await AdoptionSnapshot.create(snapshot("guild-1", false));
      await AdoptionSnapshot.create(snapshot("guild-2", true));
      expect(await AdoptionSnapshot.countDocuments({})).toBe(4);
    });

    it("makes MongoAdoptionStore.create take the busy path", async () => {
      const store = new MongoAdoptionStore();
      const record = (guildId: string) =>
        ({
          planId: `plan-${Math.random()}`,
          guildId,
          appliedBy: "admin",
          status: "applying",
          plan: {},
          baseline: {},
          operations: [],
          createdRoles: [],
          restoredChannels: [],
          restoredRoles: [],
          restoreIntents: [],
          configOverrides: {},
          rolledBackOps: [],
          memberProgress: {},
          rolledBackAt: null,
        }) as unknown as Parameters<MongoAdoptionStore["create"]>[0];

      await store.create(record("guild-1"));
      await expect(store.create(record("guild-1"))).rejects.toThrow(
        BUSY_MESSAGE,
      );
    });
  },
);
