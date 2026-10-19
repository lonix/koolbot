import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { ChannelType } from "discord.js";

// How EventService drives the leader customiser's two passes (#1196): the
// pending channel renames and the "Customise team" messages. The passes
// themselves are covered in event-group-channels-customise.test.ts; here the
// point is the wiring: which scans call them, and that nothing else does.

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

interface Priv {
  processEvent: (...a: unknown[]) => Promise<void>;
  nativeSync: Record<string, jest.Mock>;
  updateAnnouncement: jest.Mock;
  groupChannels: {
    reconcile: jest.Mock;
    cleanup: jest.Mock;
    syncNames: jest.Mock;
    syncUserLimits: jest.Mock;
    syncControls: jest.Mock;
  };
}
type Service = Priv & {
  syncGroupNames: (e: string, g: string, k?: string) => Promise<unknown>;
  syncGroupUserLimits: (
    e: string,
    g: string,
    k?: string,
  ) => Promise<unknown>;
  syncGroupControls: (e: string) => Promise<void>;
};

function setup(guildFound = true): {
  service: Service;
  guild: ReturnType<typeof makeGuild>;
  fetch: jest.Mock;
} {
  EventService.reset();
  const guild = makeGuild();
  const fetch = jest.fn(async () => {
    if (!guildFound) throw new Error("unknown guild");
    return guild;
  });
  const service = EventService.getInstance({
    guilds: { fetch },
  } as never) as unknown as Service;
  service.nativeSync = {
    syncEvent: jest.fn(async () => undefined),
    loadCache: jest.fn(async () => null),
    pullAdopted: jest.fn(),
    adoptedHasChannel: jest.fn(),
  };
  service.updateAnnouncement = jest.fn(async () => true);
  const empty = {
    created: 0,
    removed: 0,
    occupied: 0,
    failures: [],
    warnings: [],
  };
  service.groupChannels.reconcile = jest.fn(async () => empty);
  service.groupChannels.cleanup = jest.fn(async () => empty);
  service.groupChannels.syncNames = jest.fn(async () => []);
  service.groupChannels.syncUserLimits = jest.fn(async () => []);
  service.groupChannels.syncControls = jest.fn(async () => undefined);
  return { service, guild, fetch };
}

function makeGuild() {
  const cache = new Map<string, unknown>([
    [
      "cat-1",
      {
        id: "cat-1",
        type: ChannelType.GuildCategory,
        permissionOverwrites: { cache: new Map() },
      },
    ],
    ["c1", {}],
    ["c2", {}],
  ]);
  return {
    id: "guild-1",
    members: { me: null },
    channels: { cache, create: jest.fn(), fetch: jest.fn(async () => null) },
  };
}

function open(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: "evt1",
    guildId: "guild-1",
    title: "Game Night",
    startTime: START,
    durationMinutes: 120,
    categoryId: "cat-1",
    channelId: "main-1",
    state: "active",
    reminderSent: true,
    recurrence: "none",
    seriesId: null,
    createdBy: HOST,
    groupsEnabled: true,
    captainsEnabled: true,
    captainCustomisationEnabled: false,
    groups: [
      {
        key: "g_00000001",
        name: "A",
        kind: "team",
        size: null,
        marker: "",
        channelId: "c1",
      },
      {
        key: "g_00000002",
        name: "B",
        kind: "team",
        size: null,
        marker: "",
        channelId: "c2",
      },
    ],
    save: jest.fn(async () => undefined),
    ...over,
  };
}

const WINDOWS = { reminderMs: 0, leadMs: 15 * MIN, graceMs: 15 * MIN };

beforeEach(() => {
  EventMock.find = jest.fn(async () => []);
  EventMock.findOneAndUpdate = jest.fn(async () => ({ _id: "evt1" }));
  EventMock.findById = jest.fn(async () => null);
  EventMock.updateOne = jest.fn(async () => ({ matchedCount: 1 }));
  EventMock.deleteOne = jest.fn(async () => ({}));
});

describe("the scan finishes pending renames and keeps the button right (#1196)", () => {
  it("runs the rename pass for an open event with a group whose name is pending", async () => {
    const { service, guild } = setup();
    const groups = [
      {
        key: "g_00000001",
        name: "A",
        kind: "team",
        channelId: "c1",
        nameSyncPending: true,
      },
    ];
    await service.processEvent(open({ groups }), guild, NOW, WINDOWS);
    expect(service.groupChannels.syncNames).toHaveBeenCalledWith("evt1", guild);
    expect(service.groupChannels.syncControls).not.toHaveBeenCalled();
  });

  it("runs the control message pass when customisation is on and a team channel has no message", async () => {
    const { service, guild } = setup();
    await service.processEvent(
      open({ captainCustomisationEnabled: true }),
      guild,
      NOW,
      WINDOWS,
    );
    expect(service.groupChannels.syncControls).toHaveBeenCalledWith("evt1");
    expect(service.groupChannels.syncNames).not.toHaveBeenCalled();
  });

  it("runs the control message pass to take a message away when customisation is off", async () => {
    const { service, guild } = setup();
    const groups = [
      {
        key: "g_00000001",
        name: "A",
        kind: "team",
        channelId: "c1",
        controlMessageId: "m1",
        controlChannelId: "c1",
      },
    ];
    await service.processEvent(open({ groups }), guild, NOW, WINDOWS);
    expect(service.groupChannels.syncControls).toHaveBeenCalledTimes(1);
  });

  it("does nothing when nothing is pending and nothing is wanted or recorded", async () => {
    const { service, guild } = setup();
    await service.processEvent(open(), guild, NOW, WINDOWS);
    expect(service.groupChannels.syncNames).not.toHaveBeenCalled();
    expect(service.groupChannels.syncControls).not.toHaveBeenCalled();
  });

  it.each([
    ["a plain event", { groupsEnabled: false }],
    ["an adopted event", { nativeAdopted: true }],
    ["an ended event", { state: "ended" }],
    ["a cancelled event", { state: "cancelled" }],
  ])("never touches %s", async (_n, over) => {
    const { service, guild } = setup();
    const groups = [
      {
        key: "g_00000001",
        name: "A",
        kind: "team",
        channelId: "c1",
        nameSyncPending: true,
        controlMessageId: "m1",
        controlChannelId: "c1",
      },
    ];
    await service.processEvent(
      open({ groups, captainCustomisationEnabled: true, ...over }),
      guild,
      NOW,
      WINDOWS,
    );
    expect(service.groupChannels.syncNames).not.toHaveBeenCalled();
    expect(service.groupChannels.syncControls).not.toHaveBeenCalled();
  });
});

describe("the public passes for the host panel and #1197 (#1196)", () => {
  it("syncGroupNames fetches the server and finishes the renames, for one group when asked", async () => {
    const { service, guild, fetch } = setup();
    service.groupChannels.syncNames.mockResolvedValue([
      { groupKey: "g_00000001", status: "applied" },
    ]);
    const out = await service.syncGroupNames("evt1", "guild-1", "g_00000001");
    expect(fetch).toHaveBeenCalledWith("guild-1");
    expect(service.groupChannels.syncNames).toHaveBeenCalledWith(
      "evt1",
      guild,
      "g_00000001",
    );
    expect(out).toEqual([{ groupKey: "g_00000001", status: "applied" }]);
  });

  it("syncGroupControls delegates", async () => {
    const ok = setup();
    await ok.service.syncGroupControls("evt1");
    expect(ok.service.groupChannels.syncControls).toHaveBeenCalledWith("evt1");
  });

  it("syncGroupNames answers null, and does nothing, when the server is gone", async () => {
    const gone = setup(false);
    expect(await gone.service.syncGroupNames("evt1", "guild-1")).toBeNull();
    expect(gone.service.groupChannels.syncNames).not.toHaveBeenCalled();
  });
});

describe("the scan finishes pending channel user limits (#1241)", () => {
  const sized = (over: Record<string, unknown> = {}) => [
    {
      key: "g_00000001",
      name: "A",
      kind: "team",
      size: 4,
      channelId: "c1",
      sizeSyncPending: true,
      ...over,
    },
  ];

  it("runs the user limit pass for an open event with a group whose size is pending", async () => {
    const { service, guild } = setup();
    await service.processEvent(open({ groups: sized() }), guild, NOW, WINDOWS);
    expect(service.groupChannels.syncUserLimits).toHaveBeenCalledWith(
      "evt1",
      guild,
    );
    expect(service.groupChannels.syncNames).not.toHaveBeenCalled();
  });

  it("does nothing when no size is pending or the group has no channel yet", async () => {
    const { service, guild } = setup();
    await service.processEvent(open(), guild, NOW, WINDOWS);
    await service.processEvent(
      open({ groups: sized({ channelId: null }) }),
      guild,
      NOW,
      WINDOWS,
    );
    expect(service.groupChannels.syncUserLimits).not.toHaveBeenCalled();
  });

  it.each([
    ["a plain event", { groupsEnabled: false }],
    ["an adopted event", { nativeAdopted: true }],
    ["an ended event", { state: "ended" }],
    ["a cancelled event", { state: "cancelled" }],
  ])("never touches %s", async (_n, over) => {
    const { service, guild } = setup();
    await service.processEvent(
      open({ groups: sized(), ...over }),
      guild,
      NOW,
      WINDOWS,
    );
    expect(service.groupChannels.syncUserLimits).not.toHaveBeenCalled();
  });

  it("syncGroupUserLimits fetches the server and finishes the limits, for one group when asked", async () => {
    const { service, guild, fetch } = setup();
    service.groupChannels.syncUserLimits.mockResolvedValue([
      { groupKey: "g_00000001", status: "applied" },
    ]);
    const out = await service.syncGroupUserLimits(
      "evt1",
      "guild-1",
      "g_00000001",
    );
    expect(fetch).toHaveBeenCalledWith("guild-1");
    expect(service.groupChannels.syncUserLimits).toHaveBeenCalledWith(
      "evt1",
      guild,
      "g_00000001",
    );
    expect(out).toEqual([{ groupKey: "g_00000001", status: "applied" }]);
  });

  it("syncGroupUserLimits answers null, and does nothing, when the server is gone", async () => {
    const gone = setup(false);
    expect(
      await gone.service.syncGroupUserLimits("evt1", "guild-1"),
    ).toBeNull();
    expect(gone.service.groupChannels.syncUserLimits).not.toHaveBeenCalled();
  });
});
