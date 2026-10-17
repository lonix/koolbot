import { it, expect, beforeAll, beforeEach } from "@jest/globals";
import { describeWithMongo, useRealMongo } from "./mongo-harness.js";
import { Event } from "../../src/models/event.js";
import { EventImage } from "../../src/models/event-image.js";
import {
  removeEventCover,
  setEventCover,
} from "../../src/services/event-cover.js";

/**
 * Cover set and remove use aggregation-pipeline updates, which Mongoose 9
 * rejects unless `updatePipeline: true` is passed (#1103). The unit tests mock
 * the model, so they only see the options handed to a stub; these run the real
 * functions against a real server and assert the stored rows and image.
 */
describeWithMongo("event cover updates against a real MongoDB (#1181)", () => {
  useRealMongo();

  const png = (tag: string): Buffer =>
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from(tag),
    ]);

  beforeAll(async () => {
    await Promise.all([Event.init(), EventImage.init()]);
  });

  beforeEach(async () => {
    await Promise.all([Event.deleteMany({}), EventImage.deleteMany({})]);
  });

  async function makeEvent(extra: Record<string, unknown> = {}) {
    return Event.create({
      guildId: "guild-1",
      title: "Game night",
      startTime: new Date(Date.now() + 3_600_000),
      createdBy: "host",
      ...extra,
    });
  }

  it("sets, replaces and removes a cover, updating the row and the image", async () => {
    const event = await makeEvent();

    const first = await setEventCover(event, png("A"));
    expect(first.ok).toBe(true);
    let row = await Event.findById(event._id).lean();
    expect(row?.coverHash).toBe(first.ok ? first.hash : "");
    expect(await EventImage.countDocuments({ key: String(event._id) })).toBe(1);

    const second = await setEventCover(event, png("B"));
    expect(second.ok && first.ok && second.hash !== first.hash).toBe(true);
    row = await Event.findById(event._id).lean();
    expect(row?.coverHash).toBe(second.ok ? second.hash : "");
    expect(await EventImage.countDocuments({ key: String(event._id) })).toBe(1);

    expect(await removeEventCover(event)).toEqual({ ok: true });
    row = await Event.findById(event._id).lean();
    expect(row?.coverHash).toBeNull();
    expect(row?.nativeCoverAttempts).toBe(0);
    expect(await EventImage.countDocuments({ key: String(event._id) })).toBe(0);
  });

  it("applies to every row of a series but never to an adopted row", async () => {
    const a = await makeEvent({ seriesId: "series-1", recurrence: "weekly" });
    const b = await makeEvent({
      seriesId: "series-1",
      recurrence: "weekly",
      occurrenceIndex: 1,
    });
    const adopted = await makeEvent({
      seriesId: "series-1",
      recurrence: "weekly",
      occurrenceIndex: 2,
      nativeAdopted: true,
    });
    const result = await setEventCover(a, png("S"));
    const hash = result.ok ? result.hash : "";
    expect((await Event.findById(a._id).lean())?.coverHash).toBe(hash);
    expect((await Event.findById(b._id).lean())?.coverHash).toBe(hash);
    expect((await Event.findById(adopted._id).lean())?.coverHash).toBeNull();
  });

  it("a removal keeps one pending attempt after failed sends, and a re-upload forgets the last-sent hash", async () => {
    const event = await makeEvent({
      coverHash: "hash-b",
      nativeCoverHash: "hash-a",
      nativeCoverAttempts: 2,
    });
    // Failed sends: removal keeps one pending attempt so a clear is still sent.
    await removeEventCover(event);
    let row = await Event.findById(event._id).lean();
    expect(row?.coverHash).toBeNull();
    expect(row?.nativeCoverAttempts).toBe(1);
    expect(row?.nativeCoverHash).toBe("hash-a");

    // Failed send of B after A was confirmed, then A uploaded again: the
    // recorded hash is dropped so the next scan re-sends A.
    await Event.updateOne(
      { _id: event._id },
      { $set: { nativeCoverHash: "hash-a", nativeCoverAttempts: 1 } },
    );
    await setEventCover(event, png("A"));
    row = await Event.findById(event._id).lean();
    expect(row?.nativeCoverHash).toBeNull();
    expect(row?.nativeCoverAttempts).toBe(0);
    expect(row?.coverHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
