import { describe, it, expect, jest, beforeEach } from "@jest/globals";

const imageFind = jest.fn();
const imageDeleteOne = jest.fn<(...a: unknown[]) => Promise<unknown>>(
  async () => ({}),
);
const imageFindOne = jest.fn();
const eventExists = jest.fn();
const eventUpdateMany = jest.fn<(...a: unknown[]) => Promise<unknown>>(
  async () => ({}),
);

jest.unstable_mockModule("../../src/models/event-image.js", () => ({
  EventImage: {
    find: imageFind,
    deleteOne: imageDeleteOne,
    findOne: imageFindOne,
    findOneAndUpdate: jest.fn(),
  },
}));
jest.unstable_mockModule("../../src/models/event.js", () => ({
  Event: { exists: eventExists, updateMany: eventUpdateMany },
}));
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const {
  COVER_MAX_BYTES,
  sniffCoverImage,
  validateCoverImage,
  coverIneligibleReason,
  coverKeyFor,
  loadEventCover,
  sweepOrphanCovers,
} = await import("../../src/services/event-cover.js");

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF = Buffer.from("GIF89a\u0001\u0000", "latin1");

beforeEach(() => jest.clearAllMocks());

describe("sniffCoverImage / validateCoverImage", () => {
  it("recognises PNG, JPEG and GIF by their signature", () => {
    expect(sniffCoverImage(PNG)).toBe("image/png");
    expect(sniffCoverImage(JPEG)).toBe("image/jpeg");
    expect(sniffCoverImage(GIF)).toBe("image/gif");
    expect(sniffCoverImage(Buffer.from("GIF87a....", "latin1"))).toBe(
      "image/gif",
    );
  });

  it.each([
    ["HTML", Buffer.from("<html><body>x</body></html>")],
    ["SVG", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ["WebP", Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBP", "latin1")],
    ["a truncated PNG header", PNG.subarray(0, 4)],
    ["an almost-GIF", Buffer.from("GIF90a", "latin1")],
    ["plain text", Buffer.from("hello world")],
  ])("rejects %s", (_name, data) => {
    expect(sniffCoverImage(data)).toBeNull();
    const result = validateCoverImage(data);
    expect(result.ok).toBe(false);
  });

  it("accepts a valid image and returns a stable SHA-256 hash", () => {
    const a = validateCoverImage(PNG);
    const b = validateCoverImage(Buffer.from(PNG));
    expect(a).toMatchObject({ ok: true, mime: "image/png" });
    expect(a.ok && b.ok && a.hash === b.hash).toBe(true);
    expect(a.ok && a.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("enforces the size cap exactly", () => {
    const atCap = Buffer.concat([
      PNG,
      Buffer.alloc(COVER_MAX_BYTES - PNG.length),
    ]);
    expect(atCap.length).toBe(COVER_MAX_BYTES);
    expect(validateCoverImage(atCap).ok).toBe(true);
    const over = Buffer.concat([atCap, Buffer.alloc(1)]);
    const result = validateCoverImage(over);
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toContain("too large");
  });

  it("rejects an empty body", () => {
    expect(validateCoverImage(Buffer.alloc(0))).toMatchObject({ ok: false });
  });
});

describe("coverIneligibleReason", () => {
  const base = {
    state: "scheduled",
    nativeAdopted: false,
    nativeCleanupOnly: false,
    recurrence: "none",
    nextSpawned: false,
    seriesCancelled: false,
  } as never;

  it("allows a live event", () => {
    expect(coverIneligibleReason(base)).toBeNull();
    expect(
      coverIneligibleReason({ ...(base as object), state: "active" } as never),
    ).toBeNull();
  });

  it("refuses an adopted event, saying its cover stays in Discord", () => {
    expect(
      coverIneligibleReason({
        ...(base as object),
        nativeAdopted: true,
      } as never),
    ).toContain("managed in Discord");
  });

  it("refuses finished events, but not an occurrence awaiting its successor", () => {
    const ended = { ...(base as object), state: "ended" };
    expect(coverIneligibleReason(ended as never)).toContain("finished");
    expect(
      coverIneligibleReason({ ...ended, recurrence: "weekly" } as never),
    ).toBeNull();
    expect(
      coverIneligibleReason({
        ...ended,
        recurrence: "weekly",
        seriesCancelled: true,
      } as never),
    ).toContain("finished");
    expect(
      coverIneligibleReason({
        ...(base as object),
        nativeCleanupOnly: true,
      } as never),
    ).not.toBeNull();
  });
});

describe("keys and loading", () => {
  it("keys a series by its id and a one-off by its own id", () => {
    expect(coverKeyFor({ _id: "e1", seriesId: "s1" } as never)).toBe("s1");
    expect(coverKeyFor({ _id: "e1", seriesId: null } as never)).toBe("e1");
  });

  it("builds a data URI labelled with the stored type, not image/jpg", async () => {
    imageFindOne.mockResolvedValue({ hash: "h", mime: "image/png", data: PNG });
    const cover = await loadEventCover({
      _id: "e1",
      seriesId: null,
      guildId: "g1",
    } as never);
    expect(cover).toEqual({
      hash: "h",
      dataUri: `data:image/png;base64,${PNG.toString("base64")}`,
    });
    imageFindOne.mockResolvedValue(null);
    expect(
      await loadEventCover({
        _id: "e1",
        seriesId: null,
        guildId: "g1",
      } as never),
    ).toBeNull();
  });
});

describe("sweepOrphanCovers", () => {
  function images(...keys: string[]): void {
    imageFind.mockReturnValue({
      select: () => ({ lean: async () => keys.map((key) => ({ key })) }),
    });
  }

  it("does nothing when there are no images", async () => {
    images();
    expect(await sweepOrphanCovers("g1")).toBe(0);
    expect(eventExists).not.toHaveBeenCalled();
  });

  it("keeps the image of a live series and removes the image of a finished one", async () => {
    images("live", "done");
    eventExists.mockImplementation(async (...a: unknown[]) => {
      const q = a[0] as { $and: Array<{ $or: Array<{ _id?: string }> }> };
      return q.$and[0].$or[0]._id === "live" ? { _id: "x" } : null;
    });
    expect(await sweepOrphanCovers("g1")).toBe(1);
    expect(imageDeleteOne).toHaveBeenCalledTimes(1);
    expect(imageDeleteOne).toHaveBeenCalledWith({ guildId: "g1", key: "done" });
    // Rows still naming the removed image let go of it.
    expect(eventUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ guildId: "g1" }),
      { $set: { coverHash: null } },
    );
  });

  it("counts a series awaiting its successor as live", async () => {
    images("s1");
    eventExists.mockResolvedValue({ _id: "x" });
    await sweepOrphanCovers("g1");
    const q = eventExists.mock.calls[0][0] as { $and: unknown[] };
    expect(JSON.stringify(q)).toContain('"nextSpawned":false');
    expect(imageDeleteOne).not.toHaveBeenCalled();
  });
});
