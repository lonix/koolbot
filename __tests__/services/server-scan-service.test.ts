import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { ChannelType, PermissionsBitField } from "discord.js";
import {
  ServerScanService,
  buildReadiness,
  detectNamingConvention,
  mapFeatureBindings,
} from "../../src/services/server-scan-service.js";
import { ConfigService } from "../../src/services/config-service.js";

const F = PermissionsBitField.Flags;
const bits = (...f: bigint[]): bigint => f.reduce((a, b) => a | b, 0n);

function role(
  id: string,
  name: string,
  position: number,
  extra: any = {},
): any {
  return {
    id,
    name,
    position,
    color: 0,
    managed: false,
    tags: undefined,
    members: new Map(),
    permissions: { bitfield: 0n },
    ...extra,
  };
}

function overwrite(id: string, type: number, allow: bigint, deny: bigint): any {
  return { id, type, allow: { bitfield: allow }, deny: { bitfield: deny } };
}

function makeGuild(): { guild: any; write: jest.Mock } {
  const write = jest.fn();
  const roles = new Map<string, any>([
    ["g1", role("g1", "@everyone", 0)],
    [
      "r-bot",
      role("r-bot", "KoolBot", 5, { managed: true, tags: { botId: "bot-1" } }),
    ],
    ["r-mod", role("r-mod", "Mod", 8)],
    ["r-low", role("r-low", "Member", 2, { members: new Map([["u1", {}]]) })],
    [
      "r-dyno",
      role("r-dyno", "Dyno", 7, { managed: true, tags: { botId: "dyno" } }),
    ],
  ]);
  const cat = {
    id: "cat1",
    name: "🎮 | Games",
    type: ChannelType.GuildCategory,
    rawPosition: 0,
    permissionOverwrites: {
      cache: new Map([
        ["g1", overwrite("g1", 0, 0n, F.ViewChannel)],
        ["r-low", overwrite("r-low", 0, F.ViewChannel, 0n)],
      ]),
    },
  };
  const quotes = {
    id: "ch-quotes",
    name: "🎮 | quotes",
    type: ChannelType.GuildText,
    rawPosition: 1,
    parentId: "cat1",
    permissionsLocked: false,
    topic: "Quotes",
    permissionOverwrites: {
      cache: new Map([["dyno", overwrite("dyno", 1, F.SendMessages, 0n)]]),
    },
  };
  const afk = {
    id: "ch-afk",
    name: "🎮 | afk",
    type: ChannelType.GuildVoice,
    rawPosition: 2,
    parentId: null,
    members: new Map(),
    permissionOverwrites: { cache: new Map() },
  };
  const news = {
    id: "ch-news",
    name: "🎮 | news",
    type: ChannelType.GuildAnnouncement,
    rawPosition: 3,
    parentId: "cat1",
    permissionsLocked: true,
    permissionOverwrites: { cache: new Map() },
  };
  const channels = new Map<string, any>(
    [cat, quotes, afk, news].map((c: any) => [
      c.id,
      Object.assign(c, { isThread: () => false }),
    ]),
  );
  const me = {
    id: "bot-1",
    permissions: { bitfield: bits(F.ViewChannel, F.SendMessages) },
    roles: {
      cache: new Map([["r-bot", roles.get("r-bot")]]),
      highest: roles.get("r-bot"),
    },
  };
  const guild = {
    id: "g1",
    name: "Test",
    ownerId: "owner",
    memberCount: 100,
    afkChannelId: "ch-afk",
    rulesChannelId: null,
    systemChannelId: null,
    publicUpdatesChannelId: null,
    features: ["COMMUNITY"],
    roles: {
      cache: roles,
      everyone: roles.get("g1"),
      fetch: jest.fn(async () => roles),
    },
    channels: { cache: channels, fetch: jest.fn(async () => channels) },
    members: {
      cache: new Map(),
      me,
      fetch: jest.fn(async () => ({
        roles: { cache: new Map([["r-mod", {}]]) },
      })),
    },
    fetchWebhooks: jest.fn(async () => {
      return new Map([
        ["w1", { channelId: "ch-news", type: 2 }],
        ["w2", { channelId: "ch-quotes", type: 1 }],
      ]);
    }),
    fetchOnboarding: jest.fn(async () => ({
      enabled: true,
      defaultChannels: new Map([["ch-news", {}]]),
      prompts: new Map([
        [
          "p1",
          {
            title: "Pick country",
            options: new Map([
              ["o1", { roles: new Map([["r-low", {}]]), channels: new Map() }],
            ]),
          },
        ],
      ]),
    })),
    scheduledEvents: {
      fetch: jest.fn(async () => {
        return new Map([
          [
            "e1",
            {
              id: "e1",
              name: "Game night",
              scheduledStartAt: new Date("2026-11-01T18:00:00Z"),
              status: 1,
              channelId: "ch-afk",
            },
          ],
        ]);
      }),
    },
  };
  return { guild, write };
}

describe("ServerScanService (#1019)", () => {
  beforeEach(() => {
    ServerScanService.reset();
    jest.spyOn(ConfigService, "getInstance").mockReturnValue({
      getAll: async () => [
        { key: "quotes.channel_id", value: "ch-quotes-real" },
        { key: "birthdays.role_id", value: "123456789012345678" },
        { key: "leaderboard_roles.tiers", value: "1:r-mod-x" },
      ],
    } as any);
  });

  const client = {
    user: { id: "bot-1" },
    options: { intents: { has: () => false } },
  } as any;

  it("scans roles, channels, overwrites, bots and readiness without writes", async () => {
    const { guild } = makeGuild();
    const scan = await ServerScanService.getInstance(client).scanGuild(guild, {
      adminUserId: "admin-1",
    });

    expect(scan.guildId).toBe("g1");
    const mod = scan.roles.find((r) => r.id === "r-mod")!;
    expect(mod.botCanManage).toBe(false); // above the bot (8 > 5)
    const low = scan.roles.find((r) => r.id === "r-low")!;
    expect(low.botCanManage).toBe(true);
    expect(low.memberCount).toBe(1);
    expect(low.memberCountApproximate).toBe(true);
    expect(low.onboardingManaged).toBe(true);
    expect(scan.roles.find((r) => r.id === "r-dyno")!.managed).toBe(true);

    const quotes = scan.channels.find((c) => c.id === "ch-quotes")!;
    expect(quotes.syncedToParent).toBe(false);
    expect(quotes.parentName).toBe("🎮 | Games");
    expect(quotes.overwrites[0]).toMatchObject({
      id: "dyno",
      type: "member",
      allow: ["SendMessages"],
    });
    expect(quotes.featureGuess).toBe("quotes");
    expect(quotes.flags.webhookFed).toBe(true);

    const news = scan.channels.find((c) => c.id === "ch-news")!;
    expect(news.flags.announcement).toBe(true);
    expect(news.flags.followed).toBe(true);
    expect(news.flags.onboardingDefault).toBe(true);

    const cat = scan.channels.find((c) => c.id === "cat1")!;
    expect(cat.kind).toBe("category");
    expect(cat.gatedByRoleIds).toEqual(["r-low"]);

    expect(scan.channels.find((c) => c.id === "ch-afk")!.flags.afk).toBe(true);
    expect(scan.suggestions.some((s) => s.code === "afk-not-excluded")).toBe(
      true,
    );
    expect(scan.community.onboardingEnabled).toBe(true);
    expect(scan.community.onboardingRoleIds).toEqual(["r-low"]);
    expect(scan.scheduledEvents[0]!.name).toBe("Game night");

    expect(scan.bots.map((b) => b.userId).sort()).toEqual(["bot-1", "dyno"]);
    const dyno = scan.bots.find((b) => b.userId === "dyno")!;
    expect(dyno.overwriteChannelIds).toEqual(["ch-quotes"]);
  });

  it("produces the planner's ScannedState", async () => {
    const { guild } = makeGuild();
    const { scanned } = await ServerScanService.getInstance(client).scanGuild(
      guild,
      { adminUserId: "admin-1" },
    );
    expect(scanned.guildId).toBe("g1");
    expect(scanned.botUserId).toBe("bot-1");
    expect(scanned.botHighestRolePosition).toBe(5);
    expect(scanned.adminRoleIds).toEqual(["r-mod"]);
    expect(scanned.otherBotIds).toEqual(["dyno"]);
    expect(scanned.roles.some((r) => r.id === "g1")).toBe(true);
    expect(scanned.config["quotes.channel_id"]).toBe("ch-quotes-real");
    const ch = scanned.channels.find((c) => c.id === "ch-quotes")!;
    expect(ch.overwrites[0]).toMatchObject({
      id: "dyno",
      allow: String(F.SendMessages),
    });
  });

  it("reports readiness: missing permissions and low hierarchy", async () => {
    const { guild } = makeGuild();
    const { readiness } =
      await ServerScanService.getInstance(client).scanGuild(guild);
    const missing = readiness.issues.filter((i) =>
      i.code.startsWith("missing-"),
    );
    expect(missing.map((i) => i.code).sort()).toContain("missing-ManageRoles");
    expect(
      missing.find((i) => i.code === "missing-ManageRoles")!.severity,
    ).toBe("error");
    const hier = readiness.issues.find((i) => i.code === "role-hierarchy-low")!;
    expect(hier.message).toContain('"Mod"');
    expect(hier.message).toContain("Move the KoolBot role above");
    expect(readiness.ready).toBe(false);
  });

  it("survives failing webhook and onboarding reads and records them", async () => {
    const { guild } = makeGuild();
    guild.fetchWebhooks = jest.fn(async () => {
      throw new Error("Missing Permissions");
    });
    guild.fetchOnboarding = jest.fn(async () => {
      throw new Error("nope");
    });
    const scan = await ServerScanService.getInstance(client).scanGuild(guild);
    expect(scan.partial.join(" ")).toContain("webhooks");
    expect(scan.partial).toContain("onboarding");
    expect(scan.roles.length).toBeGreaterThan(0);
  });

  it("never fetches the member list", async () => {
    const { guild } = makeGuild();
    guild.members.fetch = jest.fn(async () => ({
      roles: { cache: new Map() },
    }));
    await ServerScanService.getInstance(client).scanGuild(guild, {
      adminUserId: "admin-1",
    });
    // Only the single admin lookup: never a bulk fetch (no args/limit).
    expect(guild.members.fetch).toHaveBeenCalledTimes(1);
    expect(guild.members.fetch).toHaveBeenCalledWith("admin-1");
  });

  it("samples message authors only when asked, flagging a dominant bot", async () => {
    const { guild } = makeGuild();
    const botMsg = (): any => ({
      author: { id: "dyno", bot: true, tag: "Dyno#1" },
    });
    guild.channels.cache.get("ch-quotes").messages = {
      fetch: jest.fn(
        async () =>
          new Map(Array.from({ length: 10 }, (_, i) => [String(i), botMsg()])),
      ),
    };
    const svc = ServerScanService.getInstance(client);
    const off = await svc.scanGuild(guild);
    expect(
      off.channels.find((c) => c.id === "ch-quotes")!.ownerHint,
    ).toBeNull();
    const on = await svc.scanGuild(guild, { sampleMessages: true });
    expect(
      on.channels.find((c) => c.id === "ch-quotes")!.ownerHint,
    ).toMatchObject({
      botId: "dyno",
      share: 1,
    });
  });
});

describe("mapFeatureBindings", () => {
  it("maps channel, category, role and tier keys to features", () => {
    const m = mapFeatureBindings({
      "quotes.channel_id": "123456789012345678",
      "tickets.category_id": "223456789012345678",
      "birthdays.role_id": "323456789012345678",
      "leaderboard_roles.tiers": "1:423456789012345678,3:523456789012345678",
      "voicetracking.excluded_channels":
        "123456789012345678, 623456789012345678",
      "quotes.enabled": true,
    });
    expect(m.channels.get("123456789012345678")).toEqual([
      "quotes",
      "voicetracking",
    ]);
    expect(m.channels.get("223456789012345678")).toEqual(["tickets"]);
    expect(m.roles.get("323456789012345678")).toEqual(["birthdays"]);
    expect(m.roles.get("523456789012345678")).toEqual(["leaderboard_roles"]);
  });
});

describe("detectNamingConvention", () => {
  it("detects an emoji separator pattern and suggests a prefix", () => {
    const n = detectNamingConvention(
      ["🎮 | general", "🎮 | chat", "🎮 | clips", "other"],
      ["🎮 Games", "🔊 Voice"],
    );
    expect(n.pattern).toBe("emoji-separator");
    expect(n.separator).toBe("|");
    expect(n.categoryEmojiPrefix).toBe(true);
    expect(n.suggestedPrefix).toBe("🎮 | ");
  });
  it("detects lower-kebab", () => {
    const n = detectNamingConvention(
      ["general-chat", "off-topic", "memes"],
      [],
    );
    expect(n.pattern).toBe("lower-kebab");
    expect(n.suggestedPrefix).toBeNull();
  });
  it("handles no channels", () => {
    expect(detectNamingConvention([], []).pattern).toBeNull();
  });
});

describe("buildReadiness", () => {
  const base = {
    botUserId: "b",
    botRoles: [{ id: "rb", name: "KoolBot", position: 10 }],
    allRoles: [
      {
        id: "g",
        name: "@everyone",
        position: 0,
        managed: false,
        isEveryone: true,
      },
      {
        id: "rb",
        name: "KoolBot",
        position: 10,
        managed: true,
        isEveryone: false,
      },
    ],
    roleBindings: new Map<string, string[]>(),
    membersIntent: true,
  };
  it("is ready with all permissions and top position", () => {
    const r = buildReadiness({
      ...base,
      permissionBits: PermissionsBitField.All,
      administrator: false,
    });
    expect(r.ready).toBe(true);
    expect(r.issues).toEqual([]);
  });
  it("errors when a feature's role sits above the bot", () => {
    const r = buildReadiness({
      ...base,
      allRoles: [
        ...base.allRoles,
        {
          id: "x",
          name: "VIP",
          position: 20,
          managed: false,
          isEveryone: false,
        },
      ],
      roleBindings: new Map([["x", ["birthdays"]]]),
      permissionBits: PermissionsBitField.All,
      administrator: true,
    });
    expect(r.ready).toBe(false);
    expect(
      r.issues.find((i) => i.code === "bound-role-unmanageable-x")!.message,
    ).toContain("birthdays");
  });
});
