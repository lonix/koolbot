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
    } as never,
    scheduledEvents,
    rest,
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

  it("Groups on: only the main room is linked, never a group room", async () => {
    const { guild, rest } = makeGuild([makeNative()]);
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
    expect(rest.patch).toHaveBeenCalledTimes(1);
    const init = (rest.patch.mock.calls[0] as unknown[])[1] as {
      body: { channel_id: string };
    };
    expect(init.body.channel_id).toBe(ROOM);
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
