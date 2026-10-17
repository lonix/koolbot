import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import {
  DiscordAPIError,
  GuildScheduledEventEntityType,
  GuildScheduledEventStatus,
  PermissionFlagsBits,
} from "discord.js";

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

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { Event } = await import("../../src/models/event.js");
const EventMock = Event as unknown as {
  findOneAndUpdate: jest.Mock<(...a: unknown[]) => Promise<unknown>>;
  updateOne: jest.Mock<(...a: unknown[]) => Promise<unknown>>;
  exists: jest.Mock<(...a: unknown[]) => Promise<unknown>>;
};
const { NativeEventSync } =
  await import("../../src/services/event-native-sync.js");

const START = new Date(Date.now() + 24 * 60 * 60 * 1000);

/** A member's own event: a voice event with its own name, place and an end
 * time that is not a whole number of minutes after the start. */
function memberNative(overrides: Record<string, unknown> = {}) {
  return {
    id: "n1",
    creatorId: "member1",
    name: "Movie night (members)",
    description: "Popcorn",
    scheduledStartAt: START,
    scheduledStartTimestamp: START.getTime(),
    scheduledEndTimestamp: START.getTime() + 90 * 60 * 1000 + 17_000,
    entityType: GuildScheduledEventEntityType.Voice,
    entityMetadata: null,
    channelId: "voice1",
    status: GuildScheduledEventStatus.Scheduled,
    ...overrides,
  };
}

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    _id: "ev1",
    guildId: "g1",
    title: "Something else entirely",
    description: "",
    startTime: new Date(START.getTime() + 60_000),
    durationMinutes: 120,
    state: "scheduled",
    nativeEventId: "n1",
    nativeAdopted: true,
    nativeDetached: false,
    ...overrides,
  } as never;
}

function makeGuild(natives: unknown[]) {
  const map = new Map<string, unknown>(
    natives.map((n) => [(n as { id: string }).id, n]),
  );
  const scheduledEvents = {
    fetch: jest.fn(async (id?: string) => {
      if (id) {
        const found = map.get(id);
        if (!found) {
          throw Object.assign(Object.create(DiscordAPIError.prototype), {
            code: 10070,
          });
        }
        return found;
      }
      return map;
    }),
    create: jest.fn(async () => ({ id: "created" })),
    edit: jest.fn(async () => ({})),
    delete: jest.fn(async () => undefined),
  };
  const me = {
    permissions: {
      has: (p: bigint) =>
        p === PermissionFlagsBits.ManageEvents ||
        p === PermissionFlagsBits.CreateEvents,
    },
  };
  return {
    guild: { members: { me, fetchMe: jest.fn() }, scheduledEvents } as never,
    scheduledEvents,
    map: map as never,
  };
}

const client = { user: { id: "bot1" }, guilds: { fetch: jest.fn() } } as never;
const passthrough = async <T>(call: () => Promise<T>): Promise<T> => call();
const makeSync = () => new NativeEventSync(client, passthrough as never);

beforeEach(() => {
  jest.clearAllMocks();
  config.getBoolean.mockResolvedValue(true);
  config.getString.mockResolvedValue("Somewhere");
  EventMock.updateOne.mockResolvedValue({});
});

describe("native sync leaves an adopted event alone (#1034)", () => {
  it("never creates, edits or deletes the member's event on a scan", async () => {
    const { guild, scheduledEvents, map } = makeGuild([memberNative()]);
    const sync = makeSync();
    // Name, place, entity type, times and end-of-minute all differ from what a
    // mirrored row would want; none of it may be pushed to Discord.
    await sync.syncEvent(makeEvent(), guild, map);
    await sync.syncEvent(makeEvent(), guild);
    expect(scheduledEvents.edit).not.toHaveBeenCalled();
    expect(scheduledEvents.delete).not.toHaveBeenCalled();
    expect(scheduledEvents.create).not.toHaveBeenCalled();
    expect(EventMock.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it.each(["ended", "cancelled"] as const)(
    "a %s row only releases the link: the Discord event is not closed or deleted",
    async (state) => {
      const { guild, scheduledEvents, map } = makeGuild([memberNative()]);
      await makeSync().syncEvent(makeEvent({ state }), guild, map);
      expect(scheduledEvents.edit).not.toHaveBeenCalled();
      expect(scheduledEvents.delete).not.toHaveBeenCalled();
      expect(EventMock.updateOne).toHaveBeenCalledWith(
        { _id: "ev1", nativeEventId: "n1" },
        { $set: { nativeEventId: null } },
      );
    },
  );

  it("does nothing while the Events feature is off", async () => {
    config.getBoolean.mockResolvedValue(false);
    const { guild, map } = makeGuild([memberNative()]);
    await makeSync().syncEvent(makeEvent({ state: "cancelled" }), guild, map);
    expect(EventMock.updateOne).not.toHaveBeenCalled();
  });
});

describe("pullAdopted", () => {
  it("copies the native name, description, start and length onto a waiting row", async () => {
    const { guild, scheduledEvents, map } = makeGuild([memberNative()]);
    const event = makeEvent() as unknown as Record<string, unknown>;
    expect(await makeSync().pullAdopted(event as never, guild, map)).toBe("ok");
    expect(EventMock.updateOne).toHaveBeenCalledWith(
      { _id: "ev1", state: "scheduled" },
      {
        $set: {
          title: "Movie night (members)",
          description: "Popcorn",
          startTime: START,
          // 90 minutes and 17 seconds, rounded up to whole minutes.
          durationMinutes: 91,
        },
      },
    );
    expect(event.title).toBe("Movie night (members)");
    expect(scheduledEvents.edit).not.toHaveBeenCalled();
  });

  it("writes nothing when the row already matches", async () => {
    const { guild, map } = makeGuild([memberNative()]);
    const event = makeEvent({
      title: "Movie night (members)",
      description: "Popcorn",
      startTime: START,
      durationMinutes: 91,
    });
    expect(await makeSync().pullAdopted(event, guild, map)).toBe("ok");
    expect(EventMock.updateOne).not.toHaveBeenCalled();
  });

  it("keeps the schedule of a running event", async () => {
    const { guild, map } = makeGuild([memberNative()]);
    const event = makeEvent({ state: "active" });
    expect(await makeSync().pullAdopted(event, guild, map)).toBe("ok");
    expect(EventMock.updateOne).not.toHaveBeenCalled();
  });

  it("never reports a running row as gone: its channel may be in use and a missing entry may just mean it ended", async () => {
    const deleted = makeGuild([]);
    const completed = makeGuild([
      memberNative({ status: GuildScheduledEventStatus.Completed }),
    ]);
    for (const g of [deleted, completed]) {
      expect(
        await makeSync().pullAdopted(
          makeEvent({ state: "active" }),
          g.guild,
          g.map,
        ),
      ).toBe("ok");
    }
    expect(
      await makeSync().pullAdopted(
        makeEvent({ state: "active" }),
        deleted.guild,
      ),
    ).toBe("ok");
  });

  it("reports gone when the event was deleted or cancelled in Discord before it started", async () => {
    const deleted = makeGuild([]);
    expect(
      await makeSync().pullAdopted(makeEvent(), deleted.guild, deleted.map),
    ).toBe("gone");
    const noCache = makeGuild([]);
    expect(await makeSync().pullAdopted(makeEvent(), noCache.guild)).toBe(
      "gone",
    );
    const cancelled = makeGuild([
      memberNative({ status: GuildScheduledEventStatus.Canceled }),
    ]);
    expect(
      await makeSync().pullAdopted(makeEvent(), cancelled.guild, cancelled.map),
    ).toBe("gone");
  });

  it("treats a failed read as nothing to do", async () => {
    const { guild, scheduledEvents } = makeGuild([]);
    scheduledEvents.fetch.mockRejectedValueOnce(new Error("503"));
    expect(await makeSync().pullAdopted(makeEvent(), guild)).toBe("ok");
  });

  it("ignores rows that are not adopted", async () => {
    const { guild, map } = makeGuild([]);
    expect(
      await makeSync().pullAdopted(
        makeEvent({ nativeAdopted: false }),
        guild,
        map,
      ),
    ).toBe("ok");
  });
});

describe("adoptedHasChannel", () => {
  it("reads whether the native event has a channel; unknown without a listing", () => {
    const { map } = makeGuild([
      memberNative(),
      memberNative({ id: "n2", channelId: null }),
    ]);
    const sync = makeSync();
    expect(sync.adoptedHasChannel(makeEvent(), map)).toBe(true);
    expect(
      sync.adoptedHasChannel(makeEvent({ nativeEventId: "n2" }), map),
    ).toBe(false);
    expect(sync.adoptedHasChannel(makeEvent())).toBeNull();
    expect(
      sync.adoptedHasChannel(makeEvent({ nativeEventId: "missing" }), map),
    ).toBeNull();
  });
});
