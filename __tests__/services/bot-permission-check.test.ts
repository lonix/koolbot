/**
 * The bot permission check (#1217): what the bot is missing, where, and which
 * enabled features that affects. Discord is a fake guild; the permission maths
 * is discord.js's own `PermissionsBitField`, with channel overwrites modelled by
 * giving a channel its own effective bits (what `permissionsIn` would return).
 */

import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import {
  ChannelType,
  PermissionFlagsBits,
  PermissionsBitField,
} from "discord.js";

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  isDebugMode: jest.fn(() => false),
}));

let settings: Record<string, string | boolean> = {};
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      getBooleanStrict: jest.fn(async (key: string, d: boolean) => {
        if (settings.__unreadable === true) throw new Error("db down");
        return key in settings ? settings[key] === true : d;
      }),
      getStringStrict: jest.fn(async (key: string, d: string) => {
        if (settings.__unreadable === true) throw new Error("db down");
        return key in settings ? String(settings[key]) : d;
      }),
    }),
  },
}));

const check = await import("../../src/services/bot-permission-check.js");
const registry = await import("../../src/services/bot-permission-registry.js");
const status = await import("../../src/services/bot-permission-status.js");
const { defaultConfig } = await import("../../src/services/config-schema.js");

const P = PermissionFlagsBits;
const ALL =
  P.ManageChannels |
  P.MoveMembers |
  P.Connect |
  P.ManageRoles |
  P.ManageNicknames |
  P.ManageEvents |
  P.ViewChannel |
  P.Speak |
  P.SetVoiceChannelStatus;

interface FakeChannel {
  id: string;
  name: string;
  /** What the bot effectively holds here (the server-wide bits after overwrites). */
  bits: bigint;
  type?: number;
  parentId?: string;
}

function bits(...p: bigint[]): bigint {
  return p.reduce((a, b) => a | b, 0n);
}

function without(all: bigint, ...p: bigint[]): bigint {
  return all & ~bits(...p);
}

function makeClient(opts: {
  serverBits?: bigint;
  channels?: FakeChannel[];
  roles?: Array<{ id: string; name: string; position: number }>;
  /** What Discord returns for a bulk fetch, when it differs from the gateway cache. */
  fetchedChannels?: FakeChannel[];
  fetchedRoles?: Array<{ id: string; name: string; position: number }>;
  botPosition?: number;
  noMe?: boolean;
  /** The managed bot role's own bits; absent = the bot has no managed role in the cache. */
  botRoleBits?: bigint;
}): {
  client: never;
  me: { permissionsIn: jest.Mock };
} {
  const channels = new Map(
    (opts.channels ?? []).map((c) => [c.id, c] as const),
  );
  const roles = new Map((opts.roles ?? []).map((r) => [r.id, r] as const));
  const fetchedChannels = opts.fetchedChannels
    ? new Map(opts.fetchedChannels.map((c) => [c.id, c] as const))
    : channels;
  const fetchedRoles = opts.fetchedRoles
    ? new Map(opts.fetchedRoles.map((r) => [r.id, r] as const))
    : roles;
  const me = {
    id: "bot-1",
    permissions: new PermissionsBitField(opts.serverBits ?? ALL),
    permissionsIn: jest.fn((c: FakeChannel) => new PermissionsBitField(c.bits)),
    roles: {
      cache: new Map([["bot-role", {}]]),
      highest: { position: opts.botPosition ?? 10 },
      botRole:
        opts.botRoleBits === undefined
          ? null
          : { permissions: new PermissionsBitField(opts.botRoleBits) },
    },
  };
  const guild = {
    id: "guild-1",
    members: {
      me: opts.noMe ? null : me,
      fetchMe: jest.fn(async () => {
        if (opts.noMe) throw new Error("unknown member");
        return me;
      }),
    },
    roles: { cache: roles, fetch: jest.fn(async () => fetchedRoles) },
    channels: {
      cache: channels,
      fetch: jest.fn(async () => fetchedChannels),
    },
  };
  const client = {
    guilds: {
      cache: new Map([["guild-1", guild]]),
      fetch: jest.fn(async () => guild),
    },
  };
  return { client: client as never, me };
}

let roleGroups = 0;
const direct = {
  call: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  roleGroupCount: async (): Promise<number> => roleGroups,
};

async function run(
  opts: Parameters<typeof makeClient>[0],
): Promise<Awaited<ReturnType<typeof check.checkBotPermissions>>> {
  // Each call is a new fake server, so the shared read must not carry over.
  check.resetBotPermissionCache();
  const { client } = makeClient(opts);
  return check.checkBotPermissions(client, "guild-1", direct);
}

beforeEach(() => {
  settings = {};
  roleGroups = 0;
  check.resetBotPermissionCache();
  status.resetPermissionIssueCount();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("registry", () => {
  it("only names settings that exist, and gives channel scopes a target setting", () => {
    const ids = new Set<string>();
    for (const r of registry.FEATURE_REQUIREMENTS) {
      expect(ids.has(r.id)).toBe(false);
      ids.add(r.id);
      if (r.enabledKey) {
        expect(typeof defaultConfig[r.enabledKey]).toBe("boolean");
      } else {
        expect(r.usedWhen).toBeDefined();
      }
      for (const k of r.alsoKeys ?? [])
        expect(typeof defaultConfig[k]).toBe("boolean");
      if (r.scope !== "guild" && !r.targetResolver) {
        expect(r.targetKey).toBeDefined();
        expect(
          typeof defaultConfig[r.targetKey as keyof typeof defaultConfig],
        ).toBe("string");
      }
      if (r.targetResolver) expect(r.scope).toBe("channel");
      expect(r.needs.length).toBeGreaterThan(0);
    }
    for (const r of registry.ROLE_HIERARCHY_REQUIREMENTS) {
      expect(typeof defaultConfig[r.enabledKey]).toBe("boolean");
      expect(typeof defaultConfig[r.roleSource.key]).toBe("string");
    }
  });

  it("lists the permissions in Discord's role-editor order, each once", () => {
    const keys = Object.keys(registry.PERM).sort();
    expect([...registry.PERMISSION_ORDER].sort()).toEqual(keys);
    expect(new Set(registry.PERMISSION_ORDER).size).toBe(keys.length);
  });

  it("lists the leaders-only channel's permissions as the service needs them", () => {
    expect(registry.LEADS_NEEDS.map((n) => n.name)).toEqual([
      "View Channel",
      "Connect",
      "Speak",
      "Move Members",
      "Manage Roles",
    ]);
  });
});

describe("what is missing and where", () => {
  it("reports nothing when every permission is held in the configured places", async () => {
    settings = {
      "events.enabled": true,
      "events.category_id": "cat-ev",
    };
    const report = await run({
      channels: [
        {
          id: "cat-ev",
          type: ChannelType.GuildCategory,
          name: "Events",
          bits: ALL,
        },
      ],
    });
    expect(report.available).toBe(true);
    expect(report.problems).toEqual([]);
    expect(report.unknown).toEqual([]);
    expect(report.okFeatures.map((f) => f.id)).toContain("event-channels");
  });

  it("counts a category overwrite that denies what the role has server-wide", async () => {
    settings = {
      "events.enabled": true,
      "events.category_id": "cat-ev",
    };
    // The role holds Manage Channels server-wide; the category denies it.
    const report = await run({
      serverBits: ALL,
      channels: [
        {
          id: "cat-ev",
          type: ChannelType.GuildCategory,
          name: "Events",
          bits: without(ALL, P.ManageChannels),
        },
      ],
    });
    const problem = report.problems.find(
      (p) => p.permission === "Manage Channels",
    );
    expect(problem).toBeDefined();
    expect(problem?.target).toEqual({
      kind: "category",
      id: "cat-ev",
      name: "Events",
      channelType: ChannelType.GuildCategory,
    });
    expect(problem?.features.map((f) => f.id)).toEqual(["event-channels"]);
  });

  it("does not take a server-wide gap for fine when the channel grants it", async () => {
    settings = {
      "events.enabled": true,
      "events.category_id": "cat-ev",
    };
    // Not held server-wide, but the category's overwrite grants it.
    const report = await run({
      serverBits: without(ALL, P.ManageChannels),
      channels: [
        {
          id: "cat-ev",
          type: ChannelType.GuildCategory,
          name: "Events",
          bits: ALL,
        },
      ],
    });
    expect(
      report.problems.find((p) => p.permission === "Manage Channels"),
    ).toBeUndefined();
  });

  it("names the server-wide scope for permissions a channel cannot grant", async () => {
    settings = { "events.enabled": true };
    const report = await run({ serverBits: without(ALL, P.ManageNicknames) });
    const problem = report.problems.find(
      (p) => p.permission === "Manage Nicknames",
    );
    expect(problem?.target.kind).toBe("server");
    expect(problem?.features.map((f) => f.id)).toEqual(["event-tags"]);
  });

  it("accepts Manage Events instead of Create Events, and reports both names when neither is held", async () => {
    settings = { "events.enabled": true };
    const ok = await run({ serverBits: bits(P.ManageEvents) });
    expect(ok.problems.find((p) => p.permission.includes("Events"))).toBe(
      undefined,
    );
    const bad = await run({ serverBits: 0n });
    expect(
      bad.problems.some(
        (p) => p.permission === "Create Events or Manage Events",
      ),
    ).toBe(true);
  });

  it("puts one missing permission in one place together with every feature it affects", async () => {
    settings = {
      "reactionroles.enabled": true,
      "leaderboard_roles.enabled": true,
      "rules.enabled": true,
    };
    roleGroups = 2;
    const report = await run({ serverBits: without(ALL, P.ManageRoles) });
    const roles = report.problems.filter(
      (p) => p.permission === "Manage Roles" && p.target.kind === "server",
    );
    expect(roles).toHaveLength(1);
    expect(roles[0].features.map((f) => f.id).sort()).toEqual([
      "leaderboard-roles",
      "reaction-roles",
      "role-groups",
      "rules-role",
    ]);
  });

  it("counts role groups as in use when the server has one, whatever the logging switch says", async () => {
    settings = { "core.role_groups.enabled": false };
    roleGroups = 1;
    const report = await run({ serverBits: without(ALL, P.ManageRoles) });
    expect(
      report.problems
        .find((p) => p.permission === "Manage Roles")
        ?.features.map((f) => f.id),
    ).toEqual(["role-groups"]);
  });

  it("does not count role groups as in use when the server has none", async () => {
    settings = { "core.role_groups.enabled": true };
    roleGroups = 0;
    const report = await run({ serverBits: without(ALL, P.ManageRoles) });
    expect(report.problems).toEqual([]);
    expect(report.quiet.map((q) => q.feature.id)).toContain("role-groups");
  });

  it("checks the voice lobby in its own channel", async () => {
    settings = {
      "voicechannels.enabled": true,
      "voicechannels.category_id": "cat-vc",
      "voicechannels.lobby.channel_id": "lobby",
    };
    const report = await run({
      channels: [
        {
          id: "cat-vc",
          type: ChannelType.GuildCategory,
          name: "Voice",
          bits: ALL,
        },
        {
          id: "lobby",
          name: "Lobby",
          bits: without(ALL, P.MoveMembers),
          type: ChannelType.GuildVoice,
          parentId: "cat-vc",
        },
      ],
    });
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0].permission).toBe("Move Members");
    expect(report.problems[0].target.name).toBe("Lobby");
    expect(report.problems[0].features.map((f) => f.id)).toEqual([
      "voice-lobby",
    ]);
  });

  it("flags a role the bot cannot hand out because it is above the bot", async () => {
    settings = {
      "rules.enabled": true,
      "rules.role_id": "r-high",
      "leaderboard_roles.enabled": true,
      "leaderboard_roles.tiers": "1:9001, 3:9002,",
    };
    const report = await run({
      botPosition: 5,
      roles: [
        { id: "r-high", name: "Admins", position: 9 },
        { id: "9001", name: "Top fans", position: 9 },
        { id: "9002", name: "Fans", position: 2 },
      ],
    });
    const above = report.problems.filter((p) => p.target.kind === "role");
    expect(above.map((a) => a.target.name).sort()).toEqual([
      "Admins",
      "Top fans",
    ]);
    expect(
      above.find((a) => a.target.name === "Top fans")?.features[0].id,
    ).toBe("leaderboard-roles-hierarchy");
  });

  it("does not list a feature as in place while its role cannot be handed out", async () => {
    settings = {
      "rules.enabled": true,
      "rules.role_id": "r-high",
      "leaderboard_roles.enabled": true,
      "leaderboard_roles.tiers": "1:9404",
    };
    const report = await run({
      botPosition: 5,
      // The rules role is above the bot; the tier role does not exist.
      roles: [{ id: "r-high", name: "Admins", position: 9 }],
    });
    const ok = report.okFeatures.map((f) => f.id);
    expect(ok).not.toContain("rules-role");
    expect(ok).not.toContain("leaderboard-roles");
    expect(report.problems.some((p) => p.target.name === "Admins")).toBe(true);
    expect(report.unknown.map((u) => u.feature.id)).toContain(
      "leaderboard-roles-hierarchy",
    );
  });

  it("still lists them as in place when the roles are below the bot", async () => {
    settings = { "rules.enabled": true, "rules.role_id": "r-low" };
    const report = await run({
      botPosition: 5,
      roles: [{ id: "r-low", name: "Fans", position: 2 }],
    });
    expect(report.okFeatures.map((f) => f.id)).toContain("rules-role");
  });

  it("only checks the tier roles the leaderboard service would act on", async () => {
    settings = {
      "leaderboard_roles.enabled": true,
      // Malformed entries are ignored, and a repeated Top N keeps its last role.
      "leaderboard_roles.tiers": "1:9001,1:9002,x:9003,2:not-an-id",
    };
    const report = await run({
      botPosition: 5,
      roles: [
        { id: "9001", name: "Replaced", position: 9 },
        { id: "9002", name: "Kept", position: 9 },
        { id: "9003", name: "Malformed", position: 9 },
      ],
    });
    expect(
      report.problems
        .filter((p) => p.target.kind === "role")
        .map((p) => p.target.name),
    ).toEqual(["Kept"]);
  });

  it("finds the voice lobby by name when no lobby id is set", async () => {
    settings = {
      "voicechannels.enabled": true,
      "voicechannels.category_id": "cat-vc",
    };
    const report = await run({
      channels: [
        {
          id: "cat-vc",
          type: ChannelType.GuildCategory,
          name: "Voice",
          bits: ALL,
        },
        {
          id: "l1",
          name: "Lobby",
          bits: without(ALL, P.MoveMembers),
          type: ChannelType.GuildVoice,
          parentId: "cat-vc",
        },
        // Same name outside the managed category: not the lobby.
        {
          id: "l2",
          name: "Lobby",
          bits: ALL,
          type: ChannelType.GuildVoice,
          parentId: "other",
        },
      ],
    });
    const lobby = report.problems.find((p) => p.target.id === "l1");
    expect(lobby?.permission).toBe("Move Members");
    expect(lobby?.features.map((f) => f.id)).toEqual(["voice-lobby"]);
  });

  it("says the lobby could not be checked, not fine, when it cannot be found", async () => {
    settings = {
      "voicechannels.enabled": true,
      "voicechannels.category_id": "cat-vc",
      "voicechannels.lobby.channel_id": "not-here",
    };
    const report = await run({
      channels: [
        {
          id: "cat-vc",
          type: ChannelType.GuildCategory,
          name: "Voice",
          bits: ALL,
        },
      ],
    });
    expect(report.unknown.map((u) => u.feature.id)).toEqual(["voice-lobby"]);
    expect(report.okFeatures.map((f) => f.id)).not.toContain("voice-lobby");
    expect(
      report.checks.find((c) => c.feature.id === "voice-lobby"),
    ).toMatchObject({ enabled: true, outcome: "unknown" });
  });

  it("treats the room-status grant as on when its setting is absent, like the voice service", async () => {
    settings = {
      "voicechannels.enabled": true,
      "voicechannels.category_id": "cat-vc",
    };
    const report = await run({
      channels: [
        {
          id: "cat-vc",
          type: ChannelType.GuildCategory,
          name: "Voice",
          bits: without(ALL, P.SetVoiceChannelStatus),
        },
      ],
    });
    expect(report.problems.map((p) => p.permission)).toContain(
      "Set Voice Channel Status",
    );
  });
});

describe("enabled and configured features only", () => {
  it("does not report a permission only a disabled feature needs, but notes it quietly", async () => {
    settings = { "events.enabled": false };
    const report = await run({ serverBits: without(ALL, P.ManageNicknames) });
    expect(report.problems).toEqual([]);
    expect(report.quiet.map((q) => q.feature.id)).toContain("event-tags");
    expect(status.getPermissionIssueCount()).toBe(0);
  });

  it("reports the same gap as a problem once the feature is switched on", async () => {
    settings = { "events.enabled": true };
    const report = await run({ serverBits: without(ALL, P.ManageNicknames) });
    expect(report.problems.map((p) => p.permission)).toEqual([
      "Manage Nicknames",
    ]);
    expect(report.quiet.map((q) => q.feature.id)).not.toContain("event-tags");
    expect(status.getPermissionIssueCount()).toBe(1);
  });

  it("lists only the enabled features among those a permission affects", async () => {
    settings = {
      "reactionroles.enabled": true,
      "leaderboard_roles.enabled": false,
    };
    const report = await run({ serverBits: without(ALL, P.ManageRoles) });
    const problem = report.problems.find(
      (p) => p.permission === "Manage Roles",
    );
    expect(problem?.features.map((f) => f.id)).toEqual(["reaction-roles"]);
    expect(report.quiet.map((q) => q.feature.id)).toContain(
      "leaderboard-roles",
    );
  });

  it("does not check a sub-feature whose own switch is off", async () => {
    settings = {
      "voicechannels.enabled": true,
      "voicechannels.category_id": "cat-vc",
      "voicechannels.owner.grant_status": false,
    };
    const report = await run({
      channels: [
        {
          id: "cat-vc",
          type: ChannelType.GuildCategory,
          name: "Voice",
          bits: without(ALL, P.SetVoiceChannelStatus),
        },
      ],
    });
    expect(report.problems).toEqual([]);
    settings["voicechannels.owner.grant_status"] = true;
    check.resetBotPermissionCache();
    const on = await run({
      channels: [
        {
          id: "cat-vc",
          type: ChannelType.GuildCategory,
          name: "Voice",
          bits: without(ALL, P.SetVoiceChannelStatus),
        },
      ],
    });
    expect(on.problems.map((p) => p.permission)).toEqual([
      "Set Voice Channel Status",
    ]);
  });

  it("skips an enabled feature whose category is not configured and says so", async () => {
    settings = { "events.enabled": true, "events.category_id": "" };
    const report = await run({
      serverBits: 0n,
      channels: [],
    });
    expect(report.problems.some((p) => p.target.kind === "category")).toBe(
      false,
    );
    expect(report.notes.some((n) => n.includes("events.category_id"))).toBe(
      true,
    );
  });
});

describe("failing clearly", () => {
  it("is unknown, never fine, when the configured category cannot be found", async () => {
    settings = { "events.enabled": true, "events.category_id": "gone" };
    const report = await run({ channels: [] });
    expect(report.unknown.map((u) => u.feature.id)).toContain("event-channels");
    expect(report.okFeatures.map((f) => f.id)).not.toContain("event-channels");
  });

  it("reports the managed bot role's own bits, not the member's (@everyone and other roles included)", async () => {
    // The member holds everything (e.g. SendMessages from @everyone); the bot role only ViewChannel.
    const report = await run({ botRoleBits: P.ViewChannel });
    expect(report.serverPermissions).toBe(P.ViewChannel);
  });

  it("has no server permission list when the bot's managed role is not known", async () => {
    expect((await run({})).serverPermissions).toBeNull();
    expect((await run({ noMe: true })).serverPermissions).toBeNull();
  });

  it("is unknown when the bot's own membership is not available", async () => {
    settings = { "reactionroles.enabled": true };
    const report = await run({ noMe: true });
    expect(report.unknown.map((u) => u.feature.id)).toContain("reaction-roles");
    expect(report.okFeatures).toEqual([]);
    expect(report.notes.some((n) => n.includes("membership"))).toBe(true);
  });

  it("says the check is unavailable when the server cannot be read", async () => {
    const client = {
      guilds: {
        cache: new Map(),
        fetch: jest.fn(async () => {
          throw new Error("down");
        }),
      },
    } as never;
    const report = await check.checkBotPermissions(client, "guild-1", direct);
    expect(report.available).toBe(false);
    expect(report.reason).toContain("could not read this server");
    expect(report.problems).toEqual([]);
  });

  it("falls back to the cached view, labelled, when Discord cannot be reached", async () => {
    settings = { "reactionroles.enabled": true };
    const { client } = makeClient({ serverBits: without(ALL, P.ManageRoles) });
    const report = await check.checkBotPermissions(client, "guild-1", {
      ...direct,
      call: async () => {
        throw new Error("timeout");
      },
    });
    expect(report.available).toBe(true);
    expect(report.fresh).toBe(false);
    expect(report.notes.some((n) => n.includes("cached"))).toBe(true);
    expect(report.problems.map((p) => p.permission)).toEqual(["Manage Roles"]);
  });
});

describe("a read that outlasts the TTL", () => {
  it("is shared by a later request instead of starting another", async () => {
    settings = { "reactionroles.enabled": true };
    const { client } = makeClient({});
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    let now = 1_000;
    const deps = {
      ...direct,
      call: async <T>(fn: () => Promise<T>): Promise<T> => {
        calls += 1;
        await gate;
        return fn();
      },
      now: () => now,
    };
    const first = check.checkBotPermissions(client, "guild-1", deps);
    // Rate-limit backoff keeps the first read going past the TTL.
    now += check.SNAPSHOT_TTL_MS * 3;
    const second = check.checkBotPermissions(client, "guild-1", deps);
    release();
    await Promise.all([first, second]);
    // One read: roles, channels and the member, once.
    expect(calls).toBe(3);
    // The TTL runs from when the read settled.
    await check.checkBotPermissions(client, "guild-1", deps);
    expect(calls).toBe(3);
    now += check.SNAPSHOT_TTL_MS + 1;
    await check.checkBotPermissions(client, "guild-1", deps);
    expect(calls).toBe(6);
  });
});

describe("a configured category must be a category", () => {
  it("is not in place when the id belongs to a text channel that grants everything", async () => {
    settings = { "events.enabled": true, "events.category_id": "txt" };
    const report = await run({
      channels: [
        { id: "txt", name: "general", bits: ALL, type: ChannelType.GuildText },
      ],
    });
    expect(report.unknown.map((u) => u.feature.id)).toContain("event-channels");
    expect(
      report.unknown.find((u) => u.feature.id === "event-channels")?.note,
    ).toContain("not a category");
    expect(report.okFeatures.map((f) => f.id)).not.toContain("event-channels");
  });

  it("is not in place when the voice category id belongs to a voice channel", async () => {
    settings = {
      "voicechannels.enabled": true,
      "voicechannels.category_id": "vc",
    };
    const report = await run({
      channels: [
        { id: "vc", name: "Lounge", bits: ALL, type: ChannelType.GuildVoice },
      ],
    });
    expect(report.unknown.map((u) => u.feature.id)).toContain("voice-rooms");
    expect(report.okFeatures.map((f) => f.id)).not.toContain("voice-rooms");
  });
});

describe("what Discord just returned wins over the gateway cache", () => {
  it("does not report healthy for a category the fetch no longer returns", async () => {
    settings = { "events.enabled": true, "events.category_id": "cat-ev" };
    const stale = {
      id: "cat-ev",
      type: ChannelType.GuildCategory,
      name: "Events",
      bits: ALL,
    };
    const report = await run({ channels: [stale], fetchedChannels: [] });
    expect(report.fresh).toBe(true);
    expect(report.unknown.map((u) => u.feature.id)).toContain("event-channels");
    expect(report.okFeatures.map((f) => f.id)).not.toContain("event-channels");
  });

  it("does not check a role the fetch no longer returns as if it existed", async () => {
    settings = { "rules.enabled": true, "rules.role_id": "777" };
    const report = await run({
      botPosition: 5,
      roles: [{ id: "777", name: "Gone", position: 1 }],
      fetchedRoles: [],
    });
    expect(report.unknown.map((u) => u.feature.id)).toContain(
      "rules-role-hierarchy",
    );
  });
});

describe("a read with one failure and one still pending", () => {
  it("settles, and starts its TTL, only when every read has settled", async () => {
    settings = { "reactionroles.enabled": true };
    const { client } = makeClient({});
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    let now = 1_000;
    const deps = {
      ...direct,
      call: async <T>(fn: () => Promise<T>, name: string): Promise<T> => {
        calls += 1;
        if (name === "perm-roles") throw new Error("429");
        if (name === "perm-channels") await gate;
        return fn();
      },
      now: () => now,
    };
    let done = false;
    const first = check
      .checkBotPermissions(client, "guild-1", deps)
      .then(() => {
        done = true;
      });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(done).toBe(false);
    now += check.SNAPSHOT_TTL_MS * 2;
    release();
    await first;
    expect(calls).toBe(3);
    // The TTL runs from when the last read settled, so this reuses the result.
    const again = await check.checkBotPermissions(client, "guild-1", deps);
    expect(calls).toBe(3);
    expect(again.fresh).toBe(false);
  });
});

describe("unreadable settings", () => {
  it("makes the check unavailable instead of treating features as off", async () => {
    settings = { "reactionroles.enabled": true, __unreadable: true };
    check.resetBotPermissionCache();
    status.setPermissionIssueCount("guild-1", 4);
    const report = await run({ serverBits: without(ALL, P.ManageRoles) });
    expect(report.available).toBe(false);
    expect(report.reason).toContain("settings could not be read");
    expect(report.problems).toEqual([]);
    // The badge keeps its last known count rather than being cleared.
    expect(status.getPermissionIssueCount()).toBe(4);
  });
});

describe("fresh reads with a short cache", () => {
  it("re-reads roles, channels and the bot member, and shares the read for a short while", async () => {
    settings = { "reactionroles.enabled": true };
    const { client } = makeClient({});
    const guild = (
      client as unknown as {
        guilds: {
          cache: Map<
            string,
            {
              roles: { fetch: jest.Mock };
              channels: { fetch: jest.Mock };
              members: { fetchMe: jest.Mock };
            }
          >;
        };
      }
    ).guilds.cache.get("guild-1");
    let now = 1_000_000;
    const deps = { ...direct, now: () => now };
    await Promise.all([
      check.checkBotPermissions(client, "guild-1", deps),
      check.checkBotPermissions(client, "guild-1", deps),
    ]);
    expect(guild?.roles.fetch).toHaveBeenCalledTimes(1);
    expect(guild?.channels.fetch).toHaveBeenCalledTimes(1);
    expect(guild?.members.fetchMe).toHaveBeenCalledTimes(1);
    // The bot's own roles are re-read, not taken from the member cache.
    expect(guild?.members.fetchMe).toHaveBeenCalledWith({ force: true });
    now += check.SNAPSHOT_TTL_MS - 1;
    await check.checkBotPermissions(client, "guild-1", deps);
    expect(guild?.channels.fetch).toHaveBeenCalledTimes(1);
    now += 2;
    await check.checkBotPermissions(client, "guild-1", deps);
    expect(guild?.channels.fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed read for the TTL and retries after it", async () => {
    settings = { "reactionroles.enabled": true };
    const { client } = makeClient({});
    let fail = true;
    const deps = {
      call: async <T>(fn: () => Promise<T>): Promise<T> => {
        if (fail) throw new Error("down");
        return fn();
      },
      now: () => 1,
    };
    let now = 1;
    const timed = { ...deps, now: () => now };
    const first = await check.checkBotPermissions(client, "guild-1", timed);
    expect(first.fresh).toBe(false);
    // Discord recovers, but within the TTL the outage result is reused, so a
    // stream of page loads cannot start new reads.
    fail = false;
    now += check.SNAPSHOT_TTL_MS - 1;
    const within = await check.checkBotPermissions(client, "guild-1", timed);
    expect(within.fresh).toBe(false);
    now += 2;
    const after = await check.checkBotPermissions(client, "guild-1", timed);
    expect(after.fresh).toBe(true);
  });
});

describe("configuredRoleIds", () => {
  it("reads a single id and topN:roleId pairs", () => {
    expect(
      check.configuredRoleIds({ kind: "id", key: "rules.role_id" }, " r1 "),
    ).toEqual(["r1"]);
    expect(
      check.configuredRoleIds(
        { kind: "tiers", key: "leaderboard_roles.tiers" },
        "1:111, 3:222,10:111, ,",
      ),
    ).toEqual(["111", "222"]);
    // What the leaderboard service ignores is not checked either.
    expect(
      check.configuredRoleIds(
        { kind: "tiers", key: "leaderboard_roles.tiers" },
        "1:111,1:222,bad,2:abc,0:333",
      ),
    ).toEqual(["222"]);
    expect(
      check.configuredRoleIds({ kind: "id", key: "rules.role_id" }, ""),
    ).toEqual([]);
  });
});

describe("the per-entry checks the permission matrix is built from (#1306)", () => {
  it("records every registry entry, switched on or not, with its outcome and place", async () => {
    settings = { "events.enabled": true, "events.category_id": "cat" };
    const report = await run({
      serverBits: without(ALL, P.ManageNicknames),
      channels: [
        {
          id: "cat",
          name: "Events",
          type: ChannelType.GuildCategory,
          bits: without(ALL, P.ManageChannels),
        },
      ],
    });
    const byId = new Map(report.checks.map((c) => [c.feature.id, c] as const));
    for (const r of registry.FEATURE_REQUIREMENTS) {
      expect(byId.has(r.id)).toBe(true);
    }
    expect(byId.get("event-channels")).toMatchObject({
      enabled: true,
      outcome: "missing",
      missing: ["Manage Channels"],
      target: { kind: "category", name: "Events" },
    });
    expect(byId.get("event-tags")).toMatchObject({
      enabled: true,
      outcome: "missing",
      missing: ["Manage Nicknames"],
      target: { kind: "server" },
    });
    expect(byId.get("event-moves")).toMatchObject({
      enabled: true,
      outcome: "ok",
      missing: [],
    });
    // Switched off: still checked, so the matrix can show what it would need.
    expect(byId.get("reaction-roles")).toMatchObject({
      enabled: false,
      outcome: "ok",
    });
  });

  it("records an enabled feature with no channel set as unchecked, and a feature that cannot be read as unknown", async () => {
    settings = { "events.enabled": true, "events.category_id": "" };
    const unset = await run({ serverBits: ALL });
    expect(
      unset.checks.find((c) => c.feature.id === "event-channels"),
    ).toMatchObject({ enabled: true, outcome: "unchecked", target: null });
    settings = { "events.enabled": true, "events.category_id": "gone" };
    const gone = await run({ serverBits: ALL, channels: [] });
    expect(
      gone.checks.find((c) => c.feature.id === "event-channels"),
    ).toMatchObject({ enabled: true, outcome: "unknown" });
  });

  it("records role-position checks per role, and one unchecked entry for a switched-off feature", async () => {
    settings = { "rules.enabled": true, "rules.role_id": "r-high" };
    const report = await run({
      botPosition: 5,
      roles: [{ id: "r-high", name: "Admins", position: 9 }],
    });
    const rolePos = report.checks.filter((c) => c.kind === "role-position");
    expect(
      rolePos.find((c) => c.feature.id === "rules-role-hierarchy"),
    ).toMatchObject({
      enabled: true,
      outcome: "missing",
      missing: [check.ROLE_ABOVE_BOT],
      target: { kind: "role", name: "Admins" },
    });
    expect(
      rolePos.find((c) => c.feature.id === "leaderboard-roles-hierarchy"),
    ).toMatchObject({ enabled: false, outcome: "unchecked", target: null });
  });

  it("leaves the navigation badge count as it was: two features sharing one gap count once", async () => {
    settings = {
      "reactionroles.enabled": true,
      "leaderboard_roles.enabled": true,
    };
    const report = await run({ serverBits: without(ALL, P.ManageRoles) });
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0].features).toHaveLength(2);
    expect(
      report.checks.filter((c) => c.enabled && c.outcome === "missing"),
    ).toHaveLength(2);
    expect(status.getPermissionIssueCount()).toBe(1);
  });
});

describe("channel-posting features (#1254)", () => {
  const TEXT = bits(
    P.ViewChannel,
    P.SendMessages,
    P.EmbedLinks,
    P.ReadMessageHistory,
    P.AddReactions,
    P.ManageMessages,
    P.PinMessages,
  );
  const runPost = (
    opts: Parameters<typeof makeClient>[0],
  ): ReturnType<typeof run> => run({ serverBits: ALL, ...opts });
  const text = (
    id: string,
    channelBits: bigint = TEXT,
    type: number = ChannelType.GuildText,
  ): FakeChannel => ({ id, name: `name-${id}`, bits: channelBits, type });
  const ids = (list: Array<{ id: string }>): string[] =>
    list.map((f) => f.id).sort();
  const unknownIds = (list: Array<{ feature: { id: string } }>): string[] =>
    list.map((f) => f.feature.id).sort();

  it("reports nothing when the bot holds everything in the quotes and notices channels", async () => {
    settings = {
      "quotes.enabled": true,
      "quotes.channel_id": "q",
      "notices.enabled": true,
      "notices.channel_id": "n",
    };
    const report = await runPost({ channels: [text("q"), text("n")] });
    expect(report.problems).toEqual([]);
    expect(report.unknown).toEqual([]);
    expect(ids(report.okFeatures)).toEqual([
      "notices-cleanup",
      "notices-pin",
      "notices-post",
      "quotes-cleanup",
      "quotes-pin",
      "quotes-post",
      "quotes-votes",
    ]);
  });

  it("counts a channel overwrite that denies Send Messages, and names the channel and every feature it affects", async () => {
    settings = {
      "quotes.enabled": true,
      "quotes.channel_id": "q",
      "moderation.enabled": true,
      "core.moderation.enabled": true,
      "core.moderation.channel_id": "q",
    };
    // The role has Send Messages server-wide; the channel's overwrite removes it.
    const report = await runPost({
      serverBits: ALL,
      channels: [text("q", without(TEXT, P.SendMessages))],
    });
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatchObject({
      permission: "Send Messages",
      target: { kind: "channel", id: "q", name: "name-q" },
    });
    expect(ids(report.problems[0].features)).toEqual([
      "log-moderation",
      "quotes-post",
    ]);
  });

  it("asks each channel what the bot holds there, not the server-wide bits", async () => {
    settings = { "core.errors.enabled": true, "core.errors.channel_id": "e" };
    const { client, me } = makeClient({
      serverBits: ALL | P.SendMessages | P.EmbedLinks,
      channels: [text("e", bits(P.ViewChannel))],
    });
    check.resetBotPermissionCache();
    const report = await check.checkBotPermissions(client, "guild-1", direct);
    expect(me.permissionsIn).toHaveBeenCalled();
    expect(report.problems.map((p) => p.permission).sort()).toEqual([
      "Embed Links",
      "Send Messages",
    ]);
  });

  it("puts the permissions only a switched-off posting feature needs in the quiet notes", async () => {
    settings = {
      "quotes.enabled": false,
      "quotes.channel_id": "q",
      "core.updates.enabled": false,
      "core.updates.channel_id": "q",
    };
    const report = await runPost({
      channels: [text("q", bits(P.ViewChannel))],
    });
    expect(report.problems).toEqual([]);
    expect(unknownIds(report.quiet)).toContain("quotes-post");
    expect(unknownIds(report.quiet)).toContain("log-updates");
    expect(report.okFeatures).toEqual([]);
  });

  it("checks nothing for an enabled posting feature whose channel is not set, and says so", async () => {
    settings = { "notices.enabled": true };
    const report = await runPost({ channels: [] });
    expect(report.problems).toEqual([]);
    expect(report.notes.some((n) => n.includes("notices.channel_id"))).toBe(
      true,
    );
    expect(
      report.checks.find((c) => c.feature.id === "notices-post"),
    ).toMatchObject({ outcome: "unchecked", target: null });
  });

  it("does not require Pin Messages while the header or its pin is off", async () => {
    const channels = [text("q", without(TEXT, P.PinMessages))];
    settings = {
      "quotes.enabled": true,
      "quotes.channel_id": "q",
      "quotes.header_pin_enabled": false,
    };
    let report = await runPost({ channels });
    expect(report.problems).toEqual([]);
    expect(unknownIds(report.quiet)).toEqual(["quotes-pin"]);

    settings = {
      "quotes.enabled": true,
      "quotes.channel_id": "q",
      "quotes.header_enabled": false,
    };
    report = await runPost({ channels });
    expect(report.problems).toEqual([]);

    // Defaults: header and pin both on.
    settings = { "quotes.enabled": true, "quotes.channel_id": "q" };
    report = await runPost({ channels });
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatchObject({ permission: "Pin Messages" });
  });

  it("has no vote-reaction entry for notices (the code adds none), only for quotes", () => {
    const ids = registry.FEATURE_REQUIREMENTS.map((r) => r.id);
    expect(ids).toContain("quotes-votes");
    expect(ids).not.toContain("notices-votes");
  });

  it("reports a category or forum as the posting channel as could not check, never ok", async () => {
    settings = {
      "core.errors.enabled": true,
      "core.errors.channel_id": "cat",
      "moderation.enabled": true,
      "moderation.raid.enabled": true,
      "moderation.raid.alert_channel_id": "f",
    };
    const report = await runPost({
      channels: [
        text("cat", TEXT, ChannelType.GuildCategory),
        text("f", TEXT, ChannelType.GuildForum),
      ],
    });
    expect(report.problems).toEqual([]);
    expect(report.okFeatures).toEqual([]);
    expect(unknownIds(report.unknown)).toEqual(["log-errors", "raid-alerts"]);
    expect(report.unknown[0].note).toMatch(/not a text channel/);
  });

  it("checks the text chat of a voice channel where the services post to any text-based channel", async () => {
    settings = {
      "core.errors.enabled": true,
      "core.errors.channel_id": "v",
      "moderation.enabled": true,
      "moderation.raid.enabled": true,
      "moderation.raid.alert_channel_id": "v",
      "voicetracking.enabled": true,
      "voicetracking.announcements.enabled": true,
      "voicetracking.announcements.channel_id": "v",
    };
    const report = await runPost({
      channels: [text("v", bits(P.ViewChannel), ChannelType.GuildVoice)],
    });
    // The voice channel is really checked (Send Messages and Embed Links are missing there)...
    expect(report.problems.map((p) => p.permission).sort()).toEqual([
      "Embed Links",
      "Send Messages",
    ]);
    // ...except for the announcer, which refuses a voice channel.
    expect(unknownIds(report.unknown)).toEqual(["voice-weekly-stats"]);
  });

  it("shows a configured thread as could not check, with the reason, never ok", async () => {
    settings = {
      "core.errors.enabled": true,
      "core.errors.channel_id": "t",
    };
    const report = await runPost({
      channels: [text("t", TEXT, ChannelType.PublicThread)],
    });
    expect(report.problems).toEqual([]);
    expect(report.okFeatures).toEqual([]);
    expect(unknownIds(report.unknown)).toEqual(["log-errors"]);
    expect(report.unknown[0].note).toMatch(/thread/);
  });

  it("treats a log category as off while the feature that produces it is off", async () => {
    const channels = [text("l", bits(P.ViewChannel))];
    const parents: Array<[string, string, string[]]> = [
      ["updates", "log-updates", ["core.updatecheck.enabled"]],
      ["moderation", "log-moderation", ["moderation.enabled"]],
      [
        "moderation_review",
        "log-moderation-review",
        ["moderation.enabled", "moderation.cases.enabled"],
      ],
      ["cleanup", "log-cleanup", ["voicetracking.cleanup.enabled"]],
    ];
    for (const [type, id, keys] of parents) {
      // The log switch and channel are set; each parent in turn is off.
      for (const off of keys) {
        settings = {
          [`core.${type}.enabled`]: true,
          [`core.${type}.channel_id`]: "l",
          ...Object.fromEntries(keys.map((k) => [k, k !== off])),
        };
        const report = await runPost({ channels });
        expect(report.problems).toEqual([]);
        expect(unknownIds(report.quiet)).toContain(id);
      }
      // All parents on: the missing permissions are real problems.
      settings = {
        [`core.${type}.enabled`]: true,
        [`core.${type}.channel_id`]: "l",
        ...Object.fromEntries(keys.map((k) => [k, true])),
      };
      const report = await runPost({ channels });
      expect(report.problems.length).toBeGreaterThan(0);
    }
  });

  it("treats the update note as on by default, as the update check is", async () => {
    settings = { "core.updates.enabled": true, "core.updates.channel_id": "l" };
    const report = await runPost({
      channels: [text("l", bits(P.ViewChannel))],
    });
    expect(report.problems.length).toBeGreaterThan(0);
  });

  it("needs the moderation log on for anti-raid alerts", async () => {
    const channels = [text("r", bits(P.ViewChannel))];
    settings = {
      "moderation.raid.enabled": true,
      "moderation.raid.alert_channel_id": "r",
      "moderation.enabled": false,
    };
    let report = await runPost({ channels });
    expect(report.problems).toEqual([]);
    expect(unknownIds(report.quiet)).toEqual(["raid-alerts"]);
    settings["moderation.enabled"] = true;
    report = await runPost({ channels });
    expect(report.problems.map((p) => p.permission)).toEqual(["Send Messages"]);
  });

  it("accepts an announcement channel for the log, but not for the weekly announcer, which needs a plain text channel", async () => {
    settings = {
      "core.cron.enabled": true,
      "core.cron.channel_id": "a",
      "voicetracking.enabled": true,
      "voicetracking.announcements.enabled": true,
      "voicetracking.announcements.channel_id": "a",
    };
    const report = await runPost({
      channels: [text("a", TEXT, ChannelType.GuildAnnouncement)],
    });
    expect(ids(report.okFeatures)).toEqual(["log-cron"]);
    expect(unknownIds(report.unknown)).toEqual(["voice-weekly-stats"]);
  });

  it("needs both voice tracking and the announcement switch for the weekly announcer", async () => {
    settings = {
      "voicetracking.enabled": false,
      "voicetracking.announcements.enabled": true,
      "voicetracking.announcements.channel_id": "a",
    };
    const report = await runPost({
      channels: [text("a", bits(P.ViewChannel))],
    });
    expect(report.problems).toEqual([]);
    expect(unknownIds(report.quiet)).toEqual([
      "voice-weekly-accolades",
      "voice-weekly-polls",
      "voice-weekly-quote",
      "voice-weekly-stats",
    ]);
  });

  it("only checks the weekly announcement sections that would be sent", async () => {
    const channels = [text("a", bits(P.ViewChannel))];
    const base = {
      "voicetracking.enabled": true,
      "voicetracking.announcements.enabled": true,
      "voicetracking.announcements.channel_id": "a",
    };
    const sections = {
      "voicetracking.announcements.include_voice_stats": false,
      "voicetracking.announcements.include_accolades": false,
      "voicetracking.announcements.include_quote_of_week": false,
      "voicetracking.announcements.include_poll_turnout": false,
    };
    // Every section switched off: nothing is sent, so nothing is a problem.
    settings = { ...base, ...sections, "quotes.enabled": true };
    let report = await run({ channels });
    expect(report.problems).toEqual([]);
    expect(report.unknown).toEqual([]);
    // One section on, with its own producer switches.
    settings = {
      ...base,
      ...sections,
      "voicetracking.announcements.include_accolades": true,
      "achievements.enabled": true,
      "achievements.announcements.enabled": false,
    };
    report = await run({ channels });
    expect(report.problems).toEqual([]);
    settings["achievements.announcements.enabled"] = true;
    report = await run({ channels });
    expect(report.problems).toHaveLength(1);
    expect(ids(report.problems[0].features)).toEqual([
      "voice-weekly-accolades",
    ]);
    // The quote and poll sections follow quotes and poll participation.
    settings = {
      ...base,
      ...sections,
      "voicetracking.announcements.include_quote_of_week": true,
      "voicetracking.announcements.include_poll_turnout": true,
      "quotes.enabled": true,
      "polls.participation.enabled": false,
    };
    report = await run({ channels });
    expect(ids(report.problems[0].features)).toEqual(["voice-weekly-quote"]);
  });

  it("says could not check when the configured channel is not found", async () => {
    settings = { "quotes.enabled": true, "quotes.channel_id": "gone" };
    const report = await runPost({ channels: [] });
    expect(report.problems).toEqual([]);
    expect(report.okFeatures).toEqual([]);
    expect(unknownIds(report.unknown)).toContain("quotes-post");
  });

  it("covers every Discord log category once, with the registry's literal list equal to the logger's", async () => {
    const { DISCORD_LOG_TYPES } =
      await import("../../src/services/discord-logger.js");
    expect(registry.LOG_CHANNEL_TYPES.map((t) => t.type).sort()).toEqual(
      [...DISCORD_LOG_TYPES].sort(),
    );
    for (const { type } of registry.LOG_CHANNEL_TYPES) {
      const entry = registry.FEATURE_REQUIREMENTS.find(
        (r) => r.id === `log-${type.replace(/_/g, "-")}`,
      );
      expect(entry).toMatchObject({
        scope: "channel",
        targetType: "text",
        enabledKey: `core.${type}.enabled`,
        targetKey: `core.${type}.channel_id`,
      });
      expect(entry?.needs.map((n) => n.name)).toEqual([
        "View Channel",
        "Send Messages",
        "Embed Links",
      ]);
    }
  });

  it("gives every posting entry a channel scope and a text target type", () => {
    for (const r of registry.FEATURE_REQUIREMENTS) {
      if (
        /^(log|quotes|notices)-|^(raid-alerts|voice-weekly)|^(birthdays|celebrations|welcome|lfg|events-announce|leaderboard-announce|rules-message|reaction-picker)/.test(
          r.id,
        )
      ) {
        expect(r.scope).toBe("channel");
        expect(r.targetType).toBeDefined();
      }
    }
  });

  describe("the other posting features (second group)", () => {
    interface Case {
      id: string;
      /** Settings that switch the feature on and set its channel "c". */
      on: Record<string, string | boolean>;
      /** The booleans in `on` that are producer switches, switched off one at a time. */
      parents: string[];
      needs: string[];
      /** Plain text channel only (the service refuses the rest). */
      guildText: boolean;
    }
    const cases: Case[] = [
      {
        id: "birthdays-post",
        on: { "birthdays.enabled": true, "birthdays.channel_id": "c" },
        parents: [],
        needs: ["View Channel", "Send Messages"],
        guildText: true,
      },
      {
        id: "celebrations-post",
        on: {
          "celebrations.enabled": true,
          "celebrations.channel_id": "c",
          "achievements.enabled": true,
          "voicetracking.enabled": true,
        },
        parents: ["achievements.enabled", "voicetracking.enabled"],
        needs: ["View Channel", "Send Messages"],
        guildText: true,
      },
      {
        id: "welcome-post",
        on: { "welcome.enabled": true, "welcome.channel_id": "c" },
        parents: [],
        needs: ["View Channel", "Send Messages"],
        guildText: false,
      },
      {
        id: "lfg-post",
        on: { "lfg.enabled": true, "lfg.channel_id": "c" },
        parents: [],
        needs: [
          "View Channel",
          "Send Messages",
          "Embed Links",
          "Read Message History",
        ],
        guildText: false,
      },
      {
        id: "events-announce",
        on: {
          "events.enabled": true,
          "events.announcement_channel_id": "c",
        },
        parents: [],
        needs: ["View Channel", "Send Messages", "Read Message History"],
        guildText: true,
      },
      {
        id: "leaderboard-announce",
        on: {
          "leaderboard_roles.enabled": true,
          "leaderboard_roles.announcement_channel_id": "c",
          "voicetracking.enabled": true,
        },
        parents: ["voicetracking.enabled"],
        needs: ["View Channel", "Send Messages", "Embed Links"],
        guildText: false,
      },
      {
        id: "rules-message",
        on: { "rules.enabled": true, "rules.channel_id": "c" },
        parents: [],
        needs: ["View Channel", "Send Messages", "Read Message History"],
        guildText: false,
      },
      {
        id: "reaction-picker-post",
        on: {
          "reactionroles.enabled": true,
          "reactionroles.message_channel_id": "c",
        },
        parents: [],
        needs: [
          "View Channel",
          "Send Messages",
          "Embed Links",
          "Read Message History",
        ],
        guildText: false,
      },
      {
        id: "reaction-picker-reactions",
        on: {
          "reactionroles.enabled": true,
          "reactionroles.message_channel_id": "c",
        },
        parents: [],
        needs: ["Add Reactions", "Manage Messages"],
        guildText: false,
      },
    ];
    const bitOf = (name: string): bigint => {
      const found = Object.values(registry.PERM).find((p) => p.name === name);
      if (!found) throw new Error(`no permission ${name}`);
      return found.bit;
    };
    const entryOf = (
      report: Awaited<ReturnType<typeof run>>,
      id: string,
    ): { outcome: string; missing: string[]; enabled: boolean } | undefined =>
      report.checks.find((x) => x.feature.id === id);

    // The channel may be left empty on purpose (no post, or LFG in the command's channel).
    const OPTIONAL_CHANNEL = [
      "celebrations-post",
      "lfg-post",
      "events-announce",
      "leaderboard-announce",
    ];

    it("marks exactly the features whose channel is optional", () => {
      expect(
        registry.FEATURE_REQUIREMENTS.filter((r) => r.targetOptional)
          .map((r) => r.id)
          .sort(),
      ).toEqual([...OPTIONAL_CHANNEL].sort());
    });

    it("lets an enabled event feature with no announcement channel keep the all-clear", async () => {
      settings = { "events.enabled": true, "events.category_id": "cat" };
      const report = await runPost({
        channels: [
          { id: "cat", name: "e", bits: TEXT, type: ChannelType.GuildCategory },
        ],
      });
      expect(report.notes).toEqual([]);
      expect(
        report.checks.some((c) => c.enabled && c.outcome === "unchecked"),
      ).toBe(false);
    });

    it("has an entry for each feature, in the shape the code needs", () => {
      for (const c of cases) {
        const r = registry.FEATURE_REQUIREMENTS.find((x) => x.id === c.id);
        expect(r?.needs.map((n) => n.name)).toEqual(c.needs);
        expect(r?.scope).toBe("channel");
        expect(r?.targetType).toBe(c.guildText ? "guild-text" : "text");
        expect(r?.targetKey).toBe(
          Object.keys(c.on).find((k) => /channel_id$/.test(k)),
        );
      }
    });

    for (const c of cases) {
      describe(c.id, () => {
        const holds = (...except: string[]): bigint =>
          without(TEXT, ...except.map(bitOf));

        it("is fine when the bot holds what it needs", async () => {
          settings = { ...c.on };
          const report = await runPost({ channels: [text("c")] });
          expect(report.problems).toEqual([]);
          expect(entryOf(report, c.id)).toMatchObject({
            outcome: "ok",
            enabled: true,
          });
        });

        for (const need of c.needs) {
          it(`names ${need}, the channel and the feature when it is missing (an overwrite counts)`, async () => {
            settings = { ...c.on };
            // The role has it server-wide; the channel's own bits do not.
            const report = await runPost({
              channels: [text("c", holds(need))],
            });
            const found = report.problems.find((p) => p.permission === need);
            expect(found).toMatchObject({
              target: { kind: "channel", id: "c", name: "name-c" },
            });
            expect(found?.features.map((f) => f.id)).toContain(c.id);
          });
        }

        it("is a quiet note, not a problem, while the feature is off", async () => {
          settings = { ...c.on, [Object.keys(c.on)[0]]: false };
          const report = await runPost({
            channels: [text("c", bits(P.ViewChannel))],
          });
          expect(ids(report.problems.flatMap((p) => p.features))).not.toContain(
            c.id,
          );
          expect(unknownIds(report.quiet)).toContain(c.id);
          expect(entryOf(report, c.id)).toMatchObject({ enabled: false });
        });

        for (const parent of c.parents) {
          it(`is off while ${parent} is off`, async () => {
            settings = { ...c.on, [parent]: false };
            const report = await runPost({
              channels: [text("c", bits(P.ViewChannel))],
            });
            expect(unknownIds(report.quiet)).toContain(c.id);
            expect(
              report.problems.flatMap((p) => p.features.map((f) => f.id)),
            ).not.toContain(c.id);
          });
        }

        it("checks nothing, and says so, while its channel is not set", async () => {
          const channelKey = Object.keys(c.on).find((k) =>
            /channel_id$/.test(k),
          ) as string;
          settings = { ...c.on, [channelKey]: "" };
          const report = await runPost({ channels: [] });
          expect(report.problems).toEqual([]);
          const optional = OPTIONAL_CHANNEL.includes(c.id);
          // An optional channel left empty means nothing posts: not in use,
          // no note, and no "not checked" verdict that would block the green line.
          expect(entryOf(report, c.id)).toMatchObject({
            outcome: "unchecked",
            enabled: !optional,
          });
          expect(report.notes.some((n) => n.includes(channelKey))).toBe(
            !optional,
          );
        });

        it("says could not check, never ok, for a category and for a missing channel", async () => {
          settings = { ...c.on };
          let report = await runPost({
            channels: [text("c", TEXT, ChannelType.GuildCategory)],
          });
          expect(entryOf(report, c.id)).toMatchObject({ outcome: "unknown" });
          expect(unknownIds(report.unknown)).toContain(c.id);
          report = await runPost({ channels: [] });
          expect(entryOf(report, c.id)).toMatchObject({ outcome: "unknown" });
        });

        it(
          c.guildText
            ? "refuses an announcement channel and a voice channel (the service takes a plain text channel only)"
            : "checks the text chat of a voice channel and an announcement channel",
          async () => {
            settings = { ...c.on };
            for (const type of [
              ChannelType.GuildVoice,
              ChannelType.GuildAnnouncement,
            ]) {
              const report = await runPost({
                channels: [text("c", TEXT, type)],
              });
              expect(entryOf(report, c.id)).toMatchObject({
                outcome: c.guildText ? "unknown" : "ok",
              });
            }
          },
        );
      });
    }

    it("never reports a thread as fine", async () => {
      settings = { "welcome.enabled": true, "welcome.channel_id": "c" };
      const report = await runPost({
        channels: [text("c", TEXT, ChannelType.PublicThread)],
      });
      expect(entryOf(report, "welcome-post")).toMatchObject({
        outcome: "unknown",
      });
      expect(report.unknown[0].note).toMatch(/thread/);
    });

    it("lists a missing permission once per channel with every feature that shares the channel", async () => {
      settings = {
        "welcome.enabled": true,
        "welcome.channel_id": "c",
        "leaderboard_roles.enabled": true,
        "leaderboard_roles.announcement_channel_id": "c",
        "voicetracking.enabled": true,
        "rules.enabled": true,
        "rules.channel_id": "c",
      };
      const report = await runPost({
        channels: [text("c", without(TEXT, P.SendMessages))],
      });
      const send = report.problems.filter(
        (p) => p.permission === "Send Messages",
      );
      expect(send).toHaveLength(1);
      expect(ids(send[0].features)).toEqual([
        "leaderboard-announce",
        "rules-message",
        "welcome-post",
      ]);
    });
  });
});
