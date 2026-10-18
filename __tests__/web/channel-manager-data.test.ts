import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { ChannelType, PermissionFlagsBits } from "discord.js";

const lean = <T>(rows: T[]) => ({
  lean: async () => rows,
  select: () => ({ lean: async () => rows }),
});
let strictConfig: Record<string, string> = {};
let strictFails = false;
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      getBoolean: jest.fn(async () => false),
      getNumber: jest.fn(async () => 0),
      getString: jest.fn(async (k: string, d = "") => strictConfig[k] ?? d),
      getStringStrict: jest.fn(async (k: string, d = "") => {
        if (strictFails) throw new Error("config read failed");
        return strictConfig[k] ?? d;
      }),
      registerReloadCallback: jest.fn(),
    }),
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
jest.unstable_mockModule("../../src/services/voice-channel-tracker.js", () => ({
  VoiceChannelTracker: { getInstance: (): unknown => ({}) },
}));
const mockConfig = jest.fn<(...a: any[]) => Promise<Record<string, unknown>>>();
jest.unstable_mockModule("../../src/services/server-scan-service.js", () => ({
  readEffectiveConfig: mockConfig,
}));
const managed = jest.fn<(...a: any[]) => any>();
const owned = jest.fn<(...a: any[]) => any>();
const tickets = jest.fn<(...a: any[]) => any>();
const events = jest.fn<(...a: any[]) => any>();
const lfg = jest.fn<(...a: any[]) => any>();
const reactionRoles = jest.fn<(...a: any[]) => any>();
const polls = jest.fn<(...a: any[]) => any>();
const announcements = jest.fn<(...a: any[]) => any>();
const auditFind = jest.fn<(...a: any[]) => any>();
jest.unstable_mockModule("../../src/models/managed-voice-channel.js", () => ({
  ManagedVoiceChannel: { find: managed },
  ManagedVoiceMigration: {},
}));
jest.unstable_mockModule("../../src/models/voice-channel-ownership.js", () => ({
  VoiceChannelOwnership: { find: owned },
}));
jest.unstable_mockModule("../../src/models/ticket.js", () => ({
  Ticket: { find: tickets },
}));
jest.unstable_mockModule("../../src/models/event.js", () => ({
  Event: { find: events },
}));
jest.unstable_mockModule("../../src/models/lfg-post.js", () => ({
  LfgPost: { find: lfg },
}));
jest.unstable_mockModule("../../src/models/reaction-role-config.js", () => ({
  ReactionRoleConfig: { find: reactionRoles },
}));
jest.unstable_mockModule("../../src/models/web-audit-log.js", () => ({
  WebAuditLog: { find: auditFind },
}));
jest.unstable_mockModule("../../src/models/poll-schedule.js", () => ({
  PollSchedule: { find: polls },
}));
jest.unstable_mockModule("../../src/models/scheduled-announcement.js", () => ({
  ScheduledAnnouncement: { find: announcements },
}));

const {
  botCanManageChannels,
  fetchChannelViews,
  loadProtection,
  loadRecentChanges,
  maxBitrateOf,
  viewOf,
} = await import("../../src/web/channel-manager-data.js");
const { VoiceChannelManager } =
  await import("../../src/services/voice-channel-manager.js");

const raw = (over: Record<string, unknown>): any => ({
  isThread: () => false,
  ...over,
});

describe("viewOf / fetchChannelViews", () => {
  it("maps text, voice, category and other channels, and drops threads", async () => {
    const guild: any = {
      channels: {
        fetch: async () =>
          new Map<string, unknown>([
            [
              "1",
              raw({
                id: "1",
                name: "t",
                type: ChannelType.GuildText,
                parentId: "9",
                rawPosition: 2,
                topic: "hi",
              }),
            ],
            [
              "2",
              raw({
                id: "2",
                name: "v",
                type: ChannelType.GuildVoice,
                parentId: null,
                rawPosition: 1,
                userLimit: 3,
                bitrate: 64000,
              }),
            ],
            [
              "3",
              raw({
                id: "3",
                name: "c",
                type: ChannelType.GuildCategory,
                rawPosition: 0,
              }),
            ],
            [
              "4",
              raw({ id: "4", name: "s", type: ChannelType.GuildStageVoice }),
            ],
            [
              "5",
              raw({
                id: "5",
                name: "thread",
                type: ChannelType.PublicThread,
                isThread: () => true,
              }),
            ],
            ["6", null],
          ]),
      },
    };
    const views = await fetchChannelViews(guild);
    expect(views.map((v) => [v.id, v.kind])).toEqual([
      ["1", "text"],
      ["2", "voice"],
      ["3", "category"],
      ["4", "other"],
    ]);
    expect(views[0]).toMatchObject({ parentId: "9", position: 2, topic: "hi" });
    expect(views[1]).toMatchObject({ userLimit: 3, bitrate: 64000 });
    expect(views[3].typeLabel).toBe("GuildStageVoice");
    expect(
      viewOf(raw({ id: "7", name: "x", type: ChannelType.GuildText })).topic,
    ).toBeNull();
  });
});

describe("maxBitrateOf", () => {
  it("uses the guild's maximum, else the 96 kbps default", () => {
    expect(maxBitrateOf({ maximumBitrate: 256000 } as any)).toBe(256000);
    expect(maxBitrateOf({} as any)).toBe(96000);
    expect(maxBitrateOf({ maximumBitrate: 10 } as any)).toBe(96000);
  });
});

describe("botCanManageChannels", () => {
  const guildWith = (has: boolean, fetchMe?: () => Promise<unknown>): any => ({
    members: {
      me: fetchMe
        ? null
        : {
            permissions: {
              has: (f: bigint) =>
                has && f === PermissionFlagsBits.ManageChannels,
            },
          },
      fetchMe: fetchMe ?? (async () => ({})),
    },
  });
  it("reads the bot's server-wide permission", async () => {
    expect(await botCanManageChannels(guildWith(true))).toBe(true);
    expect(await botCanManageChannels(guildWith(false))).toBe(false);
  });
  it("fetches the member when it isn't cached, and fails closed on errors", async () => {
    const ok = guildWith(true, async () => ({
      permissions: { has: () => true },
    }));
    expect(await botCanManageChannels(ok)).toBe(true);
    const bad = guildWith(true, async () => {
      throw new Error("x");
    });
    expect(await botCanManageChannels(bad)).toBe(false);
  });
});

describe("loadProtection", () => {
  const fakeClient: any = {
    user: { id: "bot" },
    channels: { cache: new Map() },
  };
  const guild: any = {
    client: fakeClient,
    id: "g1",
    rulesChannelId: "100000000000000090",
    publicUpdatesChannelId: null,
    systemChannelId: "100000000000000091",
  };
  beforeEach(() => {
    strictConfig = {};
    strictFails = false;
    VoiceChannelManager.reset();
    mockConfig.mockResolvedValue({ "quotes.channel_id": "100000000000000001" });
    managed.mockReturnValue(
      lean([{ channelId: "100000000000000002", kind: "lobby" }]),
    );
    owned.mockReturnValue(lean([{ channelId: "100000000000000003" }]));
    tickets.mockReturnValue(
      lean([{ _id: "t1", channelId: "100000000000000004" }]),
    );
    events.mockReturnValue(
      lean([
        {
          _id: "e1",
          channelId: "100000000000000005",
          categoryId: "",
          announcementChannelId: null,
        },
      ]),
    );
    lfg.mockReturnValue(
      lean([{ voiceChannelId: null, channelId: "100000000000000006" }]),
    );
    reactionRoles.mockReturnValue(
      lean([
        {
          _id: "rr1",
          channelId: "100000000000000007",
          categoryId: "100000000000000008",
        },
      ]),
    );
    polls.mockReturnValue(
      lean([{ _id: "ps1", channelId: "100000000000000009" }]),
    );
    announcements.mockReturnValue(
      lean([{ _id: "an1", channelId: "100000000000000010" }]),
    );
  });

  it("combines config, voice rows, tickets, events, LFG and Discord's channels, scoped to the guild", async () => {
    const map = await loadProtection(guild, []);
    for (const id of [
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "90",
      "91",
    ]) {
      expect(map.has(`1000000000000000${id.padStart(2, "0")}`)).toBe(true);
    }
    expect(managed).toHaveBeenCalledWith({ guildId: "g1" });
    expect(reactionRoles).toHaveBeenCalledWith({
      guildId: "g1",
      $or: [
        { archivedAt: null },
        { messageChannelId: { $exists: true, $ne: "" } },
      ],
    });
    expect(polls).toHaveBeenCalledWith({ guildId: "g1" });
    expect(announcements).toHaveBeenCalledWith({ guildId: "g1" });
    const map2 = await loadProtection(guild, []);
    expect(map2.get("100000000000000007")![0]).toContain("Reaction Roles");
    expect(map2.get("100000000000000009")![0]).toContain("Polls");
    expect(map2.get("100000000000000010")![0]).toContain("Announcements");
    expect(events.mock.calls[0][0]).toMatchObject({
      guildId: "g1",
      state: { $in: ["scheduled", "active"] },
    });
  });

  it.each([
    ["reaction roles", reactionRoles],
    ["poll schedules", polls],
    ["announcements", announcements],
  ])("fails closed when the %s lookup fails", async (_n, mock) => {
    mock.mockImplementation(() => {
      throw new Error("db down");
    });
    await expect(loadProtection(guild, [])).rejects.toThrow("db down");
  });

  it("protects an archived stamp's picker channel only while an active mapping still uses that message", async () => {
    reactionRoles.mockReturnValue(
      lean([
        {
          _id: "rr-shared-archived",
          archivedAt: new Date(),
          messageId: "shared",
          channelId: "100000000000000051",
          categoryId: "100000000000000052",
          messageChannelId: "100000000000000050",
        },
        // The picker is still alive: an active mapping uses the message.
        { _id: "rr-survivor", messageId: "shared" },
        // Standalone archive deleted its picker: nothing left to protect.
        {
          _id: "rr-standalone",
          archivedAt: new Date(),
          messageId: "gone",
          messageChannelId: "100000000000000053",
        },
      ]),
    );
    const map = await loadProtection(guild, []);
    expect(map.get("100000000000000050")![0]).toContain("picker channel");
    expect(map.has("100000000000000053")).toBe(false);
    // An archived mapping never protects its private channel or category.
    expect(map.has("100000000000000051")).toBe(false);
    expect(map.has("100000000000000052")).toBe(false);
  });

  const voiceChannels = [
    {
      id: "100000000000000040",
      name: "Lobby",
      kind: "voice" as const,
      typeLabel: "voice",
      parentId: "100000000000000099",
      position: 0,
      topic: null,
      userLimit: null,
      bitrate: null,
    },
    {
      id: "100000000000000041",
      name: "Old Lobby",
      kind: "voice" as const,
      typeLabel: "voice",
      parentId: "100000000000000099",
      position: 1,
      topic: null,
      userLimit: null,
      bitrate: null,
    },
    {
      id: "100000000000000042",
      name: "Squad",
      kind: "voice" as const,
      typeLabel: "voice",
      parentId: "100000000000000099",
      position: 2,
      topic: null,
      userLimit: null,
      bitrate: null,
    },
  ];

  it("protects a lobby whose configured name is quoted (the service strips the quotes)", async () => {
    strictConfig = { "voicechannels.lobby.name": '"Lobby"' };
    mockConfig.mockResolvedValue({
      "voicechannels.category_id": "100000000000000099",
    });
    const map = await loadProtection(guild, voiceChannels);
    expect(map.has("100000000000000040")).toBe(true);
    expect(map.has("100000000000000042")).toBe(false);
  });

  it("protects a lobby named by a legacy key when the primary setting is empty", async () => {
    strictConfig = {
      "voicechannels.lobby.name": "",
      "voice_channel.lobby_channel_name": "Old Lobby",
    };
    mockConfig.mockResolvedValue({
      "voicechannels.category_id": "100000000000000099",
    });
    const map = await loadProtection(guild, voiceChannels);
    expect(map.has("100000000000000041")).toBe(true);
    expect(map.has("100000000000000042")).toBe(false);
  });

  it("protects an existing lobby that has no configured id and no managed-channel row", async () => {
    managed.mockReturnValue(lean([]));
    mockConfig.mockResolvedValue({
      "voicechannels.category_id": "100000000000000099",
      "voicechannels.lobby.channel_id": "",
    });
    const map = await loadProtection(guild, voiceChannels);
    expect(map.has("100000000000000040")).toBe(true);
  });

  it("protects rooms the voice service holds only in memory (a managed-row write still pending)", async () => {
    // createWaitingRoom() keeps the room in memory and queues the failed write
    // in pendingManagedChannels; Mongo has recovered but the retry has not run,
    // so no row exists yet.
    const manager: any = VoiceChannelManager.getInstance(fakeClient);
    manager.pendingManagedChannels.set("100000000000000060", {
      guildId: "g1",
      kind: "waiting_room",
    });
    manager.waitingRoomToMain.set("100000000000000061", "100000000000000062");
    manager.userChannels.set("member-1", { id: "100000000000000063" });
    manager.controlPanels.set("100000000000000064", {
      channelId: "100000000000000064",
      messageId: "m",
    });
    const map = await loadProtection(guild, []);
    for (const id of ["60", "61", "62", "63", "64"]) {
      expect(map.has(`1000000000000000${id}`)).toBe(true);
    }
    expect(map.get("100000000000000060")![0]).toContain("still being saved");
    expect(map.get("100000000000000061")![0]).toContain("waiting room");
    VoiceChannelManager.reset();
  });

  it("protects an untracked legacy New Channel trigger outside the voice category", async () => {
    mockConfig.mockResolvedValue({
      "voicechannels.category_id": "100000000000000099",
    });
    const trigger = {
      ...voiceChannels[2],
      id: "100000000000000070",
      name: "➕ New Channel",
      parentId: "100000000000000123",
    };
    const map = await loadProtection(guild, [trigger]);
    expect(map.get("100000000000000070")![0]).toContain("New Channel");
  });

  it("fails closed when the lobby name settings can't be read", async () => {
    strictFails = true;
    await expect(loadProtection(guild, voiceChannels)).rejects.toThrow(
      "config read failed",
    );
  });

  it("throws when a source can't be read, so a delete fails closed", async () => {
    tickets.mockImplementation(() => {
      throw new Error("db down");
    });
    await expect(loadProtection(guild, [])).rejects.toThrow("db down");
  });
});

describe("loadRecentChanges", () => {
  const chain = (rows: unknown[]) => ({
    sort: () => ({ limit: () => ({ lean: async () => rows }) }),
  });

  it("reads only this guild's channels.* audit entries, newest first, and maps them", async () => {
    auditFind.mockReturnValue(
      chain([
        {
          createdAt: new Date("2026-10-16T13:22:36Z"),
          discordUserId: "u1",
          action: "channels.edit",
          targetId: "100000000000000001",
          details: { name: "general" },
          result: "success",
          errorMessage: null,
        },
        {
          createdAt: new Date("2026-10-16T13:20:00Z"),
          discordUserId: "u1",
          action: "channels.delete",
          targetId: null,
          details: {},
          result: "failure",
          errorMessage: "refused",
        },
      ]),
    );
    const rows = await loadRecentChanges("g1");
    expect(auditFind).toHaveBeenCalledWith({
      guildId: "g1",
      action: { $regex: "^channels\\." },
    });
    expect(rows).toEqual([
      {
        at: "2026-10-16T13:22:36.000Z",
        actorId: "u1",
        action: "channels.edit",
        targetId: "100000000000000001",
        channelName: "general",
        result: "success",
        message: null,
      },
      {
        at: "2026-10-16T13:20:00.000Z",
        actorId: "u1",
        action: "channels.delete",
        targetId: null,
        channelName: null,
        result: "failure",
        message: "refused",
      },
    ]);
  });

  it("returns null when the log can't be read", async () => {
    auditFind.mockImplementation(() => {
      throw new Error("db down");
    });
    expect(await loadRecentChanges("g1")).toBeNull();
  });
});
