import { describe, it, expect, jest } from "@jest/globals";

/**
 * Set and remove of one series' cover are serialised across BOTH of their
 * writes (the image document and the row hashes), so a remove cannot delete a
 * newer upload's image and two uploads cannot leave the rows naming the older
 * one (#1181).
 */

const log: string[] = [];
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const upsert = jest.fn(async (...a: unknown[]) => {
  const label = String((a[1] as { $set: { hash: string } }).$set.data);
  log.push(`image:start:${label}`);
  await sleep(15);
  log.push(`image:end:${label}`);
  return {};
});
const deleteOne = jest.fn(async () => {
  log.push("delete:start");
  await sleep(15);
  log.push("delete:end");
  return {};
});
const updateMany = jest.fn(async (...a: unknown[]) => {
  const hash = (a[1] as { $set: { coverHash: string | null } }).$set.coverHash;
  log.push(`rows:start:${hash ? "set" : "null"}`);
  await sleep(15);
  log.push(`rows:end:${hash ? "set" : "null"}`);
  return {};
});

jest.unstable_mockModule("../../src/models/event-image.js", () => ({
  EventImage: { findOneAndUpdate: upsert, deleteOne },
}));
jest.unstable_mockModule("../../src/models/event.js", () => ({
  Event: { updateMany },
}));
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { setEventCover, removeEventCover } =
  await import("../../src/services/event-cover.js");

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const EVENT = {
  _id: "e1",
  guildId: "g1",
  seriesId: "s1",
  state: "scheduled",
  recurrence: "weekly",
  nextSpawned: false,
  seriesCancelled: false,
  nativeAdopted: false,
  nativeCleanupOnly: false,
} as never;

/** No two writes of different calls overlap in time. */
function maxOverlap(): number {
  let cur = 0;
  let max = 0;
  for (const line of log) {
    cur += line.includes(":start") ? 1 : -1;
    max = Math.max(max, cur);
  }
  return max;
}

describe("cover mutations of one series", () => {
  it("run one at a time: set, remove and set again keep their call order", async () => {
    log.length = 0;
    const a = Buffer.concat([PNG, Buffer.from("A")]);
    const b = Buffer.concat([PNG, Buffer.from("B")]);
    await Promise.all([
      setEventCover(EVENT, a),
      removeEventCover(EVENT),
      setEventCover(EVENT, b),
    ]);
    expect(maxOverlap()).toBe(1);
    expect(
      log.filter((l) => l.includes(":start")).map((l) => l.split(":")[0]),
    ).toEqual(["image", "rows", "rows", "delete", "image", "rows"]);
  });

  it("two uploads publish their image and hashes together, in order", async () => {
    log.length = 0;
    const a = Buffer.concat([PNG, Buffer.from("A")]);
    const b = Buffer.concat([PNG, Buffer.from("B")]);
    await Promise.all([setEventCover(EVENT, a), setEventCover(EVENT, b)]);
    expect(maxOverlap()).toBe(1);
    // Image A and rows A are done before image B starts (so the final image
    // and the final hashes are both B's).
    expect(log.indexOf("rows:end:set")).toBeLessThan(
      log.findIndex((l, i) => i > 3 && l.startsWith("image:start")),
    );
  });
});
