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
    fetch: jest.fn(async (arg?: string | { guildScheduledEvent: string }) => {
      const id = typeof arg === "object" ? arg.guildScheduledEvent : arg;
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

/** Marker writes always succeed; the id claim (which resets the marker to
 * null) gets `claim`: a document, null (lost), or an Error to throw. */
function mockClaim(claim: unknown): void {
  EventMock.findOneAndUpdate.mockImplementation(async (...args: unknown[]) => {
    const set = (args[1] as { $set: Record<string, unknown> }).$set;
    if (set.nativeCreateStartedAt instanceof Date) return { _id: "ev1" };
    if (claim instanceof Error) throw claim;
    return claim;
  });
}

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

describe("buildNativeFields, impromptu (#1305)", () => {
  const start = new Date("2026-07-04T20:00:00Z");
  it("leads the description with the happening-now note", () => {
    const f = buildNativeFields(
      {
        title: "Now",
        description: "Bring snacks",
        startTime: start,
        durationMinutes: 60,
        impromptu: true,
      } as never,
      "Somewhere",
    );
    expect(f.description).toBe("Happening now.\n\nBring snacks");
    const bare = buildNativeFields(
      {
        title: "Now",
        description: "",
        startTime: start,
        durationMinutes: 60,
        impromptu: true,
      } as never,
      "Somewhere",
    );
    expect(bare.description).toBe("Happening now.");
  });
  it("leaves a planned event's description alone", () => {
    const f = buildNativeFields(
      {
        title: "Planned",
        description: "Bring snacks",
        startTime: start,
        durationMinutes: 60,
      } as never,
      "Somewhere",
    );
    expect(f.description).toBe("Bring snacks");
  });
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

describe("NativeEventSync.linkedStatus (#1298)", () => {
  const ev = { guildId: "g1", nativeEventId: "n1" };

  it("is none without a link, and when the native event no longer exists", async () => {
    const { guild } = makeGuild();
    const sync = makeSync();
    (sync as unknown as { client: unknown }).client = {
      guilds: { fetch: async () => guild },
    };
    expect(
      await sync.linkedStatus({ guildId: "g1", nativeEventId: null }),
    ).toBe("none");
    expect(await sync.linkedStatus(ev)).toBe("none");
  });

  it.each([
    [GuildScheduledEventStatus.Scheduled, "scheduled"],
    [GuildScheduledEventStatus.Active, "locked"],
    [GuildScheduledEventStatus.Completed, "locked"],
    [GuildScheduledEventStatus.Canceled, "locked"],
  ])("maps native status %s to %s", async (status, expected) => {
    const { guild } = makeGuild({ natives: [makeNative({ status })] });
    const sync = makeSync();
    (sync as unknown as { client: unknown }).client = {
      guilds: { fetch: async () => guild },
    };
    expect(await sync.linkedStatus(ev)).toBe(expected);
  });

  it("reads live state, not the manager cache, so an event started in Discord since the last scan is locked", async () => {
    const stale = makeNative({ status: GuildScheduledEventStatus.Scheduled });
    const live = makeNative({ status: GuildScheduledEventStatus.Active });
    const fetch = jest.fn(
      async (
        arg?: string | { guildScheduledEvent: string; force?: boolean },
      ) => (typeof arg === "object" && arg.force ? live : stale),
    );
    const sync = makeSync();
    (sync as unknown as { client: unknown }).client = {
      guilds: { fetch: async () => ({ scheduledEvents: { fetch } }) },
    };
    expect(await sync.linkedStatus(ev)).toBe("locked");
    expect(fetch).toHaveBeenCalledWith({
      guildScheduledEvent: "n1",
      force: true,
    });
  });

  it("is unknown when Discord cannot be read", async () => {
    const sync = makeSync();
    (sync as unknown as { client: unknown }).client = {
      guilds: {
        fetch: async () => {
          throw new Error("down");
        },
      },
    };
    expect(await sync.linkedStatus(ev)).toBe("unknown");
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
      { $set: { nativeEventId: "created1", nativeCreateStartedAt: null } },
    );
    expect((event as { nativeEventId: string }).nativeEventId).toBe("created1");
  });

  it("starts a create only for the title and start the scan read (#1298)", async () => {
    const { guild } = makeGuild();
    const ev = makeEvent();
    await makeSync().syncEvent(ev, guild);
    const filter = EventMock.findOneAndUpdate.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(filter).toMatchObject({
      title: "Game night",
      startTime: FUTURE,
      nativeEventId: null,
    });
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
      $set: { nativeEventId: "orphan1", nativeCreateStartedAt: null },
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
    mockClaim(null);
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

  it("patches a moved start, a new title and a new duration in one edit, and never deletes or recreates (#1298)", async () => {
    // The native event still shows the old schedule; the row was edited.
    const { guild, scheduledEvents } = makeGuild({ natives: [makeNative()] });
    const moved = new Date(FUTURE.getTime() + 2 * 60 * 60 * 1000);
    await makeSync().syncEvent(
      makeEvent({
        nativeEventId: "n1",
        title: "Game night (moved)",
        startTime: moved,
        durationMinutes: 60,
      }),
      guild,
    );
    expect(scheduledEvents.edit).toHaveBeenCalledTimes(1);
    expect(scheduledEvents.edit).toHaveBeenCalledWith(
      "n1",
      expect.objectContaining({
        name: "Game night (moved)",
        scheduledStartTime: moved,
        scheduledEndTime: new Date(moved.getTime() + 60 * 60 * 1000),
      }),
    );
    // Same native event, so the Interested list survives.
    expect(scheduledEvents.create).not.toHaveBeenCalled();
    expect(scheduledEvents.delete).not.toHaveBeenCalled();
  });

  describe("running (Active) native events", () => {
    const active = (o: Record<string, unknown> = {}) =>
      makeNative({ status: GuildScheduledEventStatus.Active, ...o });

    it("pushes name, description and location in one patch without start, end or type, and the end on its own", async () => {
      const { guild, scheduledEvents } = makeGuild({
        natives: [
          active({
            name: "Old",
            description: "old text",
            entityMetadata: { location: "Elsewhere" },
            scheduledStartTimestamp: 1,
            scheduledEndTimestamp: 2,
          }),
        ],
      });
      await makeSync().syncEvent(makeEvent({ nativeEventId: "n1" }), guild);
      expect(scheduledEvents.edit).toHaveBeenCalledTimes(2);
      const patch = (
        scheduledEvents.edit.mock.calls[0] as unknown[]
      )[1] as Record<string, unknown>;
      // The host can change a running event's length (#1298): the end is sent
      // alone, never with the locked start.
      const endPatch = (
        scheduledEvents.edit.mock.calls[1] as unknown[]
      )[1] as Record<string, unknown>;
      expect(Object.keys(endPatch).sort()).toEqual([
        "reason",
        "scheduledEndTime",
      ]);
      expect(patch).toMatchObject({
        name: "Game night",
        description: "Bring snacks",
        entityMetadata: { location: "Somewhere" },
      });
      expect(patch).not.toHaveProperty("scheduledStartTime");
      expect(patch).not.toHaveProperty("scheduledEndTime");
      expect(patch).not.toHaveProperty("entityType");
    });

    it("sends no end for a running event whose new end is already past", async () => {
      const { guild, scheduledEvents } = makeGuild({
        natives: [active({ scheduledEndTimestamp: FUTURE.getTime() + 1 })],
      });
      await makeSync().syncEvent(
        makeEvent({
          nativeEventId: "n1",
          startTime: new Date(Date.now() - 3 * 60 * 60 * 1000),
          durationMinutes: 60,
        }),
        guild,
      );
      expect(scheduledEvents.edit).not.toHaveBeenCalled();
    });

    it("also moves the end of a Scheduled native event whose start has passed", async () => {
      // A late create can leave the native event Scheduled after its start.
      const start = new Date(Date.now() - 30 * 60 * 1000);
      const { guild, scheduledEvents } = makeGuild({
        natives: [
          makeNative({
            status: GuildScheduledEventStatus.Scheduled,
            scheduledStartTimestamp: start.getTime(),
            scheduledEndTimestamp: start.getTime() + 60 * 60 * 1000,
          }),
        ],
      });
      await makeSync().syncEvent(
        makeEvent({
          nativeEventId: "n1",
          startTime: start,
          durationMinutes: 180,
        }),
        guild,
      );
      expect(scheduledEvents.edit).toHaveBeenCalledTimes(1);
      const patch = (
        scheduledEvents.edit.mock.calls[0] as unknown[]
      )[1] as Record<string, unknown>;
      expect(Object.keys(patch).sort()).toEqual(["reason", "scheduledEndTime"]);
    });

    it("logs a rejected end edit once and does not throw", async () => {
      const { guild, scheduledEvents } = makeGuild({
        natives: [active({ scheduledEndTimestamp: 2 })],
      });
      scheduledEvents.edit.mockRejectedValue(new Error("rejected"));
      const sync = makeSync();
      const ev = makeEvent({ nativeEventId: "n1" });
      await expect(sync.syncEvent(ev, guild)).resolves.toBeUndefined();
      await sync.syncEvent(ev, guild);
      expect(
        logger.warn.mock.calls.filter((c) =>
          String(c[0]).includes("move the end"),
        ),
      ).toHaveLength(1);
    });

    it("logs a rejected edit and does not throw", async () => {
      const { guild, scheduledEvents } = makeGuild({
        natives: [active({ name: "Old" })],
      });
      scheduledEvents.edit.mockRejectedValueOnce(new Error("rejected"));
      await expect(
        makeSync().syncEvent(makeEvent({ nativeEventId: "n1" }), guild),
      ).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalled();
    });

    it("does nothing for a native event that already finished", async () => {
      const { guild, scheduledEvents } = makeGuild({
        natives: [
          makeNative({
            name: "Old",
            status: GuildScheduledEventStatus.Completed,
          }),
        ],
      });
      await makeSync().syncEvent(makeEvent({ nativeEventId: "n1" }), guild);
      expect(scheduledEvents.edit).not.toHaveBeenCalled();
    });
  });

  describe("timed-out create that crosses the start time", () => {
    const PAST = new Date(Date.now() - 60 * 1000);
    const marked = (ageMs: number, extra: Record<string, unknown> = {}) =>
      makeEvent({
        startTime: PAST,
        nativeCreateStartedAt: new Date(Date.now() - ageMs),
        ...extra,
      });
    const lateNative = (status: GuildScheduledEventStatus) =>
      makeNative({
        id: "late1",
        status,
        scheduledStartTimestamp: PAST.getTime(),
        scheduledEndTimestamp: PAST.getTime() + 120 * 60 * 1000,
      });

    for (const [label, status] of [
      ["Scheduled", GuildScheduledEventStatus.Scheduled],
      ["Active", GuildScheduledEventStatus.Active],
    ] as const) {
      it(`adopts a late ${label} event for a still-open row`, async () => {
        const { guild, scheduledEvents } = makeGuild({
          natives: [lateNative(status)],
        });
        await makeSync().syncEvent(marked(1000), guild);
        expect(scheduledEvents.create).not.toHaveBeenCalled();
        expect(EventMock.findOneAndUpdate).toHaveBeenCalledWith(
          expect.anything(),
          { $set: { nativeEventId: "late1", nativeCreateStartedAt: null } },
        );
      });

      it(`closes a late ${label} event once its row has finished`, async () => {
        const { guild, scheduledEvents } = makeGuild({
          natives: [lateNative(status)],
        });
        await makeSync().syncEvent(marked(1000, { state: "cancelled" }), guild);
        const closed =
          status === GuildScheduledEventStatus.Active
            ? GuildScheduledEventStatus.Completed
            : GuildScheduledEventStatus.Canceled;
        expect(scheduledEvents.edit).toHaveBeenCalledWith(
          "late1",
          expect.objectContaining({ status: closed }),
        );
      });
    }

    it("never creates in the past, and drops the marker after the grace period", async () => {
      const { CREATE_GRACE_MS } =
        await import("../../src/services/event-native-sync.js");
      const { guild, scheduledEvents } = makeGuild();
      await makeSync().syncEvent(marked(1000), guild);
      expect(scheduledEvents.create).not.toHaveBeenCalled();
      expect(EventMock.updateOne).not.toHaveBeenCalled();
      await makeSync().syncEvent(marked(CREATE_GRACE_MS + 1000), guild);
      expect(scheduledEvents.create).not.toHaveBeenCalled();
      expect(EventMock.updateOne).toHaveBeenCalledWith(
        { _id: "ev1" },
        { $set: { nativeCreateStartedAt: null } },
      );
    });

    it("without a marker a past start still does nothing at all", async () => {
      const { guild, scheduledEvents } = makeGuild();
      await makeSync().syncEvent(makeEvent({ startTime: PAST }), guild);
      expect(scheduledEvents.create).not.toHaveBeenCalled();
      expect(scheduledEvents.fetch).not.toHaveBeenCalled();
      expect(EventMock.updateOne).not.toHaveBeenCalled();
    });
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

  it("treats a unique-index conflict on the claim as a lost race", async () => {
    mockClaim(
      Object.assign(new Error("E11000 duplicate key"), { code: 11000 }),
    );
    const orphan = makeNative({ id: "orphan1" });
    const { guild, scheduledEvents } = makeGuild({ natives: [orphan] });
    const event = makeEvent();
    await expect(makeSync().syncEvent(event, guild)).resolves.toBeUndefined();
    // Adopting: the native event belongs to the other row, so it is left alone.
    expect(scheduledEvents.delete).not.toHaveBeenCalled();
    expect((event as { nativeEventId: unknown }).nativeEventId).toBeNull();
  });

  it("removes the event it created when the claim hits the unique index", async () => {
    mockClaim(
      Object.assign(new Error("E11000 duplicate key"), { code: 11000 }),
    );
    const { guild, scheduledEvents } = makeGuild();
    await makeSync().syncEvent(makeEvent(), guild);
    expect(scheduledEvents.delete).toHaveBeenCalledWith("created1");
  });

  it("clears a removed description with null, never an empty string", async () => {
    const { guild, scheduledEvents } = makeGuild({
      natives: [makeNative()],
    });
    await makeSync().syncEvent(
      makeEvent({ nativeEventId: "n1", description: "" }),
      guild,
    );
    expect(scheduledEvents.edit).toHaveBeenCalledWith(
      "n1",
      expect.objectContaining({ description: null }),
    );
  });

  it("omits an empty description when creating", async () => {
    const { guild, scheduledEvents } = makeGuild();
    await makeSync().syncEvent(makeEvent({ description: "" }), guild);
    const arg = (
      scheduledEvents.create.mock.calls[0] as unknown[]
    )[0] as Record<string, unknown>;
    expect(arg.description).toBeUndefined();
  });

  it("does not delete a created event another row has since claimed", async () => {
    mockClaim(null);
    EventMock.exists.mockResolvedValue({ _id: "other" });
    const { guild, scheduledEvents } = makeGuild();
    await makeSync().syncEvent(makeEvent(), guild);
    expect(scheduledEvents.create).toHaveBeenCalledTimes(1);
    expect(scheduledEvents.delete).not.toHaveBeenCalled();
  });

  it("restores the external type when an admin switched the mirror to a voice event", async () => {
    const { guild, scheduledEvents } = makeGuild({
      natives: [
        makeNative({
          entityType: GuildScheduledEventEntityType.Voice,
          entityMetadata: null,
          channelId: "vc1",
        }),
      ],
    });
    await makeSync().syncEvent(makeEvent({ nativeEventId: "n1" }), guild);
    expect(scheduledEvents.edit).toHaveBeenCalledWith(
      "n1",
      expect.objectContaining({
        entityType: GuildScheduledEventEntityType.External,
        channel: null,
        entityMetadata: { location: "Somewhere" },
        scheduledEndTime: expect.any(Date),
      }),
    );
  });

  describe("create markers (timed-out creates)", () => {
    // Emulates the marker compare-and-set against one row's stored value.
    function markerDb(initial: Date | null) {
      let startedAt = initial;
      EventMock.findOneAndUpdate.mockImplementation(
        async (...args: unknown[]) => {
          const filter = args[0] as {
            $or?: Array<{ nativeCreateStartedAt: null | { $lt: Date } }>;
          };
          const set = (args[1] as { $set: Record<string, unknown> }).$set;
          if (set.nativeCreateStartedAt instanceof Date) {
            const ok = filter.$or!.some((c) =>
              c.nativeCreateStartedAt === null
                ? startedAt === null
                : startedAt !== null &&
                  startedAt.getTime() < c.nativeCreateStartedAt.$lt.getTime(),
            );
            if (!ok) return null;
            startedAt = set.nativeCreateStartedAt;
            return { _id: "ev1" };
          }
          startedAt = null; // the id claim resets the marker
          return { _id: "ev1" };
        },
      );
      return () => startedAt;
    }

    it("adopts a late-appearing event on a later scan instead of creating again", async () => {
      const marker = markerDb(null);
      const first = makeGuild();
      first.scheduledEvents.create.mockRejectedValueOnce(new Error("timeout"));
      const sync = makeSync();
      await sync.syncEvent(makeEvent(), first.guild);
      expect(marker()).not.toBeNull(); // marker kept for the later scan

      // The timed-out request completed in Discord after all.
      const second = makeGuild({ natives: [makeNative({ id: "late1" })] });
      await sync.syncEvent(makeEvent(), second.guild);
      expect(second.scheduledEvents.create).not.toHaveBeenCalled();
      expect(EventMock.findOneAndUpdate).toHaveBeenLastCalledWith(
        expect.anything(),
        { $set: { nativeEventId: "late1", nativeCreateStartedAt: null } },
      );
    });

    it("does not retry within the grace period, then retries after it", async () => {
      const { CREATE_GRACE_MS } =
        await import("../../src/services/event-native-sync.js");
      markerDb(new Date(Date.now() - 60 * 1000));
      const within = makeGuild();
      await makeSync().syncEvent(makeEvent(), within.guild);
      expect(within.scheduledEvents.create).not.toHaveBeenCalled();

      markerDb(new Date(Date.now() - CREATE_GRACE_MS - 1000));
      const after = makeGuild();
      await makeSync().syncEvent(makeEvent(), after.guild);
      expect(after.scheduledEvents.create).toHaveBeenCalledTimes(1);
    });

    it("clears the marker when Discord rejects the create outright", async () => {
      markerDb(null);
      const { guild, scheduledEvents } = makeGuild();
      scheduledEvents.create.mockRejectedValueOnce(
        Object.assign(Object.create(DiscordAPIError.prototype), {
          code: 50013,
        }),
      );
      await makeSync().syncEvent(makeEvent(), guild);
      expect(EventMock.updateOne).toHaveBeenCalledWith(
        { _id: "ev1" },
        { $set: { nativeCreateStartedAt: null } },
      );
    });
  });

  describe("past-start and conversion patches", () => {
    const voiceNative = (overrides: Record<string, unknown> = {}) =>
      makeNative({
        entityType: GuildScheduledEventEntityType.Voice,
        entityMetadata: null,
        channelId: "vc1",
        ...overrides,
      });
    const PAST = new Date(Date.now() - 60 * 1000);

    it("sends only safe fields (no bare location) for a started voice-type native event", async () => {
      const { guild, scheduledEvents } = makeGuild({
        natives: [
          voiceNative({
            name: "Old name",
            scheduledStartTimestamp: PAST.getTime(),
            // End already matches: this test is about the name patch only
            // (a stale end now goes out as its own end-only patch, #1421).
            scheduledEndTimestamp: PAST.getTime() + 120 * 60 * 1000,
          }),
        ],
      });
      await makeSync().syncEvent(
        makeEvent({ nativeEventId: "n1", startTime: PAST }),
        guild,
      );
      expect(scheduledEvents.edit).toHaveBeenCalledTimes(1);
      const patch = (
        scheduledEvents.edit.mock.calls[0] as unknown[]
      )[1] as Record<string, unknown>;
      expect(patch.name).toBe("Game night");
      expect(patch).not.toHaveProperty("entityMetadata");
      expect(patch).not.toHaveProperty("entityType");
    });

    it("still sends the location for a started event that is already external", async () => {
      const { guild, scheduledEvents } = makeGuild({
        natives: [
          makeNative({
            entityMetadata: { location: "Elsewhere" },
            scheduledStartTimestamp: PAST.getTime(),
          }),
        ],
      });
      await makeSync().syncEvent(
        makeEvent({ nativeEventId: "n1", startTime: PAST }),
        guild,
      );
      expect(scheduledEvents.edit).toHaveBeenCalledWith(
        "n1",
        expect.objectContaining({ entityMetadata: { location: "Somewhere" } }),
      );
    });

    it("a rejected conversion does not block the name update", async () => {
      const { guild, scheduledEvents } = makeGuild({
        natives: [voiceNative({ name: "Old name" })],
      });
      scheduledEvents.edit
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error("rejected"));
      await makeSync().syncEvent(makeEvent({ nativeEventId: "n1" }), guild);
      const first = (
        scheduledEvents.edit.mock.calls[0] as unknown[]
      )[1] as Record<string, unknown>;
      expect(first.name).toBe("Game night");
      expect(first).not.toHaveProperty("entityType");
      expect(scheduledEvents.edit).toHaveBeenCalledTimes(2);
    });
  });

  describe("timed-out creates on finished rows", () => {
    const pending = (state: string, ageMs: number) =>
      makeEvent({
        state,
        nativeEventId: null,
        nativeCreateStartedAt: new Date(Date.now() - ageMs),
      });

    it("cancels a late-created native event of a cancelled row and clears the marker", async () => {
      const { guild, scheduledEvents } = makeGuild({
        natives: [makeNative({ id: "late1" })],
      });
      await makeSync().syncEvent(pending("cancelled", 1000), guild);
      expect(scheduledEvents.edit).toHaveBeenCalledWith(
        "late1",
        expect.objectContaining({ status: GuildScheduledEventStatus.Canceled }),
      );
      expect(EventMock.updateOne).toHaveBeenCalledWith(
        { _id: "ev1" },
        { $set: { nativeCreateStartedAt: null } },
      );
    });

    it("deletes a late-created native event of an ended row", async () => {
      const { guild, scheduledEvents } = makeGuild({
        natives: [makeNative({ id: "late1" })],
      });
      await makeSync().syncEvent(pending("ended", 1000), guild);
      expect(scheduledEvents.delete).toHaveBeenCalledWith("late1");
    });

    it("keeps waiting inside the grace period, then clears the marker", async () => {
      const { CREATE_GRACE_MS } =
        await import("../../src/services/event-native-sync.js");
      const { guild } = makeGuild();
      await makeSync().syncEvent(pending("cancelled", 1000), guild);
      expect(EventMock.updateOne).not.toHaveBeenCalled();
      await makeSync().syncEvent(
        pending("cancelled", CREATE_GRACE_MS + 1000),
        guild,
      );
      expect(EventMock.updateOne).toHaveBeenCalledWith(
        { _id: "ev1" },
        { $set: { nativeCreateStartedAt: null } },
      );
    });

    it("ignores a finished row with no marker and no id", async () => {
      const { guild, scheduledEvents } = makeGuild();
      await makeSync().syncEvent(
        makeEvent({ state: "cancelled", nativeEventId: null }),
        guild,
      );
      expect(scheduledEvents.fetch).not.toHaveBeenCalled();
    });
  });

  describe("loadCache", () => {
    it('reports "failed" (not null) when the listing fails, null when off', async () => {
      const { guild, scheduledEvents } = makeGuild();
      scheduledEvents.fetch.mockRejectedValueOnce(new Error("503"));
      expect(await makeSync().loadCache(guild)).toBe("failed");
      config.getBoolean.mockResolvedValue(false);
      expect(await makeSync().loadCache(guild)).toBeNull();
    });
  });

  it("does not let a later row adopt a native event that an earlier row's close just deleted", async () => {
    const { guild, scheduledEvents } = makeGuild({ natives: [makeNative()] });
    const cache = await scheduledEvents.fetch();
    const sync = makeSync();
    await sync.syncEvent(
      makeEvent({ _id: "evA", state: "ended", nativeEventId: "n1" }),
      guild,
      cache as never,
    );
    expect(scheduledEvents.delete).toHaveBeenCalledWith("n1");
    await sync.syncEvent(makeEvent({ _id: "evB" }), guild, cache as never);
    expect(EventMock.findOneAndUpdate).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        $set: expect.objectContaining({ nativeEventId: "n1" }),
      }),
    );
    expect(scheduledEvents.create).toHaveBeenCalledTimes(1);
  });

  describe("closing a link for a discarded duplicate", () => {
    it("releases the link when the native event is already gone (10070)", async () => {
      const { guild, scheduledEvents } = makeGuild({ natives: [] });
      const event = makeEvent({ state: "cancelled", nativeEventId: "gone1" });
      await makeSync().syncEvent(event, guild);
      expect(scheduledEvents.edit).not.toHaveBeenCalled();
      expect(EventMock.updateOne).toHaveBeenCalledWith(
        { _id: "ev1", nativeEventId: "gone1" },
        { $set: { nativeEventId: null } },
      );
      expect((event as { nativeEventId: unknown }).nativeEventId).toBeNull();
    });

    it("leaves the link in place when mirroring is disabled", async () => {
      config.getBoolean.mockResolvedValue(false);
      const { guild, scheduledEvents } = makeGuild({ natives: [makeNative()] });
      const event = makeEvent({ state: "cancelled", nativeEventId: "n1" });
      await makeSync().syncEvent(event, guild);
      expect(scheduledEvents.edit).not.toHaveBeenCalled();
      expect((event as { nativeEventId: unknown }).nativeEventId).toBe("n1");
    });

    it("leaves the link in place when the close fails", async () => {
      const { guild, scheduledEvents } = makeGuild({ natives: [makeNative()] });
      scheduledEvents.edit.mockRejectedValueOnce(new Error("503"));
      const event = makeEvent({ state: "cancelled", nativeEventId: "n1" });
      await makeSync().syncEvent(event, guild);
      expect((event as { nativeEventId: unknown }).nativeEventId).toBe("n1");
    });
  });

  describe("native-only, gated by the Events feature", () => {
    // A stored `events.native.enabled` value (removed in #1175) must have no effect.
    const byKey = (events: boolean, legacyNative?: boolean) =>
      config.getBoolean.mockImplementation(async (k: string, d?: boolean) =>
        k === "events.enabled"
          ? events
          : k === "events.native.enabled"
            ? (legacyNative ?? (d as boolean))
            : (d as boolean),
      );

    it("does nothing at all when Events are off", async () => {
      byKey(false, true);
      const { guild, scheduledEvents } = makeGuild({ perms: [] });
      const sync = makeSync();
      await sync.syncEvent(makeEvent(), guild);
      expect(await sync.loadCache(guild)).toBeNull();
      expect(scheduledEvents.fetch).not.toHaveBeenCalled();
      expect(scheduledEvents.create).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("always creates the native event when Events are on", async () => {
      byKey(true, undefined);
      const { guild, scheduledEvents } = makeGuild();
      await makeSync().syncEvent(makeEvent(), guild);
      expect(scheduledEvents.create).toHaveBeenCalledTimes(1);
    });

    it("ignores a leftover events.native.enabled=false value", async () => {
      byKey(true, false);
      const { guild, scheduledEvents } = makeGuild();
      await makeSync().syncEvent(makeEvent(), guild);
      expect(scheduledEvents.create).toHaveBeenCalledTimes(1);
    });

    it("the missing-permission warning names the permission, not a removed setting", async () => {
      byKey(true, true);
      const { guild } = makeGuild({ perms: [] });
      await makeSync().syncEvent(makeEvent(), guild);
      const text = String(logger.warn.mock.calls[0][0]);
      expect(text).not.toMatch(/events\.native\.enabled/);
      expect(text).toMatch(/Create Events/);
    });

    it("creates at most MAX_CREATES_PER_SCAN native events per scan", async () => {
      const { MAX_CREATES_PER_SCAN } =
        await import("../../src/services/event-native-sync.js");
      const { guild, scheduledEvents } = makeGuild();
      const sync = makeSync();
      const cache = (await sync.loadCache(guild)) as never;
      for (let i = 0; i < MAX_CREATES_PER_SCAN + 3; i++) {
        await sync.syncEvent(
          makeEvent({ _id: `ev${i}`, title: `Event ${i}` }),
          guild,
          cache,
        );
      }
      expect(scheduledEvents.create).toHaveBeenCalledTimes(
        MAX_CREATES_PER_SCAN,
      );
      // The next scan picks the rest up.
      const next = (await sync.loadCache(guild)) as never;
      await sync.syncEvent(
        makeEvent({ _id: "ev9", title: "Event 9" }),
        guild,
        next,
      );
      expect(scheduledEvents.create).toHaveBeenCalledTimes(
        MAX_CREATES_PER_SCAN + 1,
      );
    });

    it("never holds back a single create made without a scan cache", async () => {
      const { MAX_CREATES_PER_SCAN } =
        await import("../../src/services/event-native-sync.js");
      const { guild, scheduledEvents } = makeGuild();
      const sync = makeSync();
      for (let i = 0; i < MAX_CREATES_PER_SCAN + 2; i++) {
        await sync.syncEvent(
          makeEvent({ _id: `ev${i}`, title: `Event ${i}` }),
          guild,
        );
      }
      expect(scheduledEvents.create).toHaveBeenCalledTimes(
        MAX_CREATES_PER_SCAN + 2,
      );
    });
  });
});
