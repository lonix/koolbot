import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { ChannelType, DiscordAPIError } from "discord.js";

// How EventService drives the group channels (#1190). The channel work itself
// is covered in event-group-channels.test.ts; here the point is the wiring, and
// above all that a plain event behaves exactly as before: the same single
// channel create, and no extra Discord or database call.

const configMock = {
  registerReloadCallback: jest.fn(),
  addChangeListener: jest.fn(),
  getBoolean: jest.fn(async (_k: string, d?: unknown) => d),
  getString: jest.fn(async (_k: string, d?: unknown) => d),
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
  deleteOne: jest.Mock;
};
const { EventService } = await import("../../src/services/event-service.js");

const MIN = 60_000;
const NOW = new Date("2026-07-04T19:50:00Z");
const START = new Date("2026-07-04T20:00:00Z");
const HOST = "222222222222222222";
const CATEGORY = "cat-1";

interface Priv {
  processEvent: (...a: unknown[]) => Promise<void>;
  cancelOne: (e: unknown) => Promise<void>;
  createEventChannel: (e: unknown, g: unknown) => Promise<unknown>;
  runOnce: () => Promise<void>;
  nativeSync: Record<string, jest.Mock>;
  updateAnnouncement: jest.Mock;
  groupChannels: {
    reconcile: jest.Mock;
    cleanup: jest.Mock;
  };
  client: unknown;
}

function setup(clientOverrides: Record<string, unknown> = {}): {
  service: Priv;
  guild: ReturnType<typeof makeGuild>;
} {
  EventService.reset();
  const guild = makeGuild();
  const client = {
    guilds: { fetch: jest.fn(async () => guild) },
    ...clientOverrides,
  };
  const service = EventService.getInstance(client as never) as unknown as Priv;
  service.nativeSync = {
    syncEvent: jest.fn(async () => undefined),
    loadCache: jest.fn(async () => null),
    pullAdopted: jest.fn(),
    adoptedHasChannel: jest.fn(),
  };
  service.updateAnnouncement = jest.fn(async () => true);
  // The real object (its host-overwrite logic is used by the main channel);
  // only the two network-facing passes are replaced.
  service.groupChannels.reconcile = jest.fn(async () => emptyReport());
  service.groupChannels.cleanup = jest.fn(async () => emptyReport());
  return { service, guild };
}

function emptyReport(): {
  created: number;
  removed: number;
  occupied: number;
  failures: never[];
  warnings: never[];
} {
  return { created: 0, removed: 0, occupied: 0, failures: [], warnings: [] };
}

function makeGuild() {
  const category = {
    id: CATEGORY,
    type: ChannelType.GuildCategory,
    permissionOverwrites: { cache: new Map() },
  };
  const cache = new Map<string, unknown>([[CATEGORY, category]]);
  return {
    id: "guild-1",
    members: { me: null },
    channels: {
      cache,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      create: jest.fn(async (_o: Record<string, unknown>) => ({
        id: "main-1",
      })),
      fetch: jest.fn(async () => null),
    },
  };
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: "evt1",
    guildId: "guild-1",
    title: "Game Night",
    startTime: START,
    durationMinutes: 120,
    categoryId: CATEGORY,
    channelId: null,
    state: "scheduled",
    reminderSent: true,
    recurrence: "none",
    seriesId: null,
    createdBy: HOST,
    save: jest.fn(async () => undefined),
    ...overrides,
  };
}

function groupRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return row({
    groupsEnabled: true,
    groups: [
      { key: "g_a", name: "Alpha", size: 5, marker: "", channelId: null },
      { key: "g_b", name: "Bravo", size: null, marker: "", channelId: null },
    ],
    ...overrides,
  });
}

const WINDOWS = { reminderMs: 0, leadMs: 15 * MIN, graceMs: 15 * MIN };

beforeEach(() => {
  EventMock.find = jest.fn(async () => []);
  EventMock.findOneAndUpdate = jest.fn(async () => ({ _id: "evt1" }));
  EventMock.findById = jest.fn(async () => null);
  EventMock.updateOne = jest.fn(async () => ({ matchedCount: 1 }));
  EventMock.deleteOne = jest.fn(async () => ({}));
});

describe("a plain event is exactly as before (#1190)", () => {
  it("creates its channel with the one same call and touches no group code, fetch or update", async () => {
    const { service, guild } = setup();
    await service.processEvent(row(), guild, NOW, WINDOWS);

    expect(guild.channels.create).toHaveBeenCalledTimes(1);
    expect(guild.channels.create).toHaveBeenCalledWith({
      name: "📅 Game Night",
      type: ChannelType.GuildVoice,
      parent: guild.channels.cache.get(CATEGORY),
    });
    expect(service.groupChannels.reconcile).not.toHaveBeenCalled();
    expect(service.groupChannels.cleanup).not.toHaveBeenCalled();
    expect(guild.channels.fetch).not.toHaveBeenCalled();
    expect(EventMock.updateOne).not.toHaveBeenCalled();
    // The one write is the main channel's own claim.
    expect(EventMock.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it("an ended plain event's cleanup and a plain cancel make no group call", async () => {
    const { service, guild } = setup();
    const mainChannel = {
      delete: jest.fn(async () => undefined),
      type: ChannelType.GuildVoice,
      members: { size: 0 },
    };
    guild.channels.cache.set("main-1", mainChannel);
    await service.processEvent(
      row({ state: "ended", channelId: "main-1" }),
      guild,
      new Date("2026-07-04T23:00:00Z"),
      WINDOWS,
    );
    expect(mainChannel.delete).toHaveBeenCalledTimes(1);

    const cancelled = row({ state: "active", channelId: null });
    await service.cancelOne(cancelled);
    expect(service.groupChannels.cleanup).not.toHaveBeenCalled();
    expect(guild.channels.fetch).not.toHaveBeenCalled();
  });

  it("a legacy row without any group field behaves the same", async () => {
    const { service, guild } = setup();
    const legacy = row();
    delete legacy.groupsEnabled;
    delete legacy.groups;
    await service.processEvent(legacy, guild, NOW, WINDOWS);
    expect(guild.channels.create).toHaveBeenCalledTimes(1);
    expect(service.groupChannels.reconcile).not.toHaveBeenCalled();
  });
});

describe("group channels in the scan", () => {
  it("creates the main channel and then reconciles the groups once the lead time is reached", async () => {
    const { service, guild } = setup();
    await service.processEvent(groupRow(), guild, NOW, WINDOWS);
    expect(guild.channels.create).toHaveBeenCalledTimes(1);
    expect(service.groupChannels.reconcile).toHaveBeenCalledTimes(1);
  });

  it("runs the slow group pass only after the scan has saved its own changes (a cancel during the pass cannot be overwritten)", async () => {
    const { service, guild } = setup();
    const order: string[] = [];
    const event = groupRow({
      save: jest.fn(async () => {
        order.push("save");
      }),
    });
    service.groupChannels.reconcile = jest.fn(async () => {
      order.push("reconcile");
      return emptyReport();
    });
    await service.processEvent(event, guild, NOW, WINDOWS);
    expect(guild.channels.create).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["save", "reconcile"]);
  });

  it("uses the event's own lead time for the group channels too (not the global one)", async () => {
    const { service, guild } = setup();
    // 40 minutes before the start; the global lead is 15, the event's is 60.
    const early = new Date("2026-07-04T19:20:00Z");
    await service.processEvent(
      groupRow({ channelLeadMinutes: 60 }),
      guild,
      early,
      WINDOWS,
    );
    expect(service.groupChannels.reconcile).toHaveBeenCalledTimes(1);

    const { service: other, guild: otherGuild } = setup();
    await other.processEvent(groupRow(), otherGuild, early, WINDOWS);
    expect(other.groupChannels.reconcile).not.toHaveBeenCalled();
    expect(otherGuild.channels.create).not.toHaveBeenCalled();
  });

  it("reconciles an active event after a restart when a group has no channel or its recorded one is not cached", async () => {
    const { service, guild } = setup();
    await service.processEvent(
      groupRow({ state: "active", channelId: "main-1" }),
      guild,
      NOW,
      WINDOWS,
    );
    expect(service.groupChannels.reconcile).toHaveBeenCalledTimes(1);

    const { service: s2, guild: g2 } = setup();
    await s2.processEvent(
      groupRow({
        state: "active",
        channelId: "main-1",
        groups: [
          { key: "g_a", name: "A", size: null, marker: "", channelId: "gone" },
        ],
      }),
      g2,
      NOW,
      WINDOWS,
    );
    expect(s2.groupChannels.reconcile).toHaveBeenCalledTimes(1);
  });

  it("makes no call while every group's channel is recorded and present", async () => {
    const { service, guild } = setup();
    guild.channels.cache.set("c1", {});
    guild.channels.cache.set("c2", {});
    await service.processEvent(
      groupRow({
        state: "active",
        channelId: "main-1",
        groups: [
          { key: "g_a", name: "A", size: null, marker: "", channelId: "c1" },
          { key: "g_b", name: "B", size: null, marker: "", channelId: "c2" },
        ],
      }),
      guild,
      NOW,
      WINDOWS,
    );
    expect(service.groupChannels.reconcile).not.toHaveBeenCalled();
    expect(service.groupChannels.cleanup).not.toHaveBeenCalled();
  });

  describe("the leads channel's access (#1199)", () => {
    const leadsGroups = [
      { key: "g_a", name: "A", size: null, marker: "", channelId: "c1" },
      {
        key: "g_l",
        name: "Leads",
        kind: "leads",
        size: null,
        marker: "",
        channelId: "c2",
      },
    ];
    const open = (over: Record<string, unknown> = {}) =>
      groupRow({
        state: "active",
        channelId: "main-1",
        groups: leadsGroups,
        ...over,
      });

    it("runs the access pass for an open event whose leads channel needs one", async () => {
      const { service, guild } = setup();
      guild.channels.cache.set("c1", {});
      guild.channels.cache.set("c2", {});
      const sync = jest.fn(async () => undefined);
      (service as unknown as { syncLeadsAccess: unknown }).syncLeadsAccess =
        sync;
      await service.processEvent(open(), guild, NOW, WINDOWS);
      // Never verified since the start: one pass, with no revoked ids.
      expect(sync).toHaveBeenCalledTimes(1);
      expect(sync).toHaveBeenCalledWith("guild-1", "evt1");
      expect(service.groupChannels.reconcile).not.toHaveBeenCalled();
    });

    it("does nothing for a plain event, a group event without a leads channel, an adopted one, or one past its end", async () => {
      const { service, guild } = setup();
      guild.channels.cache.set("c1", {});
      guild.channels.cache.set("c2", {});
      const sync = jest.fn(async () => undefined);
      (service as unknown as { syncLeadsAccess: unknown }).syncLeadsAccess =
        sync;
      const needs = jest.spyOn(
        (
          service as unknown as {
            groupChannels: { leadsNeedsAttention: () => boolean };
          }
        ).groupChannels,
        "leadsNeedsAttention",
      );
      await service.processEvent(
        row({ state: "active", channelId: "main-1" }),
        guild,
        NOW,
        WINDOWS,
      );
      expect(needs).not.toHaveBeenCalled();
      await service.processEvent(
        open({ groups: [leadsGroups[0]] }),
        guild,
        NOW,
        WINDOWS,
      );
      await service.processEvent(
        open({ nativeAdopted: true }),
        guild,
        NOW,
        WINDOWS,
      );
      await service.processEvent(
        open({
          durationMinutes: 5,
          startTime: new Date(NOW.getTime() - 60 * MIN),
        }),
        guild,
        NOW,
        WINDOWS,
      );
      await service.processEvent(open({ state: "ended" }), guild, NOW, WINDOWS);
      expect(sync).not.toHaveBeenCalled();
    });
  });

  it("reconciles when every channel is present but the cache shows the groups out of order (#1214), and not when the order is right", async () => {
    const voice = (
      id: string,
      rawPosition: number,
    ): Record<string, unknown> => ({
      id,
      type: ChannelType.GuildVoice,
      parentId: CATEGORY,
      rawPosition,
    });
    const groups = [
      { key: "g_a", name: "A", size: null, marker: "", channelId: "c1" },
      { key: "g_b", name: "B", size: null, marker: "", channelId: "c2" },
    ];
    const wrong = setup();
    for (const c of [voice("main-1", 0), voice("c1", 9), voice("c2", 1)]) {
      wrong.guild.channels.cache.set(c.id as string, c);
    }
    await wrong.service.processEvent(
      groupRow({ state: "active", channelId: "main-1", groups }),
      wrong.guild,
      NOW,
      WINDOWS,
    );
    expect(wrong.service.groupChannels.reconcile).toHaveBeenCalledTimes(1);

    const right = setup();
    for (const c of [voice("main-1", 0), voice("c1", 1), voice("c2", 2)]) {
      right.guild.channels.cache.set(c.id as string, c);
    }
    await right.service.processEvent(
      groupRow({ state: "active", channelId: "main-1", groups }),
      right.guild,
      NOW,
      WINDOWS,
    );
    expect(right.service.groupChannels.reconcile).not.toHaveBeenCalled();
  });

  it("does not reconcile for an adopted event or one past its end", async () => {
    const { service, guild } = setup();
    await service.processEvent(
      groupRow({ state: "active", channelId: "main-1", nativeAdopted: true }),
      guild,
      NOW,
      WINDOWS,
    );
    expect(service.groupChannels.reconcile).not.toHaveBeenCalled();
    const { service: s2, guild: g2 } = setup();
    await s2.processEvent(
      groupRow({ state: "active", channelId: "main-1" }),
      g2,
      new Date("2026-07-04T23:00:00Z"),
      WINDOWS,
    );
    expect(s2.groupChannels.reconcile).not.toHaveBeenCalled();
  });

  it("cleans up the group channels of an ended event even when its main channel is already gone", async () => {
    const { service, guild } = setup();
    await service.processEvent(
      groupRow({
        state: "ended",
        channelId: null,
        groups: [
          { key: "g_a", name: "A", size: null, marker: "", channelId: "c1" },
        ],
      }),
      guild,
      new Date("2026-07-04T23:00:00Z"),
      WINDOWS,
    );
    expect(service.groupChannels.cleanup).toHaveBeenCalledTimes(1);
  });

  it("cleans up a cancelled event's recorded channels on the scan, after the saved state", async () => {
    const { service, guild } = setup();
    const event = groupRow({
      state: "cancelled",
      channelId: null,
      groups: [
        { key: "g_a", name: "A", size: null, marker: "", channelId: "c1" },
      ],
    });
    await service.processEvent(event, guild, NOW, WINDOWS);
    expect(service.groupChannels.cleanup).toHaveBeenCalledTimes(1);
  });

  it("does not clean up while the event is still open", async () => {
    const { service, guild } = setup();
    guild.channels.cache.set("c1", {});
    await service.processEvent(
      groupRow({
        state: "active",
        channelId: "main-1",
        groups: [
          { key: "g_a", name: "A", size: null, marker: "", channelId: "c1" },
        ],
      }),
      guild,
      NOW,
      WINDOWS,
    );
    expect(service.groupChannels.cleanup).not.toHaveBeenCalled();
  });

  it("the scan also loads finished events that still have group channels recorded", async () => {
    const { service } = setup();
    configMock.getString.mockImplementation(async (k: string, d?: unknown) =>
      k === "GUILD_ID" ? "guild-1" : d,
    );
    await service.runOnce();
    configMock.getString.mockImplementation(
      async (_k: string, d?: unknown) => d,
    );
    const query = EventMock.find.mock.calls[0][0] as { $or: unknown[] };
    expect(query.$or).toContainEqual({
      state: { $in: ["ended", "cancelled"] },
      "groups.channelId": { $type: "string" },
    });
  });
});

describe("cancel", () => {
  it("removes the group channels only after the cancel is saved", async () => {
    const { service } = setup();
    const order: string[] = [];
    const event = groupRow({
      state: "active",
      channelId: null,
      groups: [
        { key: "g_a", name: "A", size: null, marker: "", channelId: "c1" },
      ],
      save: jest.fn(async () => {
        order.push("save");
      }),
    });
    service.groupChannels.cleanup.mockImplementation(async () => {
      order.push("cleanup");
      return emptyReport();
    });
    await service.cancelOne(event);
    expect(order).toEqual(["save", "cleanup"]);
    expect(event.state).toBe("cancelled");
  });
});

describe("the main channel of a group event", () => {
  const guildWithHostPower = () => {
    const guild = makeGuild();
    return guild;
  };

  it("gets the host's access on top of the category's, and a plain event does not", async () => {
    const { service } = setup();
    const guild = guildWithHostPower();
    await service.createEventChannel(groupRow({ title: "Clan match" }), guild);
    const options = guild.channels.create.mock.calls[0][0] as {
      permissionOverwrites?: Array<{ id: string }>;
    };
    expect(options.permissionOverwrites?.map((o) => o.id)).toEqual([HOST]);

    const plainGuild = guildWithHostPower();
    await service.createEventChannel(row(), plainGuild);
    expect(plainGuild.channels.create.mock.calls[0][0]).not.toHaveProperty(
      "permissionOverwrites",
    );
  });

  it("is still created, without the host's access, when Discord refuses the overwrites (50013)", async () => {
    const { service } = setup();
    const guild = guildWithHostPower();
    guild.channels.create
      .mockImplementationOnce(async () => {
        throw new DiscordAPIError(
          { code: 50013, message: "x" },
          50013,
          403,
          "POST",
          "/",
          {},
        );
      })
      .mockImplementation(async () => ({ id: "main-1" }));
    const channel = await service.createEventChannel(groupRow(), guild);
    expect(channel).toEqual({ id: "main-1" });
    expect(guild.channels.create).toHaveBeenCalledTimes(2);
    expect(guild.channels.create.mock.calls[1][0]).not.toHaveProperty(
      "permissionOverwrites",
    );
  });

  it("explains a refused host access on the main channel on the host panel, and keeps it", async () => {
    const { service } = setup();
    const guild = guildWithHostPower();
    guild.channels.create
      .mockImplementationOnce(async () => {
        throw new DiscordAPIError(
          { code: 50013, message: "x" },
          50013,
          403,
          "POST",
          "/",
          {},
        );
      })
      .mockImplementation(async () => ({ id: "main-1" }));
    const event = groupRow();
    await service.createEventChannel(event, guild);
    const svc = service as unknown as {
      getGroupChannelReport: (id: string) => { warnings: string[] } | null;
    };
    const shown = svc.getGroupChannelReport("evt1");
    expect(shown?.warnings.join(" ")).toContain("main voice channel");
    // A plain event records nothing.
    const { service: plain } = setup();
    await plain.createEventChannel(row(), guildWithHostPower());
    expect(
      (
        plain as unknown as {
          getGroupChannelReport: (id: string) => unknown;
        }
      ).getGroupChannelReport("evt1"),
    ).toBeNull();
  });

  it("any other create failure still returns null as before", async () => {
    const { service } = setup();
    const guild = guildWithHostPower();
    guild.channels.create.mockImplementation(async () => {
      throw new Error("boom");
    });
    expect(await service.createEventChannel(groupRow(), guild)).toBeNull();
    expect(guild.channels.create).toHaveBeenCalledTimes(1);
  });
});

describe("start now, the public passes and logging", () => {
  type Pub = Priv & {
    startEventNow: (id: string) => Promise<unknown>;
    reconcileGroupChannels: (id: string, guildId?: string) => Promise<unknown>;
    cleanupGroupChannels: (id: string, guildId?: string) => Promise<unknown>;
    logGroupReport: (e: unknown, r: unknown) => Promise<void>;
  };

  it("start now returns without waiting for the group channels", async () => {
    const { service } = setup();
    const event = groupRow();
    EventMock.findById = jest.fn(() => Promise.resolve(event));
    service.groupChannels.reconcile = jest.fn(
      () => new Promise(() => undefined),
    );
    const result = await (service as Pub).startEventNow("evt1");
    expect(result).toBe(event);
    expect(event.state).toBe("active");
    expect(service.groupChannels.reconcile).toHaveBeenCalledTimes(1);
  });

  it("start now on a plain event makes no group call", async () => {
    const { service } = setup();
    EventMock.findById = jest.fn(() => Promise.resolve(row()));
    await (service as Pub).startEventNow("evt1");
    expect(service.groupChannels.reconcile).not.toHaveBeenCalled();
  });

  it("reconcileGroupChannels and cleanupGroupChannels run the passes for the event's own server only", async () => {
    const { service } = setup();
    EventMock.findById = jest.fn(() => Promise.resolve(groupRow()));
    expect(
      await (service as Pub).reconcileGroupChannels("evt1", "guild-1"),
    ).toEqual(emptyReport());
    expect(
      await (service as Pub).cleanupGroupChannels("evt1", "guild-1"),
    ).toEqual(emptyReport());
    expect(
      await (service as Pub).reconcileGroupChannels("evt1", "other"),
    ).toBeNull();
    expect(
      await (service as Pub).cleanupGroupChannels("evt1", "other"),
    ).toBeNull();
    EventMock.findById = jest.fn(() => Promise.resolve(null));
    expect(await (service as Pub).reconcileGroupChannels("nope")).toBeNull();
    expect(service.groupChannels.reconcile).toHaveBeenCalledTimes(1);
    expect(service.groupChannels.cleanup).toHaveBeenCalledTimes(1);
  });

  it("logs a standing failure once, and again when it changes or after it cleared", async () => {
    const { service } = setup();
    const { default: logger } = await import("../../src/utils/logger.js");
    const warn = logger.warn as unknown as jest.Mock;
    warn.mockClear();
    const failing = (reason: string): unknown => ({
      ...emptyReport(),
      failures: [{ key: "g_a", name: "Alpha", reason }],
    });
    const event = { _id: "evt-log" };
    const pub = service as Pub;
    await pub.logGroupReport(event, failing("full"));
    await pub.logGroupReport(event, failing("full"));
    await pub.logGroupReport(event, failing("full"));
    expect(warn).toHaveBeenCalledTimes(1);
    await pub.logGroupReport(event, failing("other"));
    expect(warn).toHaveBeenCalledTimes(2);
    await pub.logGroupReport(event, emptyReport());
    await pub.logGroupReport(event, failing("other"));
    expect(warn).toHaveBeenCalledTimes(3);
  });
});
