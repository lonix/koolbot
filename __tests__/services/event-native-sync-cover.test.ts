import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import {
  DiscordAPIError,
  GuildScheduledEventEntityType,
  GuildScheduledEventStatus,
  PermissionFlagsBits,
} from "discord.js";

/**
 * Cover image sync of the native-event mirror (#1181): sent on create (as its
 * own edit) and when changed, cleared with an explicit null, never sent for an
 * imageless event, never blocking the rest of the sync, never written for an
 * adopted row. The Discord side is mocked.
 */

const config = {
  getBoolean: jest.fn<(k: string, d?: boolean) => Promise<boolean>>(),
  getString: jest.fn<(k: string, d?: string) => Promise<string>>(),
};

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: { getInstance: jest.fn(() => config) },
}));
jest.unstable_mockModule("../../src/models/event.js", () => ({
  Event: {
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn(),
    exists: jest.fn(),
  },
}));
jest.unstable_mockModule("../../src/models/event-image.js", () => ({
  EventImage: { findOne: jest.fn() },
}));
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { Event } = await import("../../src/models/event.js");
const { EventImage } = await import("../../src/models/event-image.js");
const EventMock = Event as unknown as {
  findOneAndUpdate: jest.Mock<(...a: unknown[]) => Promise<unknown>>;
  updateOne: jest.Mock<(...a: unknown[]) => Promise<unknown>>;
  exists: jest.Mock<(...a: unknown[]) => Promise<unknown>>;
};
const ImageMock = EventImage as unknown as {
  findOne: jest.Mock<(...a: unknown[]) => Promise<unknown>>;
};
const logger = (await import("../../src/utils/logger.js"))
  .default as unknown as { warn: jest.Mock };
const { NativeEventSync, buildNativeFields } =
  await import("../../src/services/event-native-sync.js");
const { MAX_COVER_ATTEMPTS } =
  await import("../../src/services/event-cover.js");

const FUTURE = new Date(Date.now() + 24 * 60 * 60 * 1000);
const DATA = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
const DATA_URI = `data:image/png;base64,${DATA.toString("base64")}`;

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    _id: "ev1",
    guildId: "g1",
    title: "Game night",
    description: "Bring snacks",
    startTime: FUTURE,
    durationMinutes: 120,
    state: "scheduled",
    nativeEventId: null,
    nativeDetached: false,
    ...overrides,
  } as never;
}

function makeNative(overrides: Record<string, unknown> = {}) {
  const want = buildNativeFields(makeEvent() as never, "Somewhere");
  return {
    id: "n1",
    creatorId: "bot1",
    name: want.name,
    description: want.description,
    scheduledStartTimestamp: want.start.getTime(),
    scheduledEndTimestamp: want.end.getTime(),
    entityType: GuildScheduledEventEntityType.External,
    entityMetadata: { location: "Somewhere" },
    status: GuildScheduledEventStatus.Scheduled,
    ...overrides,
  };
}

function makeGuild(natives: unknown[] = []) {
  const map = new Map<string, unknown>(
    natives.map((n) => [(n as { id: string }).id, n]),
  );
  const scheduledEvents = {
    fetch: jest.fn(async (id?: string) => {
      if (id) {
        if (!map.has(id)) {
          throw Object.assign(Object.create(DiscordAPIError.prototype), {
            code: 10070,
          });
        }
        return map.get(id);
      }
      return map;
    }),
    create: jest.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({
      id: "created1",
    })),
    edit: jest.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({})),
    delete: jest.fn(async () => undefined),
  };
  const me = {
    permissions: { has: (p: bigint) => p === PermissionFlagsBits.CreateEvents },
  };
  return {
    guild: { members: { me, fetchMe: jest.fn() }, scheduledEvents } as never,
    scheduledEvents,
  };
}

const client = { user: { id: "bot1" }, guilds: { fetch: jest.fn() } } as never;
const passthrough = async <T>(call: () => Promise<T>): Promise<T> => call();
const makeSync = () => new NativeEventSync(client, passthrough as never);

/** The `$set` of every `Event.updateOne` that touched cover bookkeeping. */
function coverWrites(): Array<Record<string, unknown>> {
  return EventMock.updateOne.mock.calls
    .map((c) => c[1] as { $set?: Record<string, unknown> })
    .filter((u) => u.$set && "nativeCoverHash" in u.$set)
    .map((u) => u.$set as Record<string, unknown>);
}

function coverEdits(
  edit: jest.Mock<(...a: unknown[]) => Promise<unknown>>,
): Array<Record<string, unknown>> {
  return edit.mock.calls
    .map((c) => c[1] as Record<string, unknown>)
    .filter((o) => "image" in o);
}

beforeEach(() => {
  jest.clearAllMocks();
  config.getBoolean.mockResolvedValue(true);
  config.getString.mockImplementation(async () => "Somewhere");
  EventMock.findOneAndUpdate.mockResolvedValue({ _id: "ev1" });
  EventMock.updateOne.mockResolvedValue({});
  EventMock.exists.mockResolvedValue(null);
  ImageMock.findOne.mockResolvedValue({
    hash: "h1",
    mime: "image/png",
    data: DATA,
  });
});

describe("imageless events (shipped behaviour)", () => {
  it("creates exactly as before: no image key, no extra call, no image lookup", async () => {
    const { guild, scheduledEvents } = makeGuild();
    await makeSync().syncEvent(makeEvent(), guild);
    expect(scheduledEvents.create).toHaveBeenCalledTimes(1);
    const payload = scheduledEvents.create.mock.calls[0][0] as object;
    expect("image" in payload).toBe(false);
    expect(scheduledEvents.edit).not.toHaveBeenCalled();
    expect(ImageMock.findOne).not.toHaveBeenCalled();
  });

  it("an unchanged mirror makes no call and no image lookup", async () => {
    const { guild, scheduledEvents } = makeGuild([makeNative()]);
    await makeSync().syncEvent(makeEvent({ nativeEventId: "n1" }), guild);
    expect(scheduledEvents.edit).not.toHaveBeenCalled();
    expect(ImageMock.findOne).not.toHaveBeenCalled();
  });

  it("a name change sends no image key", async () => {
    const { guild, scheduledEvents } = makeGuild([
      makeNative({ name: "Old name" }),
    ]);
    await makeSync().syncEvent(makeEvent({ nativeEventId: "n1" }), guild);
    expect(scheduledEvents.edit).toHaveBeenCalledTimes(1);
    expect("image" in (scheduledEvents.edit.mock.calls[0][1] as object)).toBe(
      false,
    );
  });
});

describe("create", () => {
  it("creates without the image, then sends it as its own edit after the claim", async () => {
    const { guild, scheduledEvents } = makeGuild();
    const event = makeEvent({ coverHash: "h1" });
    await makeSync().syncEvent(event, guild);
    expect("image" in (scheduledEvents.create.mock.calls[0][0] as object)).toBe(
      false,
    );
    const edits = coverEdits(scheduledEvents.edit);
    expect(edits).toHaveLength(1);
    expect(edits[0].image).toBe(DATA_URI);
    expect(scheduledEvents.edit.mock.calls[0][0]).toBe("created1");
    expect(coverWrites()).toEqual([
      { nativeCoverHash: "h1", nativeCoverAttempts: 0 },
    ]);
  });

  it("a rejected image does not undo or block the creation", async () => {
    const { guild, scheduledEvents } = makeGuild();
    scheduledEvents.edit.mockRejectedValueOnce(
      Object.assign(Object.create(DiscordAPIError.prototype), { code: 50035 }),
    );
    const event = makeEvent({ coverHash: "h1" });
    await makeSync().syncEvent(event, guild);
    expect(scheduledEvents.create).toHaveBeenCalledTimes(1);
    expect(scheduledEvents.delete).not.toHaveBeenCalled();
    expect((event as unknown as { nativeEventId: string }).nativeEventId).toBe(
      "created1",
    );
    expect(coverWrites()).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe("update", () => {
  it("sends a new cover once, then not again once the hash is recorded", async () => {
    const { guild, scheduledEvents } = makeGuild([makeNative()]);
    const event = makeEvent({ nativeEventId: "n1", coverHash: "h1" });
    const sync = makeSync();
    await sync.syncEvent(event, guild);
    expect(coverEdits(scheduledEvents.edit)).toHaveLength(1);
    // The row now remembers what was sent (the sync updates it in memory too).
    await sync.syncEvent(event, guild);
    expect(coverEdits(scheduledEvents.edit)).toHaveLength(1);
    expect(ImageMock.findOne).toHaveBeenCalledTimes(1);
  });

  it("sends a replaced cover when the hash differs from the one last sent", async () => {
    ImageMock.findOne.mockResolvedValue({
      hash: "h2",
      mime: "image/png",
      data: DATA,
    });
    const { guild, scheduledEvents } = makeGuild([makeNative()]);
    const event = makeEvent({
      nativeEventId: "n1",
      coverHash: "h2",
      nativeCoverHash: "h1",
    });
    await makeSync().syncEvent(event, guild);
    expect(coverEdits(scheduledEvents.edit)[0].image).toBe(DATA_URI);
    expect(coverWrites()).toEqual([
      { nativeCoverHash: "h2", nativeCoverAttempts: 0 },
    ]);
  });

  it("clears a removed cover with an explicit null", async () => {
    const { guild, scheduledEvents } = makeGuild([makeNative()]);
    const event = makeEvent({
      nativeEventId: "n1",
      coverHash: null,
      nativeCoverHash: "h1",
    });
    await makeSync().syncEvent(event, guild);
    const edits = coverEdits(scheduledEvents.edit);
    expect(edits).toHaveLength(1);
    expect(edits[0].image).toBeNull();
    expect(ImageMock.findOne).not.toHaveBeenCalled();
    expect(coverWrites()).toEqual([
      { nativeCoverHash: null, nativeCoverAttempts: 0 },
    ]);
  });

  it("a failing cover edit still lets the name patch go out, and warns", async () => {
    const { guild, scheduledEvents } = makeGuild([
      makeNative({ name: "Old name" }),
    ]);
    scheduledEvents.edit.mockImplementation(async (...a: unknown[]) => {
      if ("image" in (a[1] as object)) {
        throw Object.assign(Object.create(DiscordAPIError.prototype), {
          code: 50035,
        });
      }
      return {};
    });
    const event = makeEvent({ nativeEventId: "n1", coverHash: "h1" });
    await makeSync().syncEvent(event, guild);
    const names = scheduledEvents.edit.mock.calls.filter(
      (c) => (c[1] as { name?: string }).name === "Game night",
    );
    expect(names).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // The failure is counted on the row, and the hash is not recorded.
    expect(coverWrites()).toEqual([]);
    expect(
      EventMock.updateOne.mock.calls.some(
        (c) =>
          JSON.stringify(c[1]) ===
          JSON.stringify({ $inc: { nativeCoverAttempts: 1 } }),
      ),
    ).toBe(true);
  });

  it("stops retrying after the attempt cap, until the image changes", async () => {
    const { guild, scheduledEvents } = makeGuild([makeNative()]);
    const event = makeEvent({
      nativeEventId: "n1",
      coverHash: "h1",
      nativeCoverAttempts: MAX_COVER_ATTEMPTS,
    });
    await makeSync().syncEvent(event, guild);
    expect(scheduledEvents.edit).not.toHaveBeenCalled();
    expect(ImageMock.findOne).not.toHaveBeenCalled();
  });

  it("skips quietly when the named image is not stored", async () => {
    ImageMock.findOne.mockResolvedValue(null);
    const { guild, scheduledEvents } = makeGuild([makeNative()]);
    const event = makeEvent({ nativeEventId: "n1", coverHash: "h1" });
    const sync = makeSync();
    await sync.syncEvent(event, guild);
    await sync.syncEvent(event, guild);
    expect(scheduledEvents.edit).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe("adopted events (#1177)", () => {
  it("never writes a cover to an adopted native event", async () => {
    const { guild, scheduledEvents } = makeGuild([makeNative()]);
    const event = makeEvent({
      nativeEventId: "n1",
      nativeAdopted: true,
      coverHash: "h1",
      nativeCoverHash: null,
    });
    await makeSync().syncEvent(event, guild, undefined);
    expect(scheduledEvents.edit).not.toHaveBeenCalled();
    expect(scheduledEvents.create).not.toHaveBeenCalled();
    expect(ImageMock.findOne).not.toHaveBeenCalled();
  });
});
