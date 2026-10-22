import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import {
  DiscordAPIError,
  GuildScheduledEventEntityType,
  GuildScheduledEventStatus,
  PermissionFlagsBits,
} from "discord.js";

/**
 * Linking the native event to the event's main voice room (#1421): the diff
 * (external to voice for the main room, nothing without a room, voice back to
 * external only when KoolBot did not set it), Groups on (main room only), the
 * failure path (logged once, retried, never throws), and the off switch.
 * The Discord side is mocked.
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
jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const logger = (await import("../../src/utils/logger.js"))
  .default as unknown as { warn: jest.Mock; error: jest.Mock };
const { NativeEventSync, buildNativeFields, diffNativeFields } =
  await import("../../src/services/event-native-sync.js");

const FUTURE = new Date(Date.now() + 24 * 60 * 60 * 1000);
const PAST = new Date(Date.now() - 60 * 1000);
const ROOM = "room1";

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    _id: "ev1",
    guildId: "g1",
    title: "Game night",
    description: "Bring snacks",
    startTime: FUTURE,
    durationMinutes: 120,
    state: "scheduled",
    nativeEventId: "n1",
    nativeDetached: false,
    channelId: null,
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
    channelId: null,
    status: GuildScheduledEventStatus.Scheduled,
    ...overrides,
  };
}

const voiceNative = (channelId: string, overrides = {}) =>
  makeNative({
    entityType: GuildScheduledEventEntityType.Voice,
    entityMetadata: null,
    channelId,
    ...overrides,
  });

function makeGuild(natives: unknown[]) {
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
    edit: jest.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({})),
  };
  const channels = {
    cache: new Map<string, unknown>(),
    fetch: jest.fn<(id: string) => Promise<unknown>>(async () => ({
      id: ROOM,
    })),
  };
  const rest = {
    patch: jest.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({})),
  };
  const me = {
    permissions: { has: (p: bigint) => p === PermissionFlagsBits.CreateEvents },
  };
  return {
    guild: {
      id: "g1",
      client: { rest },
      members: { me, fetchMe: jest.fn() },
      scheduledEvents,
      channels,
    } as never,
    scheduledEvents,
    rest,
    channels,
  };
}

const client = { user: { id: "bot1" }, guilds: { fetch: jest.fn() } } as never;
const passthrough = async <T>(call: () => Promise<T>): Promise<T> => call();
const makeSync = () => new NativeEventSync(client, passthrough as never);

beforeEach(() => {
  jest.clearAllMocks();
  config.getBoolean.mockResolvedValue(true);
  config.getString.mockImplementation(async () => "Somewhere");
});

describe("diffNativeFields, voice link (#1421)", () => {
  const base = buildNativeFields(makeEvent() as never, "Somewhere");
  const withRoom = { ...base, voiceChannelId: ROOM };

  it("external to voice for the main room", () => {
    const diff = diffNativeFields(makeNative() as never, withRoom);
    expect(diff.linkChannel).toBe(ROOM);
    expect(diff.entityType).toBeUndefined();
  });

  it("no change once the native event is linked to that room", () => {
    expect(diffNativeFields(voiceNative(ROOM) as never, withRoom)).toEqual({});
  });

  it("no change without a room: stays external with the text", () => {
    expect(diffNativeFields(makeNative() as never, base)).toEqual({});
  });

  it("voice back to external when there is no room (hand-made or stale)", () => {
    const diff = diffNativeFields(voiceNative("other") as never, base);
    expect(diff.entityType).toBe(GuildScheduledEventEntityType.External);
    expect(diff.channel).toBeNull();
    expect(diff.entityMetadata).toEqual({ location: "Somewhere" });
    expect(diff.linkChannel).toBeUndefined();
  });

  it("a voice event in another channel is put onto the room", () => {
    const diff = diffNativeFields(voiceNative("other") as never, withRoom);
    expect(diff.linkChannel).toBe(ROOM);
    expect(diff.entityType).toBeUndefined();
  });

  it("a stage event is put onto the room", () => {
    const diff = diffNativeFields(
      makeNative({
        entityType: GuildScheduledEventEntityType.StageInstance,
        entityMetadata: null,
        channelId: ROOM,
      }) as never,
      withRoom,
    );
    expect(diff.linkChannel).toBe(ROOM);
  });
});

describe("NativeEventSync link to the voice room (#1421)", () => {
  it("links the main room with one PATCH: voice, channel, null metadata, end", async () => {
    const { guild, rest, scheduledEvents } = makeGuild([makeNative()]);
    await makeSync().syncEvent(makeEvent({ channelId: ROOM }), guild);
    expect(rest.patch).toHaveBeenCalledTimes(1);
    const [route, init] = rest.patch.mock.calls[0] as [
      string,
      { body: Record<string, unknown> },
    ];
    expect(route).toBe("/guilds/g1/scheduled-events/n1");
    expect(init.body).toEqual({
      entity_type: GuildScheduledEventEntityType.Voice,
      channel_id: ROOM,
      entity_metadata: null,
      scheduled_end_time: new Date(
        FUTURE.getTime() + 120 * 60 * 1000,
      ).toISOString(),
    });
    expect(scheduledEvents.edit).not.toHaveBeenCalled();
  });

  it("does nothing while no room exists (keeps the text)", async () => {
    const { guild, rest, scheduledEvents } = makeGuild([makeNative()]);
    await makeSync().syncEvent(makeEvent(), guild);
    expect(rest.patch).not.toHaveBeenCalled();
    expect(scheduledEvents.edit).not.toHaveBeenCalled();
  });

  it("an already linked native event is left alone on later scans", async () => {
    const { guild, rest, scheduledEvents } = makeGuild([voiceNative(ROOM)]);
    await makeSync().syncEvent(makeEvent({ channelId: ROOM }), guild);
    expect(rest.patch).not.toHaveBeenCalled();
    expect(scheduledEvents.edit).not.toHaveBeenCalled();
  });

  // OWNER DECISION NEEDED (#1421): an event with group rooms is not linked
  // (LINK_ROOM_WITH_GROUPS = false) because the main room can empty while the
  // session goes on in the group rooms.
  it("Groups with group rooms: stays external with the text, no voice PATCH (empty main room, occupied group rooms)", async () => {
    const { guild, rest, scheduledEvents } = makeGuild([makeNative()]);
    await makeSync().syncEvent(
      makeEvent({
        channelId: ROOM,
        groupsEnabled: true,
        groups: [
          { key: "a", channelId: "grp1" },
          { key: "b", channelId: "grp2" },
        ],
      }),
      guild,
    );
    expect(rest.patch).not.toHaveBeenCalled();
    expect(scheduledEvents.edit).not.toHaveBeenCalled();
  });

  it("Groups switched on after the link: the link is put back to the text", async () => {
    const { guild, rest, scheduledEvents } = makeGuild([voiceNative(ROOM)]);
    await makeSync().syncEvent(
      makeEvent({
        channelId: ROOM,
        groupsEnabled: true,
        groups: [{ key: "a", channelId: "grp1" }],
      }),
      guild,
    );
    expect(rest.patch).not.toHaveBeenCalled();
    expect(scheduledEvents.edit).toHaveBeenCalledWith(
      "n1",
      expect.objectContaining({
        entityType: GuildScheduledEventEntityType.External,
      }),
    );
  });

  it("Groups on but no group defined: a plain event, still links", async () => {
    const { guild, rest } = makeGuild([makeNative()]);
    await makeSync().syncEvent(
      makeEvent({ channelId: ROOM, groupsEnabled: true, groups: [] }),
      guild,
    );
    expect(rest.patch).toHaveBeenCalledTimes(1);
  });

  it("Groups on but the main room not created yet: nothing is linked", async () => {
    const { guild, rest } = makeGuild([makeNative()]);
    await makeSync().syncEvent(
      makeEvent({
        groupsEnabled: true,
        groups: [{ key: "a", channelId: "grp1" }],
      }),
      guild,
    );
    expect(rest.patch).not.toHaveBeenCalled();
  });

  it("the room was deleted (row has no channel): a KoolBot link is put back to the text", async () => {
    const { guild, scheduledEvents, rest } = makeGuild([voiceNative(ROOM)]);
    await makeSync().syncEvent(makeEvent({ channelId: null }), guild);
    expect(rest.patch).not.toHaveBeenCalled();
    expect(scheduledEvents.edit).toHaveBeenCalledWith(
      "n1",
      expect.objectContaining({
        entityType: GuildScheduledEventEntityType.External,
        channel: null,
        entityMetadata: { location: "Somewhere" },
      }),
    );
  });

  it("a hand-made switch to another channel is moved onto the room", async () => {
    const { guild, rest } = makeGuild([voiceNative("other")]);
    await makeSync().syncEvent(makeEvent({ channelId: ROOM }), guild);
    expect(rest.patch).toHaveBeenCalledTimes(1);
  });

  it("does not convert a running event, and still syncs its end", async () => {
    const want = buildNativeFields(
      makeEvent({ startTime: PAST }) as never,
      "Somewhere",
    );
    const { guild, rest, scheduledEvents } = makeGuild([
      makeNative({
        status: GuildScheduledEventStatus.Active,
        scheduledStartTimestamp: PAST.getTime(),
        scheduledEndTimestamp: want.end.getTime() - 60000,
      }),
    ]);
    await makeSync().syncEvent(
      makeEvent({ channelId: ROOM, startTime: PAST }),
      guild,
    );
    expect(rest.patch).not.toHaveBeenCalled();
    expect(scheduledEvents.edit).toHaveBeenCalledWith(
      "n1",
      expect.objectContaining({ scheduledEndTime: want.end }),
    );
  });

  it("the switch off: no link, and an existing link goes back to the text", async () => {
    config.getBoolean.mockImplementation(
      async (k: string) => k !== "events.native.link_room",
    );
    const a = makeGuild([makeNative()]);
    await makeSync().syncEvent(makeEvent({ channelId: ROOM }), a.guild);
    expect(a.rest.patch).not.toHaveBeenCalled();

    const b = makeGuild([voiceNative(ROOM)]);
    await makeSync().syncEvent(makeEvent({ channelId: ROOM }), b.guild);
    expect(b.scheduledEvents.edit).toHaveBeenCalledWith(
      "n1",
      expect.objectContaining({
        entityType: GuildScheduledEventEntityType.External,
      }),
    );
  });

  describe("a Discord rejection", () => {
    it("is logged once, never thrown, retried on the next scan, and never blocks other edits", async () => {
      const { guild, rest, scheduledEvents } = makeGuild([
        makeNative({ name: "Old name" }),
      ]);
      rest.patch.mockRejectedValue(new Error("Invalid Form Body"));
      const sync = makeSync();
      const event = makeEvent({ channelId: ROOM });

      await expect(sync.syncEvent(event, guild)).resolves.toBeUndefined();
      await expect(sync.syncEvent(event, guild)).resolves.toBeUndefined();

      // Retried on every scan...
      expect(rest.patch).toHaveBeenCalledTimes(2);
      // ...but warned only once, and it is not an error of the lifecycle.
      expect(
        logger.warn.mock.calls.filter((c) => String(c[0]).includes("link")),
      ).toHaveLength(1);
      expect(logger.error).not.toHaveBeenCalled();
      // The name update went out in its own edit both times.
      expect(scheduledEvents.edit).toHaveBeenCalledTimes(2);
      expect(
        (scheduledEvents.edit.mock.calls[0] as unknown[])[1],
      ).toMatchObject({ name: "Game night" });
    });

    it("warns again after a success followed by a new failure", async () => {
      const { guild, rest } = makeGuild([makeNative()]);
      rest.patch
        .mockRejectedValueOnce(new Error("no"))
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error("no again"));
      const sync = makeSync();
      const event = makeEvent({ channelId: ROOM });
      await sync.syncEvent(event, guild);
      await sync.syncEvent(event, guild);
      await sync.syncEvent(event, guild);
      expect(
        logger.warn.mock.calls.filter((c) => String(c[0]).includes("link")),
      ).toHaveLength(2);
    });
  });
});

const unknownChannel = () =>
  Object.assign(Object.create(DiscordAPIError.prototype), { code: 10003 });

describe("link-room review fixes (#1421, Copilot round 1)", () => {
  it("switch turned off during an Active voice event: a duration change still syncs, with no location in the payload", async () => {
    config.getBoolean.mockImplementation(
      async (k: string) => k !== "events.native.link_room",
    );
    const want = buildNativeFields(
      makeEvent({ startTime: PAST, durationMinutes: 180 }) as never,
      "Somewhere",
    );
    const { guild, rest, scheduledEvents } = makeGuild([
      voiceNative(ROOM, {
        status: GuildScheduledEventStatus.Active,
        scheduledStartTimestamp: PAST.getTime(),
        scheduledEndTimestamp: want.end.getTime() - 60 * 60 * 1000,
      }),
    ]);
    await makeSync().syncEvent(
      makeEvent({ channelId: ROOM, startTime: PAST, durationMinutes: 180 }),
      guild,
    );
    expect(rest.patch).not.toHaveBeenCalled();
    expect(scheduledEvents.edit).toHaveBeenCalledTimes(1);
    const patch = (scheduledEvents.edit.mock.calls[0] as unknown[])[1];
    expect(patch).toMatchObject({ scheduledEndTime: want.end });
    expect(patch).not.toHaveProperty("entityMetadata");
    expect(patch).not.toHaveProperty("entityType");
  });

  it("a stored id for a deleted room (Unknown Channel) falls back to the text", async () => {
    const { guild, rest, scheduledEvents, channels } = makeGuild([
      voiceNative(ROOM),
    ]);
    channels.fetch.mockRejectedValue(unknownChannel());
    await makeSync().syncEvent(makeEvent({ channelId: ROOM }), guild);
    expect(rest.patch).not.toHaveBeenCalled();
    expect(scheduledEvents.edit).toHaveBeenCalledWith(
      "n1",
      expect.objectContaining({
        entityType: GuildScheduledEventEntityType.External,
        entityMetadata: { location: "Somewhere" },
      }),
    );
  });

  it("an external native event is never linked to a deleted room", async () => {
    const { guild, rest, scheduledEvents, channels } = makeGuild([
      makeNative(),
    ]);
    channels.fetch.mockRejectedValue(unknownChannel());
    await makeSync().syncEvent(makeEvent({ channelId: ROOM }), guild);
    expect(rest.patch).not.toHaveBeenCalled();
    expect(scheduledEvents.edit).not.toHaveBeenCalled();
  });

  it("a transient fetch failure keeps the current state (linked stays linked)", async () => {
    const { guild, rest, scheduledEvents, channels } = makeGuild([
      voiceNative(ROOM),
    ]);
    channels.fetch.mockRejectedValue(new Error("socket hang up"));
    await makeSync().syncEvent(makeEvent({ channelId: ROOM }), guild);
    expect(rest.patch).not.toHaveBeenCalled();
    expect(scheduledEvents.edit).not.toHaveBeenCalled();
  });

  it("a transient fetch failure does not link an external native event, and retries next scan", async () => {
    const { guild, rest, scheduledEvents, channels } = makeGuild([
      makeNative(),
    ]);
    channels.fetch.mockRejectedValueOnce(new Error("503"));
    const sync = makeSync();
    const event = makeEvent({ channelId: ROOM });
    await sync.syncEvent(event, guild);
    expect(rest.patch).not.toHaveBeenCalled();
    expect(scheduledEvents.edit).not.toHaveBeenCalled();
    await sync.syncEvent(event, guild);
    expect(rest.patch).toHaveBeenCalledTimes(1);
  });

  it("a rejected link still sends the changed duration and location", async () => {
    const want = buildNativeFields(
      makeEvent({ durationMinutes: 180 }) as never,
      "New place",
    );
    config.getString.mockImplementation(async () => "New place");
    const { guild, rest, scheduledEvents } = makeGuild([makeNative()]);
    rest.patch.mockRejectedValue(new Error("Invalid Form Body"));
    await expect(
      makeSync().syncEvent(
        makeEvent({ channelId: ROOM, durationMinutes: 180 }),
        guild,
      ),
    ).resolves.toBeUndefined();
    expect(rest.patch).toHaveBeenCalledTimes(1);
    expect(scheduledEvents.edit).toHaveBeenCalledWith(
      "n1",
      expect.objectContaining({
        scheduledEndTime: want.end,
        entityMetadata: { location: "New place" },
      }),
    );
  });
});

describe("activating the linked voice event (#1421, Copilot round 3)", () => {
  const startedScheduled = (overrides = {}) =>
    voiceNative(ROOM, {
      scheduledStartTimestamp: PAST.getTime(),
      scheduledEndTimestamp: PAST.getTime() + 120 * 60 * 1000,
      ...overrides,
    });
  const startedEvent = () =>
    makeEvent({ channelId: ROOM, startTime: PAST, state: "active" });
  const activations = (edit: jest.Mock) =>
    edit.mock.calls.filter(
      (c) =>
        (c[1] as { status?: number }).status ===
        GuildScheduledEventStatus.Active,
    );

  it("moves a linked Scheduled native event to Active once the start is reached", async () => {
    const { guild, scheduledEvents } = makeGuild([startedScheduled()]);
    await makeSync().syncEvent(startedEvent(), guild);
    expect(scheduledEvents.edit).toHaveBeenCalledWith(
      "n1",
      expect.objectContaining({ status: GuildScheduledEventStatus.Active }),
    );
  });

  it("does not activate before the start time", async () => {
    const { guild, scheduledEvents } = makeGuild([voiceNative(ROOM)]);
    await makeSync().syncEvent(makeEvent({ channelId: ROOM }), guild);
    expect(scheduledEvents.edit).not.toHaveBeenCalled();
  });

  it("does not activate an event that is not linked (external, or no room wanted)", async () => {
    const a = makeGuild([
      makeNative({
        scheduledStartTimestamp: PAST.getTime(),
        scheduledEndTimestamp: PAST.getTime() + 120 * 60 * 1000,
      }),
    ]);
    await makeSync().syncEvent(startedEvent(), a.guild);
    expect(activations(a.scheduledEvents.edit)).toHaveLength(0);

    // Voice event in some other channel while the row has no room.
    const b = makeGuild([startedScheduled({ channelId: "other" })]);
    await makeSync().syncEvent(
      makeEvent({ channelId: null, startTime: PAST, state: "active" }),
      b.guild,
    );
    expect(activations(b.scheduledEvents.edit)).toHaveLength(0);
  });

  it("transient room lookup failure + native event moved to ANOTHER channel: not activated, not converted", async () => {
    const { guild, rest, scheduledEvents, channels } = makeGuild([
      startedScheduled({ channelId: "elsewhere" }),
    ]);
    channels.fetch.mockRejectedValue(new Error("socket hang up"));
    await makeSync().syncEvent(startedEvent(), guild);
    expect(activations(scheduledEvents.edit)).toHaveLength(0);
    expect(rest.patch).not.toHaveBeenCalled();
    expect(scheduledEvents.edit).not.toHaveBeenCalled();
  });

  it("transient room lookup failure + native event in the stored room: still activated", async () => {
    const { guild, scheduledEvents, channels } = makeGuild([
      startedScheduled(),
    ]);
    channels.fetch.mockRejectedValue(new Error("socket hang up"));
    await makeSync().syncEvent(startedEvent(), guild);
    expect(activations(scheduledEvents.edit)).toHaveLength(1);
  });

  describe("link switch off", () => {
    beforeEach(() => {
      config.getBoolean.mockImplementation(
        async (k: string) => k !== "events.native.link_room",
      );
    });

    it("an existing link that is Scheduled past its start is still activated", async () => {
      const { guild, scheduledEvents } = makeGuild([startedScheduled()]);
      await makeSync().syncEvent(startedEvent(), guild);
      expect(activations(scheduledEvents.edit)).toHaveLength(1);
    });

    it("but not when the native channel is not the stored room", async () => {
      const { guild, scheduledEvents } = makeGuild([
        startedScheduled({ channelId: "elsewhere" }),
      ]);
      await makeSync().syncEvent(startedEvent(), guild);
      expect(activations(scheduledEvents.edit)).toHaveLength(0);
    });

    it("and not before the start", async () => {
      const { guild, scheduledEvents } = makeGuild([voiceNative(ROOM)]);
      await makeSync().syncEvent(makeEvent({ channelId: ROOM }), guild);
      expect(activations(scheduledEvents.edit)).toHaveLength(0);
    });
  });

  it("leaves an already Active native event alone", async () => {
    const { guild, scheduledEvents } = makeGuild([
      startedScheduled({ status: GuildScheduledEventStatus.Active }),
    ]);
    await makeSync().syncEvent(startedEvent(), guild);
    expect(scheduledEvents.edit).not.toHaveBeenCalled();
  });

  it("a rejected activation is retried each scan, warned once, and never throws", async () => {
    const { guild, scheduledEvents } = makeGuild([startedScheduled()]);
    scheduledEvents.edit.mockRejectedValue(new Error("no"));
    const sync = makeSync();
    await expect(
      sync.syncEvent(startedEvent(), guild),
    ).resolves.toBeUndefined();
    await expect(
      sync.syncEvent(startedEvent(), guild),
    ).resolves.toBeUndefined();
    expect(activations(scheduledEvents.edit)).toHaveLength(2);
    expect(
      logger.warn.mock.calls.filter((c) =>
        String(c[0]).includes("start linked"),
      ),
    ).toHaveLength(1);
    expect(logger.error).not.toHaveBeenCalled();

    // Then it works: the next scan activates and stops once Active.
    scheduledEvents.edit.mockResolvedValue({});
    await sync.syncEvent(startedEvent(), guild);
    expect(activations(scheduledEvents.edit)).toHaveLength(3);
  });
});

describe("impromptu window (#1421, Copilot round 2)", () => {
  it("links right after the room exists (start +30s), and the scan after the start has nothing left to link", async () => {
    const start = new Date(Date.now() + 30 * 1000);
    const { guild, rest, scheduledEvents } = makeGuild([
      makeNative({
        scheduledStartTimestamp: start.getTime(),
        scheduledEndTimestamp: start.getTime() + 120 * 60 * 1000,
      }),
    ]);
    const sync = makeSync();

    // Immediate sync, called by startEventNow as soon as the room is claimed.
    await sync.syncEvent(
      makeEvent({ channelId: ROOM, startTime: start, state: "active" }),
      guild,
    );
    expect(rest.patch).toHaveBeenCalledTimes(1);

    // The native event is now the voice event Discord would return; the next
    // scan runs after the start time and does not need to link again.
    const linked = voiceNative(ROOM, {
      status: GuildScheduledEventStatus.Active,
      scheduledStartTimestamp: PAST.getTime(),
      scheduledEndTimestamp: PAST.getTime() + 120 * 60 * 1000,
    });
    const later = makeGuild([linked]);
    await sync.syncEvent(
      makeEvent({ channelId: ROOM, startTime: PAST, state: "active" }),
      later.guild,
    );
    expect(later.rest.patch).not.toHaveBeenCalled();
    expect(later.scheduledEvents.edit).not.toHaveBeenCalled();
    expect(scheduledEvents.edit).not.toHaveBeenCalled();
  });

  it("without the immediate sync the scan after the start never links (why it exists)", async () => {
    const { guild, rest } = makeGuild([
      makeNative({
        status: GuildScheduledEventStatus.Active,
        scheduledStartTimestamp: PAST.getTime(),
        scheduledEndTimestamp: PAST.getTime() + 120 * 60 * 1000,
      }),
    ]);
    await makeSync().syncEvent(
      makeEvent({ channelId: ROOM, startTime: PAST, state: "active" }),
      guild,
    );
    expect(rest.patch).not.toHaveBeenCalled();
  });
});
