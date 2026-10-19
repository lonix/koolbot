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
import { PermissionFlagsBits, PermissionsBitField } from "discord.js";

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
      getBoolean: jest.fn(async (key: string, d: boolean) =>
        key in settings ? settings[key] === true : d,
      ),
      getString: jest.fn(async (key: string, d: string) =>
        key in settings ? String(settings[key]) : d,
      ),
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
  const me = {
    permissions: new PermissionsBitField(opts.serverBits ?? ALL),
    permissionsIn: jest.fn((c: FakeChannel) => new PermissionsBitField(c.bits)),
    roles: { highest: { position: opts.botPosition ?? 10 } },
  };
  const guild = {
    id: "guild-1",
    members: {
      me: opts.noMe ? null : me,
      fetchMe: jest.fn(async () => me),
    },
    roles: { cache: roles, fetch: jest.fn(async () => roles) },
    channels: { cache: channels, fetch: jest.fn(async () => channels) },
  };
  const client = {
    guilds: {
      cache: new Map([["guild-1", guild]]),
      fetch: jest.fn(async () => guild),
    },
  };
  return { client: client as never, me };
}

const direct = {
  call: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
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
      expect(typeof defaultConfig[r.enabledKey]).toBe("boolean");
      if (r.alsoKey) expect(typeof defaultConfig[r.alsoKey]).toBe("boolean");
      if (r.scope !== "guild") {
        expect(r.targetKey).toBeDefined();
        expect(
          typeof defaultConfig[r.targetKey as keyof typeof defaultConfig],
        ).toBe("string");
      }
      expect(r.needs.length).toBeGreaterThan(0);
    }
    for (const r of registry.ROLE_HIERARCHY_REQUIREMENTS) {
      expect(typeof defaultConfig[r.enabledKey]).toBe("boolean");
      expect(typeof defaultConfig[r.roleSource.key]).toBe("string");
    }
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
      channels: [{ id: "cat-ev", name: "Events", bits: ALL }],
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
      channels: [{ id: "cat-ev", name: "Events", bits: ALL }],
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
      "core.role_groups.enabled": true,
      "rules.enabled": true,
    };
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

  it("checks the voice lobby in its own channel", async () => {
    settings = {
      "voicechannels.enabled": true,
      "voicechannels.category_id": "cat-vc",
      "voicechannels.lobby.channel_id": "lobby",
    };
    const report = await run({
      channels: [
        { id: "cat-vc", name: "Voice", bits: ALL },
        { id: "lobby", name: "Lobby", bits: without(ALL, P.MoveMembers) },
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
      "leaderboard_roles.tiers": "1:r-high, 3:r-low",
    };
    const report = await run({
      botPosition: 5,
      roles: [
        { id: "r-high", name: "Admins", position: 9 },
        { id: "r-low", name: "Fans", position: 2 },
      ],
    });
    const above = report.problems.filter((p) => p.target.kind === "role");
    expect(above).toHaveLength(1);
    expect(above[0].target.name).toBe("Admins");
    expect(above[0].features.map((f) => f.id).sort()).toEqual([
      "leaderboard-roles-hierarchy",
      "rules-role-hierarchy",
    ]);
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
    now += check.SNAPSHOT_TTL_MS - 1;
    await check.checkBotPermissions(client, "guild-1", deps);
    expect(guild?.channels.fetch).toHaveBeenCalledTimes(1);
    now += 2;
    await check.checkBotPermissions(client, "guild-1", deps);
    expect(guild?.channels.fetch).toHaveBeenCalledTimes(2);
  });

  it("does not keep a failed read", async () => {
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
    const first = await check.checkBotPermissions(client, "guild-1", deps);
    expect(first.fresh).toBe(false);
    fail = false;
    const second = await check.checkBotPermissions(client, "guild-1", deps);
    expect(second.fresh).toBe(true);
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
        "1:a, 3:b,10:a, ,",
      ),
    ).toEqual(["a", "b"]);
    expect(
      check.configuredRoleIds({ kind: "id", key: "rules.role_id" }, ""),
    ).toEqual([]);
  });
});
