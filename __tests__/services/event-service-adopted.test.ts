import { describe, it, expect, jest } from "@jest/globals";
import { ChannelType, DiscordAPIError } from "discord.js";

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
// The scan's `scheduled` to `active` step is a conditional write (#1193).
(Statics as unknown as { updateOne: jest.Mock }).updateOne = jest.fn(
  async () => ({ matchedCount: 1 }),
);

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
    // The scan's claim is held to the lead time it decided from (#1239).
    expect(service.claimEventChannel).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { enforceLead: true },
    );
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

  it("leaves a pre-start row alone while its temp channel has people in it, then cancels", async () => {
    const service = svc();
    service.nativeSync.pullAdopted.mockResolvedValue("gone");
    service.isChannelEmpty = jest.fn(async () => false);
    const event = adopted({ channelId: "temp", state: "active" });
    await service.processEvent(event, {}, NOW, windows);
    expect(service.cancelOne).not.toHaveBeenCalled();
    service.isChannelEmpty = jest.fn(async () => true);
    await service.processEvent(event, {}, NOW, windows);
    expect(service.cancelOne).toHaveBeenCalledTimes(1);
  });

  it("re-renders the announcement when a pull changes the title, time or description", async () => {
    const service = svc();
    const event = adopted({
      announcementMessageId: "m1",
      announcementChannelId: "c1",
    });
    // No temp channel here, so the only refresh is the link-verified one.
    service.nativeSync.adoptedHasChannel.mockReturnValue(true);
    const linkVerified = (
      service as unknown as { linkVerified: Map<string, string> }
    ).linkVerified;
    const scan = (): Promise<void> =>
      service.processEvent(event, {}, NOW, windows);
    await scan();
    await scan();
    // Verified once: no further edits while nothing changes.
    expect(service.updateAnnouncement).toHaveBeenCalledTimes(1);
    service.nativeSync.pullAdopted.mockImplementationOnce(async () => {
      event.title = "Renamed";
      return "ok";
    });
    await scan();
    expect(linkVerified.has("ev-1")).toBe(true);
    expect(service.updateAnnouncement).toHaveBeenCalledTimes(2);
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
    removeChannelStrict: jest.Mock;
    removePostStrict: jest.Mock;
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
    service.removeChannelStrict = jest.fn(async () => undefined);
    service.removePostStrict = jest.fn(async () => undefined);
    Statics.findOne.mockReset().mockResolvedValue(found);
    Statics.deleteOne.mockReset().mockResolvedValue({ deletedCount: 1 });
    return service;
  }

  it("deletes only the row it created, with its post and channel, and never cancels", async () => {
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
    expect(service.removeChannelStrict).toHaveBeenCalledWith("guild-1", "temp");
    expect(service.removePostStrict).toHaveBeenCalledWith(
      "guild-1",
      "c1",
      "m1",
    );
    // The row goes only while it still tracks what was just cleaned up.
    expect(Statics.deleteOne).toHaveBeenCalledWith({
      _id: "ev-1",
      adoptionRef: "snap-1:op-1",
      nativeAdopted: true,
      channelId: "temp",
      announcementMessageId: "m1",
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

  it("keeps the row when cleanup fails, so a retry can still find the channel and post", async () => {
    const service = setup(
      row({
        channelId: "temp",
        announcementChannelId: "c1",
        announcementMessageId: "m1",
      }),
    );
    service.removeChannelStrict.mockRejectedValue(new Error("in use"));
    await expect(service.removeAdoptedEvent("snap-1:op-1")).rejects.toThrow(
      /in use/,
    );
    expect(Statics.deleteOne).not.toHaveBeenCalled();
    service.removeChannelStrict.mockResolvedValue(undefined);
    service.removePostStrict.mockRejectedValue(new Error("Missing Access"));
    await expect(service.removeAdoptedEvent("snap-1:op-1")).rejects.toThrow(
      /Missing Access/,
    );
    expect(Statics.deleteOne).not.toHaveBeenCalled();
  });

  it("asks for a retry when the row picked up a channel or post after it was read", async () => {
    const service = setup(row());
    Statics.deleteOne.mockResolvedValue({ deletedCount: 0 });
    await expect(service.removeAdoptedEvent("snap-1:op-1")).rejects.toThrow(
      /changed while/,
    );
  });
});

describe("strict rollback cleanup (#1034)", () => {
  type Priv = {
    removeChannelStrict: (g: string, c: string) => Promise<void>;
    removePostStrict: (g: string, c: string, m: string) => Promise<void>;
    fetchTextChannelDetailed: jest.Mock;
  };
  const unknown = (code: number) =>
    Object.assign(Object.create(DiscordAPIError.prototype), { code });

  function svc(client: unknown): Priv {
    EventService.reset();
    return EventService.getInstance(client as never) as unknown as Priv;
  }
  function guildWith(channel: unknown, fetchError?: unknown) {
    return {
      guilds: {
        fetch: jest.fn(async () => ({
          channels: {
            cache: new Map(),
            fetch: jest.fn(async () => {
              if (fetchError) throw fetchError;
              return channel;
            }),
          },
        })),
      },
    };
  }

  it("deletes an empty voice channel, treats an unknown channel as done, and fails on anything else", async () => {
    const del = jest.fn(async () => undefined);
    const voice = {
      type: ChannelType.GuildVoice,
      members: new Map(),
      delete: del,
    };
    await svc(guildWith(voice)).removeChannelStrict("g", "c");
    expect(del).toHaveBeenCalled();
    await expect(
      svc(guildWith(null, unknown(10003))).removeChannelStrict("g", "c"),
    ).resolves.toBeUndefined();
    await expect(
      svc(guildWith(null, new Error("outage"))).removeChannelStrict("g", "c"),
    ).rejects.toThrow("outage");
    await expect(
      svc({
        guilds: {
          fetch: jest.fn(async () => {
            throw new Error("no guild");
          }),
        },
      }).removeChannelStrict("g", "c"),
    ).rejects.toThrow("no guild");
    const busy = {
      type: ChannelType.GuildVoice,
      members: new Map([["u", {}]]),
      delete: jest.fn(),
    };
    await expect(
      svc(guildWith(busy)).removeChannelStrict("g", "c"),
    ).rejects.toThrow(/in use/);
    expect(busy.delete).not.toHaveBeenCalled();
    const denied = {
      type: ChannelType.GuildVoice,
      members: new Map(),
      delete: jest.fn(async () => {
        throw unknown(50013);
      }),
    };
    await expect(
      svc(guildWith(denied)).removeChannelStrict("g", "c"),
    ).rejects.toBeDefined();
  });

  it("deletes the post, treats a missing message or channel as done, and fails on anything else", async () => {
    const service = svc({});
    const del = jest.fn(async () => undefined);
    service.fetchTextChannelDetailed = jest.fn(async () => ({
      channel: { messages: { fetch: jest.fn(async () => ({ delete: del })) } },
      gone: false,
    }));
    await service.removePostStrict("g", "c", "m");
    expect(del).toHaveBeenCalled();
    service.fetchTextChannelDetailed = jest.fn(async () => ({
      channel: null,
      gone: true,
    }));
    await expect(
      service.removePostStrict("g", "c", "m"),
    ).resolves.toBeUndefined();
    service.fetchTextChannelDetailed = jest.fn(async () => ({
      channel: null,
      gone: false,
    }));
    await expect(service.removePostStrict("g", "c", "m")).rejects.toThrow(
      /could not be read/,
    );
    service.fetchTextChannelDetailed = jest.fn(async () => ({
      channel: {
        messages: {
          fetch: jest.fn(async () => {
            throw unknown(10008);
          }),
        },
      },
      gone: false,
    }));
    await expect(
      service.removePostStrict("g", "c", "m"),
    ).resolves.toBeUndefined();
    service.fetchTextChannelDetailed = jest.fn(async () => ({
      channel: {
        messages: {
          fetch: jest.fn(async () => {
            throw unknown(50013);
          }),
        },
      },
      gone: false,
    }));
    await expect(service.removePostStrict("g", "c", "m")).rejects.toBeDefined();
  });
});
