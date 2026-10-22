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
    permissions: new PermissionsBitField(opts.serverBits ?? ALL),
    permissionsIn: jest.fn((c: FakeChannel) => new PermissionsBitField(c.bits)),
    roles: { highest: { position: opts.botPosition ?? 10 } },
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
      if (r.alsoKey) expect(typeof defaultConfig[r.alsoKey]).toBe("boolean");
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
