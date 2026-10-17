import { describe, it, expect, jest } from "@jest/globals";

jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: jest.fn(() => ({
      registerReloadCallback: jest.fn(),
      getBoolean: jest.fn(),
      getString: jest.fn(),
      getNumber: jest.fn(),
    })),
  },
}));

jest.unstable_mockModule("../../src/services/discord-logger.js", () => ({
  DiscordLogger: { getInstance: jest.fn() },
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
const Statics = Event as unknown as {
  findOne: jest.Mock;
  deleteOne: jest.Mock;
};
Statics.findOne = jest.fn();
Statics.deleteOne = jest.fn();

const { EventService } = await import("../../src/services/event-service.js");

const MIN = 60 * 1000;

describe("adopted native events in the event scan (#1034)", () => {
  type Priv = {
    nativeSync: {
      syncEvent: jest.Mock;
      pullAdopted: jest.Mock;
      adoptedHasChannel: jest.Mock;
    };
    processEvent: (...a: unknown[]) => Promise<void>;
    cancelOne: jest.Mock;
    claimEventChannel: jest.Mock;
    ensureAnnouncement: jest.Mock;
    updateAnnouncement: jest.Mock;
    postReminder: jest.Mock;
    logLifecycle: jest.Mock;
    isChannelEmpty: jest.Mock;
    deleteEventChannel: jest.Mock;
    deleteAnnouncementPost: jest.Mock;
    removeAdoptedEvent: (ref: string) => Promise<boolean>;
  };

  function svc(): Priv {
    EventService.reset();
    const service = EventService.getInstance({
      guilds: { fetch: jest.fn(async () => ({ id: "guild-1" })) },
    } as never) as unknown as Priv;
    service.nativeSync = {
      syncEvent: jest.fn(async () => undefined),
      pullAdopted: jest.fn(async () => "ok"),
      adoptedHasChannel: jest.fn(() => false),
    };
    service.cancelOne = jest.fn(async () => undefined);
    service.claimEventChannel = jest.fn(async () => ({ id: "temp" }));
    service.ensureAnnouncement = jest.fn(async () => undefined);
    service.updateAnnouncement = jest.fn(async () => true);
    service.postReminder = jest.fn(async () => undefined);
    service.logLifecycle = jest.fn(async () => undefined);
    return service;
  }

  function adopted(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      _id: "ev-1",
      guildId: "guild-1",
      title: "Movie night",
      description: "",
      startTime: new Date("2026-07-04T20:00:00Z"),
      timezone: "UTC",
      durationMinutes: 120,
      channelId: null,
      announcementChannelId: null,
      announcementMessageId: null,
      state: "scheduled",
      reminderSent: false,
      rsvps: [],
      recurrence: "none",
      seriesId: null,
      nativeEventId: "native-1",
      nativeAdopted: true,
      save: jest.fn(async () => undefined),
      ...overrides,
    };
  }

  const native = new Map();
  const windows = {
    reminderMs: 30 * MIN,
    leadMs: 15 * MIN,
    graceMs: 0,
    native,
  };
  const NOW = new Date("2026-07-04T19:50:00Z"); // inside the lead window

  it("cancels the row, not the Discord event, when the native event is gone", async () => {
    const service = svc();
    service.nativeSync.pullAdopted.mockResolvedValue("gone");
    const event = adopted();
    await service.processEvent(event, {}, NOW, windows);
    expect(service.cancelOne).toHaveBeenCalledWith(event, native, undefined);
    expect(service.postReminder).not.toHaveBeenCalled();
    expect(service.claimEventChannel).not.toHaveBeenCalled();
  });

  it("makes the temporary channel for an adopted event with no channel of its own", async () => {
    const service = svc();
    await service.processEvent(adopted(), {}, NOW, windows);
    expect(service.claimEventChannel).toHaveBeenCalledTimes(1);
    expect(service.postReminder).toHaveBeenCalledTimes(1);
  });

  it("makes no temporary channel when the native event has its own, or when that is unknown", async () => {
    const service = svc();
    service.nativeSync.adoptedHasChannel.mockReturnValue(true);
    await service.processEvent(adopted(), {}, NOW, windows);
    service.nativeSync.adoptedHasChannel.mockReturnValue(null);
    await service.processEvent(adopted(), {}, NOW, windows);
    expect(service.claimEventChannel).not.toHaveBeenCalled();
    // The reminder is unaffected.
    expect(service.postReminder).toHaveBeenCalledTimes(2);
  });

  it("posts the link announcement for an adopted event that has none", async () => {
    const service = svc();
    await service.processEvent(adopted(), {}, NOW, windows);
    expect(service.ensureAnnouncement).toHaveBeenCalledTimes(1);
    const posted = svc();
    await posted.processEvent(
      adopted({ announcementMessageId: "m1", announcementChannelId: "c1" }),
      {},
      NOW,
      windows,
    );
    expect(posted.ensureAnnouncement).not.toHaveBeenCalled();
  });

  it("skips the adopted-event read while the native listing failed", async () => {
    const service = svc();
    await service.processEvent(adopted(), {}, NOW, {
      ...windows,
      native: null,
      skipNative: true,
    });
    expect(service.nativeSync.pullAdopted).not.toHaveBeenCalled();
    expect(service.nativeSync.syncEvent).not.toHaveBeenCalled();
  });
});

describe("EventService.removeAdoptedEvent (#1034)", () => {
  type Priv = {
    nativeSync: { syncEvent: jest.Mock };
    cancelOne: jest.Mock;
    isChannelEmpty: jest.Mock;
    deleteEventChannel: jest.Mock;
    deleteAnnouncementPost: jest.Mock;
    removeAdoptedEvent: (ref: string) => Promise<boolean>;
  };

  function row(overrides: Record<string, unknown> = {}) {
    return {
      _id: "ev-1",
      guildId: "guild-1",
      state: "scheduled",
      channelId: null,
      announcementChannelId: null,
      announcementMessageId: null,
      nativeAdopted: true,
      ...overrides,
    };
  }

  function setup(found: Record<string, unknown> | null): Priv {
    EventService.reset();
    const service = EventService.getInstance({
      guilds: { fetch: jest.fn(async () => ({ id: "guild-1" })) },
    } as never) as unknown as Priv;
    service.nativeSync = { syncEvent: jest.fn(async () => undefined) };
    service.cancelOne = jest.fn(async () => undefined);
    service.isChannelEmpty = jest.fn(async () => true);
    service.deleteEventChannel = jest.fn(async () => undefined);
    service.deleteAnnouncementPost = jest.fn(async () => undefined);
    Statics.findOne.mockReset().mockResolvedValue(found);
    Statics.deleteOne.mockReset().mockResolvedValue({});
    return service;
  }

  it("deletes only the row it created, with its post and empty channel, and never cancels", async () => {
    const found = row({
      channelId: "temp",
      announcementChannelId: "c1",
      announcementMessageId: "m1",
    });
    const service = setup(found);
    expect(await service.removeAdoptedEvent("snap-1:op-1")).toBe(true);
    expect(Statics.findOne).toHaveBeenCalledWith({
      adoptionRef: "snap-1:op-1",
      nativeAdopted: true,
    });
    expect(service.deleteEventChannel).toHaveBeenCalled();
    expect(service.deleteAnnouncementPost).toHaveBeenCalledWith(
      "guild-1",
      "c1",
      "m1",
    );
    expect(Statics.deleteOne).toHaveBeenCalledWith({
      _id: "ev-1",
      adoptionRef: "snap-1:op-1",
      nativeAdopted: true,
    });
    // Cancelling would reach the member's Discord event; it must not run.
    expect(service.cancelOne).not.toHaveBeenCalled();
    expect(service.nativeSync.syncEvent).not.toHaveBeenCalled();
    expect(found["state"]).toBe("scheduled");
  });

  it("is a no-op when the row is already gone", async () => {
    const service = setup(null);
    expect(await service.removeAdoptedEvent("snap-1:op-1")).toBe(false);
    expect(Statics.deleteOne).not.toHaveBeenCalled();
  });

  it("refuses while the temporary channel is in use, and deletes nothing", async () => {
    const service = setup(row({ channelId: "temp" }));
    service.isChannelEmpty = jest.fn(async () => false);
    await expect(service.removeAdoptedEvent("snap-1:op-1")).rejects.toThrow(
      /in use/,
    );
    expect(service.deleteEventChannel).not.toHaveBeenCalled();
    expect(Statics.deleteOne).not.toHaveBeenCalled();
  });
});
