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
const logger = (await import("../../src/utils/logger.js"))
  .default as unknown as {
  warn: jest.Mock;
};
const { NativeEventSync, buildNativeFields, diffNativeFields } =
  await import("../../src/services/event-native-sync.js");

const FUTURE = new Date(Date.now() + 24 * 60 * 60 * 1000);
const BOT_ID = "bot1";

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
    creatorId: BOT_ID,
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

function makeGuild(opts: { perms?: bigint[]; natives?: unknown[] } = {}) {
  const perms = opts.perms ?? [PermissionFlagsBits.CreateEvents];
  const natives = new Map<string, unknown>(
    (opts.natives ?? []).map((n) => [(n as { id: string }).id, n]),
  );
  const collection = Object.assign(natives, {});
  const scheduledEvents = {
    fetch: jest.fn(async (id?: string) => {
      if (id) {
        const found = natives.get(id);
        if (!found) {
          throw Object.assign(Object.create(DiscordAPIError.prototype), {
            code: 10070,
          });
        }
        return found;
      }
      return collection;
    }),
    create: jest.fn(async () => ({ id: "created1" })),
    edit: jest.fn(async () => ({})),
    delete: jest.fn(async () => undefined),
  };
  const me = {
    permissions: { has: (p: bigint) => perms.includes(p) },
  };
  return {
    guild: { members: { me, fetchMe: jest.fn() }, scheduledEvents } as never,
    scheduledEvents,
  };
}

const client = { user: { id: BOT_ID }, guilds: { fetch: jest.fn() } } as never;
const passthrough = async <T>(call: () => Promise<T>): Promise<T> => call();

function makeSync() {
  return new NativeEventSync(client, passthrough as never);
}

beforeEach(() => {
  jest.clearAllMocks();
  config.getBoolean.mockResolvedValue(true);
  config.getString.mockImplementation(async () => "Somewhere");
  EventMock.findOneAndUpdate.mockResolvedValue({ _id: "ev1" });
  EventMock.updateOne.mockResolvedValue({});
  EventMock.exists.mockResolvedValue(null);
});

describe("buildNativeFields", () => {
  it("clamps name, description and location to Discord's limits", () => {
    const f = buildNativeFields(
      makeEvent({
        title: "t".repeat(150),
        description: "d".repeat(1500),
      }) as never,
      "l".repeat(300),
    );
    expect(f.name).toHaveLength(100);
    expect(f.description).toHaveLength(1000);
    expect(f.location).toHaveLength(100);
  });

  it("always ends after the start, even for a zero duration", () => {
    const f = buildNativeFields(
      makeEvent({ durationMinutes: 0 }) as never,
      "x",
    );
    expect(f.end.getTime()).toBeGreaterThan(f.start.getTime());
  });

  it("falls back to the default location when blank", () => {
    expect(buildNativeFields(makeEvent() as never, "  ").location).toMatch(
      /Voice channel/,
    );
  });
});

describe("diffNativeFields", () => {
  const want = buildNativeFields(makeEvent() as never, "Somewhere");
  it("is empty when nothing changed", () => {
    expect(diffNativeFields(makeNative() as never, want)).toEqual({});
  });
  it("reports only the changed fields", () => {
    const diff = diffNativeFields(
      makeNative({ name: "Old name", description: null }) as never,
      want,
    );
    expect(diff).toEqual({ name: want.name, description: want.description });
  });
});

describe("NativeEventSync.syncEvent", () => {
  it("does nothing when the toggle is off", async () => {
    config.getBoolean.mockResolvedValue(false);
    const { guild, scheduledEvents } = makeGuild();
    await makeSync().syncEvent(makeEvent(), guild);
    expect(scheduledEvents.create).not.toHaveBeenCalled();
  });

  it("creates an external native event and stores its id", async () => {
    const { guild, scheduledEvents } = makeGuild();
    const event = makeEvent();
    await makeSync().syncEvent(event, guild);
    expect(scheduledEvents.create).toHaveBeenCalledTimes(1);
    const arg = (
      scheduledEvents.create.mock.calls[0] as unknown[]
    )[0] as Record<string, unknown>;
    expect(arg.entityType).toBe(GuildScheduledEventEntityType.External);
    expect(arg.name).toBe("Game night");
    expect(arg.scheduledEndTime).toBeInstanceOf(Date);
    expect(EventMock.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: "ev1", nativeEventId: null }),
      { $set: { nativeEventId: "created1" } },
    );
    expect((event as { nativeEventId: string }).nativeEventId).toBe("created1");
  });

  it("accepts Manage Events as well as Create Events", async () => {
    const { guild, scheduledEvents } = makeGuild({
      perms: [PermissionFlagsBits.ManageEvents],
    });
    await makeSync().syncEvent(makeEvent(), guild);
    expect(scheduledEvents.create).toHaveBeenCalled();
  });

  it("degrades with a single warning when the permission is missing", async () => {
    const { guild, scheduledEvents } = makeGuild({ perms: [] });
    const sync = makeSync();
    await sync.syncEvent(makeEvent(), guild);
    await sync.syncEvent(makeEvent(), guild);
    expect(scheduledEvents.create).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0][0])).toMatch(/Create Events/);
  });

  it("does not create when the start is already in the past", async () => {
    const { guild, scheduledEvents } = makeGuild();
    await makeSync().syncEvent(
      makeEvent({ startTime: new Date(Date.now() - 60000) }),
      guild,
    );
    expect(scheduledEvents.create).not.toHaveBeenCalled();
  });

  it("adopts an unreferenced bot-created native event instead of duplicating", async () => {
    const orphan = makeNative({ id: "orphan1" });
    const { guild, scheduledEvents } = makeGuild({ natives: [orphan] });
    await makeSync().syncEvent(makeEvent(), guild);
    expect(scheduledEvents.create).not.toHaveBeenCalled();
    expect(EventMock.findOneAndUpdate).toHaveBeenCalledWith(expect.anything(), {
      $set: { nativeEventId: "orphan1" },
    });
  });

  it("does not adopt a native event another row already references", async () => {
    EventMock.exists.mockResolvedValue({ _id: "other" });
    const { guild, scheduledEvents } = makeGuild({
      natives: [makeNative({ id: "taken1" })],
    });
    await makeSync().syncEvent(makeEvent(), guild);
    expect(scheduledEvents.create).toHaveBeenCalledTimes(1);
  });

  it("does not adopt another user's native event", async () => {
    const { guild, scheduledEvents } = makeGuild({
      natives: [makeNative({ id: "human1", creatorId: "someone" })],
    });
    await makeSync().syncEvent(makeEvent(), guild);
    expect(scheduledEvents.create).toHaveBeenCalledTimes(1);
  });

  it("deletes the event it just created when it loses the claim race", async () => {
    EventMock.findOneAndUpdate.mockResolvedValue(null);
    const { guild, scheduledEvents } = makeGuild();
    await makeSync().syncEvent(makeEvent(), guild);
    expect(scheduledEvents.delete).toHaveBeenCalledWith("created1");
  });

  it("reuses the stored id after a restart (no second create)", async () => {
    const { guild, scheduledEvents } = makeGuild({ natives: [makeNative()] });
    await makeSync().syncEvent(makeEvent({ nativeEventId: "n1" }), guild);
    expect(scheduledEvents.create).not.toHaveBeenCalled();
    expect(scheduledEvents.edit).not.toHaveBeenCalled();
  });

  it("pushes edits to a scheduled native event", async () => {
    const { guild, scheduledEvents } = makeGuild({
      natives: [makeNative({ name: "Old title" })],
    });
    await makeSync().syncEvent(makeEvent({ nativeEventId: "n1" }), guild);
    expect(scheduledEvents.edit).toHaveBeenCalledWith(
      "n1",
      expect.objectContaining({ name: "Game night" }),
    );
  });

  it("leaves a running native event's schedule alone", async () => {
    const { guild, scheduledEvents } = makeGuild({
      natives: [
        makeNative({ name: "Old", status: GuildScheduledEventStatus.Active }),
      ],
    });
    await makeSync().syncEvent(makeEvent({ nativeEventId: "n1" }), guild);
    expect(scheduledEvents.edit).not.toHaveBeenCalled();
  });

  it("stops mirroring (no recreate) when the native event was deleted by hand", async () => {
    const { guild, scheduledEvents } = makeGuild({ natives: [] });
    const event = makeEvent({ nativeEventId: "gone1" });
    await makeSync().syncEvent(event, guild);
    expect(EventMock.updateOne).toHaveBeenCalledWith(
      { _id: "ev1" },
      { $set: { nativeEventId: null, nativeDetached: true } },
    );
    await makeSync().syncEvent(
      makeEvent({ nativeEventId: null, nativeDetached: true }),
      guild,
    );
    expect(scheduledEvents.create).not.toHaveBeenCalled();
  });

  it("cancels a scheduled native event when the event is cancelled, then releases the link", async () => {
    const { guild, scheduledEvents } = makeGuild({ natives: [makeNative()] });
    await makeSync().syncEvent(
      makeEvent({ state: "cancelled", nativeEventId: "n1" }),
      guild,
    );
    expect(scheduledEvents.edit).toHaveBeenCalledWith(
      "n1",
      expect.objectContaining({ status: GuildScheduledEventStatus.Canceled }),
    );
    expect(EventMock.updateOne).toHaveBeenCalledWith(
      { _id: "ev1", nativeEventId: "n1" },
      { $set: { nativeEventId: null } },
    );
  });

  it("completes an active native event when the event ends", async () => {
    const { guild, scheduledEvents } = makeGuild({
      natives: [makeNative({ status: GuildScheduledEventStatus.Active })],
    });
    await makeSync().syncEvent(
      makeEvent({ state: "ended", nativeEventId: "n1" }),
      guild,
    );
    expect(scheduledEvents.edit).toHaveBeenCalledWith(
      "n1",
      expect.objectContaining({ status: GuildScheduledEventStatus.Completed }),
    );
  });

  it("deletes a never-started native event when the event ends", async () => {
    const { guild, scheduledEvents } = makeGuild({ natives: [makeNative()] });
    await makeSync().syncEvent(
      makeEvent({ state: "ended", nativeEventId: "n1" }),
      guild,
    );
    expect(scheduledEvents.delete).toHaveBeenCalledWith("n1");
  });

  it("keeps the link for a retry when closing fails, and never throws", async () => {
    const { guild, scheduledEvents } = makeGuild({ natives: [makeNative()] });
    scheduledEvents.edit.mockRejectedValueOnce(new Error("boom"));
    await expect(
      makeSync().syncEvent(
        makeEvent({ state: "cancelled", nativeEventId: "n1" }),
        guild,
      ),
    ).resolves.toBeUndefined();
    expect(EventMock.updateOne).not.toHaveBeenCalled();
  });

  it("never throws when creating fails", async () => {
    const { guild, scheduledEvents } = makeGuild();
    scheduledEvents.create.mockRejectedValueOnce(new Error("50013"));
    await expect(
      makeSync().syncEvent(makeEvent(), guild),
    ).resolves.toBeUndefined();
  });
});
