import { it, expect, beforeAll, beforeEach } from "@jest/globals";
import { describeWithMongo, useRealMongo } from "./mongo-harness.js";
import { Event } from "../../src/models/event.js";
import { listHostedEvents } from "../../src/web/event-host.js";

/**
 * The "Events you host" lookup (#1189) filters on `nativeCleanupOnly` and
 * `nativeAdopted` with `$ne: true`. Events written before those fields existed
 * have neither, and the unit tests mock the model, so only a real server shows
 * that such a row is still listed while the flagged ones are not. Rows are
 * written with the raw driver so no schema default is added.
 */
describeWithMongo(
  "host panel event lookup against a real MongoDB (#1189)",
  () => {
    useRealMongo();

    beforeAll(async () => {
      await Event.init();
    });

    beforeEach(async () => {
      await Event.deleteMany({});
    });

    const row = (over: Record<string, unknown>): Record<string, unknown> => ({
      guildId: "guild-1",
      title: "Game night",
      description: "",
      startTime: new Date(Date.now() + 3_600_000),
      timezone: "UTC",
      durationMinutes: 120,
      categoryId: "",
      channelId: null,
      state: "scheduled",
      reminderSent: false,
      rsvps: [],
      recurrence: "none",
      createdBy: "host-1",
      ...over,
    });

    it("lists only this member's open events in this guild, including rows without the newer flags", async () => {
      await Event.collection.insertMany([
        row({ title: "Old row, no flags" }),
        row({ title: "Active", state: "active" }),
        row({ title: "Ended", state: "ended" }),
        row({ title: "Cancelled", state: "cancelled" }),
        row({ title: "Someone else", createdBy: "host-2" }),
        row({ title: "Other guild", guildId: "guild-2" }),
        row({ title: "Cleanup only", nativeCleanupOnly: true }),
        row({ title: "Adopted", nativeAdopted: true }),
        row({
          title: "Explicit false",
          nativeAdopted: false,
          nativeCleanupOnly: false,
        }),
      ]);
      const listed = await listHostedEvents("guild-1", "host-1");
      expect(listed.map((e) => e.title).sort()).toEqual([
        "Active",
        "Explicit false",
        "Old row, no flags",
      ]);
    });

    it("returns the soonest first and caps the list at ten", async () => {
      const base = Date.now() + 3_600_000;
      await Event.collection.insertMany(
        Array.from({ length: 12 }, (_, i) =>
          row({
            title: `E${i}`,
            startTime: new Date(base + (11 - i) * 60_000),
          }),
        ),
      );
      const listed = await listHostedEvents("guild-1", "host-1");
      expect(listed).toHaveLength(10);
      expect(listed[0].title).toBe("E11");
      expect(listed[9].title).toBe("E2");
    });
  },
);
