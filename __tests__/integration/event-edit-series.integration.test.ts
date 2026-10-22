import { it, expect, beforeAll, beforeEach } from "@jest/globals";
import { describeWithMongo, useRealMongo } from "./mongo-harness.js";
import { Event } from "../../src/models/event.js";
import { seriesWriteFilter } from "../../src/services/event-edit.js";

/**
 * The conditional write of a recurring-event edit (#1298) matches the stored
 * series template field by field. The unit and route tests run it against a
 * fake that interprets the filter; this runs the real `seriesWriteFilter`
 * output through a real server, with a hydrated row, so dotted paths, `null`
 * for a missing template and the empty-string cases are the server's own.
 */
describeWithMongo("series edit write filter against a real MongoDB", () => {
  useRealMongo();

  beforeAll(async () => {
    await Event.init();
  });
  beforeEach(async () => {
    await Event.deleteMany({});
  });

  const make = (extra: Record<string, unknown> = {}) =>
    Event.create({
      guildId: "guild-1",
      title: "Game night",
      startTime: new Date("2030-01-04T20:00:00Z"),
      seriesStart: new Date("2030-01-04T20:00:00Z"),
      recurrence: "weekly",
      seriesId: "s1",
      createdBy: "host",
      ...extra,
    });

  const write = async (
    stale: Awaited<ReturnType<typeof make>>,
    id: unknown,
  ): Promise<unknown> =>
    Event.findOneAndUpdate(
      { _id: id, ...seriesWriteFilter(stale) },
      { $set: { description: "edited" } },
      { new: true },
    );

  it("matches a row with no template, and refuses it once a template was stored", async () => {
    const created = await make();
    const stale = (await Event.findById(created._id))!;
    expect(await write(stale, created._id)).not.toBeNull();

    await Event.updateOne(
      { _id: created._id },
      {
        $set: {
          seriesTemplate: {
            title: "Series renamed",
            description: "d",
            durationMinutes: 90,
            timezone: "UTC",
          },
        },
      },
    );
    // The stale copy saw no template: its save must now be a conflict.
    expect(await write(stale, created._id)).toBeNull();
  });

  it("matches a stored template as read back, and refuses a copy whose template differs", async () => {
    const template = {
      title: "Game night",
      description: "",
      durationMinutes: 120,
      timezone: "UTC",
    };
    const created = await make({ seriesTemplate: template });
    const fresh = (await Event.findById(created._id))!;
    // Hydrated subdocument; an empty description matches as written.
    expect(await write(fresh, created._id)).not.toBeNull();

    await Event.updateOne(
      { _id: created._id },
      { $set: { "seriesTemplate.title": "Renamed for the series" } },
    );
    expect(await write(fresh, created._id)).toBeNull();
  });

  it("refuses a copy whose anchor moved", async () => {
    const created = await make();
    const stale = (await Event.findById(created._id))!;
    await Event.updateOne(
      { _id: created._id },
      { $set: { seriesStart: new Date("2030-01-04T21:00:00Z") } },
    );
    expect(await write(stale, created._id)).toBeNull();
  });
});
