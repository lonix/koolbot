import { describe, it, expect, jest, beforeEach } from "@jest/globals";

// How EventService drives the clan tags (#1194). The decisions themselves are
// in event-nickname-tags.test.ts; here the point is the wiring: a cancel puts
// the nicknames back (it runs no end hooks), an event that goes active tags the
// assignments already in place, every scan sweeps, and an event without tags
// makes no tag call at all.

const configMock = {
  registerReloadCallback: jest.fn(),
  addChangeListener: jest.fn(),
  getBoolean: jest.fn(async (_k: string, d?: unknown) => d),
  getString: jest.fn(async (k: string, d?: unknown) =>
    k === "GUILD_ID" ? "guild-1" : d,
  ),
  getNumber: jest.fn(async (_k: string, d?: unknown) => d),
};
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: { getInstance: jest.fn(() => configMock) },
}));
jest.unstable_mockModule("../../src/services/discord-logger.js", () => ({
  DiscordLogger: { getInstance: jest.fn() },
}));
const actualCover = await import("../../src/services/event-cover.js");
jest.unstable_mockModule("../../src/services/event-cover.js", () => ({
  ...actualCover,
  sweepOrphanCovers: jest.fn(async () => undefined),
}));
jest.unstable_mockModule("../../src/models/event.js", () => ({
  Event: jest.fn(),
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
const EventMock = Event as unknown as jest.Mock & {
  find: jest.Mock;
  findOneAndUpdate: jest.Mock;
  findById: jest.Mock;
  updateOne: jest.Mock;
};
const { EventService } = await import("../../src/services/event-service.js");

interface Tags {
  syncEvent: jest.Mock<(g: string, id: string) => Promise<void>>;
  restoreEvent: jest.Mock<(g: string, id: string) => Promise<unknown>>;
  requestSweep: jest.Mock<(g: string) => void>;
}
interface Priv {
  cancelOne: (e: unknown) => Promise<boolean>;
  activateScheduled: (e: unknown) => Promise<boolean>;
  runOnce: () => Promise<void>;
  nicknameTags: Tags;
}

function setup(): Priv {
  EventService.reset();
  const guild = {
    id: "guild-1",
    channels: { cache: new Map(), fetch: jest.fn(async () => null) },
  };
  const client = { guilds: { fetch: jest.fn(async () => guild) } };
  const service = EventService.getInstance(client as never) as unknown as Priv;
  service.nicknameTags = {
    syncEvent: jest.fn(async () => undefined),
    restoreEvent: jest.fn(async () => ({ restored: 0, kept: 0, warnings: [] })),
    requestSweep: jest.fn(),
  };
  (service as unknown as Record<string, unknown>).nativeSync = {
    syncEvent: jest.fn(async () => undefined),
    loadCache: jest.fn(async () => null),
    pullAdopted: jest.fn(),
    adoptedHasChannel: jest.fn(),
  };
  (service as unknown as Record<string, unknown>).updateAnnouncement = jest.fn(
    async () => true,
  );
  return service;
}

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: "65a000000000000000000001",
    guildId: "guild-1",
    title: "Quiz",
    startTime: new Date("2026-07-04T20:00:00Z"),
    durationMinutes: 120,
    channelId: null,
    state: "active",
    recurrence: "none",
    seriesId: null,
    groupsEnabled: true,
    groups: [],
    createdBy: "u1",
    save: jest.fn(async () => undefined),
    ...over,
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
  EventMock.find = jest.fn(async () => []);
  EventMock.findOneAndUpdate = jest.fn(async () => ({
    _id: "65a000000000000000000001",
    channelId: null,
  }));
  EventMock.findById = jest.fn(async () => null);
  EventMock.updateOne = jest.fn(async () => ({ matchedCount: 1 }));
});

describe("cancel (#1194)", () => {
  it("puts the nicknames back, since a cancel runs no end hooks", async () => {
    const service = setup();
    await service.cancelOne(row({ tagsEnabled: true }));
    await flush();
    expect(service.nicknameTags.restoreEvent).toHaveBeenCalledWith(
      "guild-1",
      "65a000000000000000000001",
    );
  });

  it("does not wait for the restore, and a failing restore never fails the cancel", async () => {
    const service = setup();
    service.nicknameTags.restoreEvent.mockRejectedValue(new Error("down"));
    await expect(service.cancelOne(row({ tagsEnabled: true }))).resolves.toBe(
      true,
    );
    await flush();
  });

  it("an event that was already ended is not cancelled, so nothing is restored by this path", async () => {
    const service = setup();
    EventMock.findOneAndUpdate = jest.fn(async () => null);
    await service.cancelOne(row({ tagsEnabled: true }));
    await flush();
    expect(service.nicknameTags.restoreEvent).not.toHaveBeenCalled();
  });

  it("an event without tags makes no tag call", async () => {
    const service = setup();
    await service.cancelOne(row());
    await flush();
    expect(service.nicknameTags.restoreEvent).not.toHaveBeenCalled();
  });
});

describe("the event goes active (#1194)", () => {
  it("tags the assignments already in place", async () => {
    const service = setup();
    expect(
      await service.activateScheduled(
        row({ state: "scheduled", tagsEnabled: true }),
      ),
    ).toBe(true);
    await flush();
    expect(service.nicknameTags.syncEvent).toHaveBeenCalledWith(
      "guild-1",
      "65a000000000000000000001",
    );
  });

  it("does nothing for an event without tags, or when the event is no longer open", async () => {
    const service = setup();
    await service.activateScheduled(row({ state: "scheduled" }));
    EventMock.updateOne = jest.fn(async () => ({ matchedCount: 0 }));
    EventMock.findById = jest.fn(() => ({
      lean: async () => ({ state: "cancelled" }),
    }));
    await service.activateScheduled(
      row({ state: "scheduled", tagsEnabled: true }),
    );
    await flush();
    expect(service.nicknameTags.syncEvent).not.toHaveBeenCalled();
  });
});

describe("every scan (#1194)", () => {
  it("asks for a nickname pass and does not wait for it", async () => {
    const service = setup();
    // A pass that never finishes must not hold the scan.
    service.nicknameTags.requestSweep.mockImplementation(() => undefined);
    await service.runOnce();
    expect(service.nicknameTags.requestSweep).toHaveBeenCalledWith("guild-1");
  });
});
