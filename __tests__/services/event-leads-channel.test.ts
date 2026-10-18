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
  DiscordAPIError,
  OverwriteType,
  PermissionFlagsBits,
  RateLimitError,
} from "discord.js";

/**
 * The leads-only channel (#1199) end to end, with the REAL pieces the
 * production path uses: `EventGroupChannels` and its per-event lock, the real
 * leader writer (`setGroupLeader`) and its `onLeaderChange` hook, the real
 * `installLeadsChannelSync` subscription, the real mover
 * (`moveEventMembers`), and the real write wrapper (`cancellableCall` over the
 * real `CommandManager.makeDiscordApiCall`). Only Discord (a fake server whose
 * overwrites and voice states really change when written) and the event store
 * (`event-group-fake-event.ts`) are stand-ins.
 */

import {
  store,
  EventMock,
  fake,
  type Doc,
  type Group,
} from "./event-group-fake-event.js";

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  isDebugMode: () => false,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

let eventsEnabled = true;
jest.unstable_mockModule("../../src/services/config-service.js", () => ({
  ConfigService: {
    getInstance: (): unknown => ({
      getBoolean: jest.fn(async () => eventsEnabled),
      getNumber: jest.fn(async () => 0),
      getString: jest.fn(async (_k: string, d = "") => d),
      registerReloadCallback: jest.fn(),
    }),
  },
}));
jest.unstable_mockModule(
  "../../src/services/tracking-opt-out-service.js",
  () => ({
    TrackingOptOutService: {
      getInstance: () => ({
        trackWrite: async (
          _u: string,
          _g: string,
          write: () => Promise<void>,
        ) => {
          await write();
          return true;
        },
        admission: () => 1,
        resetAwareWrite: async (
          userIds: string[],
          _g: string,
          write: (ids: string[]) => Promise<unknown>,
        ) => ({ admitted: userIds, value: await write(userIds) }),
      }),
    },
  }),
);

// The event model: the shared fake plus the one write the channel code makes
// (recording a created channel's id).
const Event = {
  ...EventMock,
  updateOne: async (
    filter: Record<string, unknown>,
    update: { $set?: Record<string, unknown> },
    options?: { arrayFilters?: Array<Record<string, string>> },
  ) => {
    const set = update.$set ?? {};
    if ("groups.$.channelId" in set) {
      const doc = store.get(String(filter._id));
      const em = (
        filter.groups as {
          $elemMatch: { key: string; channelId: string | null };
        }
      ).$elemMatch;
      const g = doc?.groups.find(
        (x) => x.key === em.key && x.channelId === em.channelId,
      );
      if (!doc || !g) return { matchedCount: 0, modifiedCount: 0 };
      g.channelId = set["groups.$.channelId"] as string | null;
      return { matchedCount: 1, modifiedCount: 1 };
    }
    return EventMock.updateOne(
      filter,
      update as Parameters<typeof EventMock.updateOne>[1],
      options,
    );
  },
};
jest.unstable_mockModule("../../src/models/event.js", () => ({ Event }));

const { EventGroupChannels, REFUSED_CREATE_BACKOFF_MS } =
  await import("../../src/services/event-group-channels.js");
const { CommandManager } =
  await import("../../src/services/command-manager.js");
const { cancellableCall } = await import("../../src/web/channel-write-rest.js");
const { buildLeadsOverwrites, LEADS_LEADER_PERMISSIONS } =
  await import("../../src/services/event-leads-access.js");
const { installLeadsChannelSync, syncLeadsAccess } =
  await import("../../src/services/event-leads-sync.js");
const { setGroupLeader, installLeaderCleanup, removeLeaderFromEvents } =
  await import("../../src/services/event-group-leaders.js");
const { setMoverDepsForTests } =
  await import("../../src/services/event-member-moves.js");
const { resetMoveGuardForTests, withEventMoveLock } =
  await import("../../src/services/event-move-guard.js");

const GUILD = "111111111111111111";
const HOST = "222222222222222222";
const BOT = "999999999999999999";
const L1 = "333333333333333331";
const L2 = "333333333333333332";
const U3 = "333333333333333333";
const STRANGER = "333333333333333334";
const ADMIN = "444444444444444444";
const EV = "65a000000000000000000001";
const CATEGORY = "cat-1";
const V = PermissionFlagsBits.ViewChannel;
const C = PermissionFlagsBits.Connect;
const S = PermissionFlagsBits.Speak;
const M = PermissionFlagsBits.MoveMembers;

function apiError(code: number, method = "PUT"): DiscordAPIError {
  return new DiscordAPIError(
    { code, message: "x" },
    code,
    400,
    method,
    "/",
    {},
  );
}
function rateLimit(): RateLimitError {
  return new RateLimitError({
    timeToReset: 60_000,
    limit: 1,
    method: "PUT",
    hash: "h",
    url: "/",
    route: "/",
    majorParameter: "",
    global: false,
    retryAfter: 60_000,
    sublimitTimeout: 0,
  } as never);
}

type Ow = {
  id: string;
  type: OverwriteType;
  allow: { bitfield: bigint };
  deny: { bitfield: bigint };
};

function group(key: string, over: Partial<Group> = {}): Group {
  return {
    key,
    name: key.toUpperCase(),
    kind: "team",
    size: null,
    channelId: null,
    captainId: null,
    memberIds: [],
    ...over,
  };
}

function seed(over: Record<string, unknown> = {}): Doc {
  const doc = {
    _id: EV,
    guildId: GUILD,
    state: "active",
    groupsEnabled: true,
    groupsLocked: false,
    captainsEnabled: true,
    leaderLabel: "Leader",
    channelId: "main",
    createdBy: HOST,
    startTime: new Date("2026-07-04T20:00:00Z").toISOString(),
    durationMinutes: 120,
    groups: [
      group("a", { channelId: "ch-a", memberIds: [L1, L2], captainId: L1 }),
      group("b", { channelId: "ch-b", memberIds: [U3] }),
      group("l", { kind: "leads", channelId: "ch-leads" }),
    ],
    ...over,
  } as unknown as Doc;
  store.set(EV, doc);
  return doc;
}

const manager = Object.create(CommandManager.prototype) as InstanceType<
  typeof CommandManager
>;

/** A fake server in which written overwrites and moves really take effect. */
function makeWorld(
  opts: {
    categoryOverwrites?: Array<{
      id: string;
      type: OverwriteType;
      allow: bigint;
      deny: bigint;
    }>;
    /** Permissions the bot lacks. */
    botLacks?: bigint[];
    /** Roles of KoolBot's admin groups; "fail" when they cannot be read. */
    adminRoles?: string[] | "fail";
  } = {},
) {
  const lacks = new Set<bigint>(opts.botLacks ?? []);
  const memberRoles = new Map<string, string[]>();
  /** People the gateway's permission cache still shows as able to connect
   * (an overwrite change it has not delivered yet). */
  const lagging = new Set<string>();
  const inChannel = new Map<string, string>();
  const channels = new Map<string, ReturnType<typeof voiceChannel>>();
  const puts: Array<{ channel: string; id: string; body: unknown }> = [];
  const deletes: Array<{ channel: string; id: string }> = [];
  const posts: Array<{ body: Record<string, unknown> }> = [];
  const moves: Array<{ user: string; to: string }> = [];
  const gates = { put: null as Promise<void> | null };
  const hooks = {
    put: null as ((channel: string, id: string) => unknown) | null,
    fetchError: new Map<string, unknown>(),
    fetchGate: null as Promise<void> | null,
    ignoreWrites: false,
  };
  let nextId = 0;

  function membersOf(channelId: string): Map<string, unknown> {
    return new Map(
      [...inChannel.entries()]
        .filter(([, c]) => c === channelId)
        .map(([id]) => [
          id,
          { id, displayName: `n-${id}`, user: { bot: false } },
        ]),
    );
  }
  function voiceChannel(id: string, pos: number) {
    const ow = new Map<string, Ow>();
    const ch = {
      id,
      type: ChannelType.GuildVoice,
      guildId: GUILD,
      parentId: CATEGORY,
      rawPosition: pos,
      userLimit: 0,
      isVoiceBased: () => true,
      permissionOverwrites: { cache: ow },
      get members() {
        return membersOf(id);
      },
      permissionsFor: (member: { id: string }) => ({
        has: (bit: bigint): boolean => {
          if (member.id === ADMIN || lagging.has(member.id)) return true;
          const o = ow.get(`${OverwriteType.Member}:${member.id}`);
          return !!o && (o.allow.bitfield & bit) === bit;
        },
      }),
    };
    channels.set(id, ch);
    return ch;
  }
  for (const [i, id] of ["main", "ch-a", "ch-b", "ch-leads"].entries()) {
    voiceChannel(id, i);
  }
  const category = {
    id: CATEGORY,
    type: ChannelType.GuildCategory,
    permissionOverwrites: {
      cache: new Map(
        (opts.categoryOverwrites ?? []).map((o, i) => [
          String(i),
          {
            id: o.id,
            type: o.type,
            allow: { bitfield: o.allow },
            deny: { bitfield: o.deny },
          },
        ]),
      ),
    },
  };

  const guild = {
    id: GUILD,
    ownerId: "owner-1",
    roles: { cache: new Map<string, unknown>() },
    members: {
      me: {
        permissionsIn: () => ({ has: (bit: bigint) => !lacks.has(bit) }),
        permissions: { has: (bit: bigint) => !lacks.has(bit) },
      },
      cache: {
        get: (id: string) => ({
          id,
          permissions: { has: (bit: bigint) => id === ADMIN && !!bit },
          roles: {
            cache: new Map((memberRoles.get(id) ?? []).map((r) => [r, {}])),
          },
        }),
      },
    },
    channels: {
      cache: channels as unknown as Map<string, unknown>,
      fetch: jest.fn(async (id?: string) => {
        if (hooks.fetchGate) await hooks.fetchGate;
        if (id === undefined) {
          return new Map<string, unknown>([[CATEGORY, category], ...channels]);
        }
        if (hooks.fetchError.has(id)) throw hooks.fetchError.get(id);
        if (id === CATEGORY) return category;
        const c = channels.get(id);
        if (!c) throw apiError(10003, "GET");
        return c;
      }),
    },
    voiceStates: {
      cache: {
        get: (id: string) => {
          const c = inChannel.get(id);
          return c ? { channelId: c } : undefined;
        },
      },
    },
  };
  const client = {
    token: "t",
    user: { id: BOT },
    guilds: {
      cache: { get: (id: string) => (id === GUILD ? guild : undefined) },
      fetch: jest.fn(async (id: string) => {
        if (id !== GUILD) throw new Error("unknown guild");
        return guild;
      }),
    },
    rest: {
      get: jest.fn(async (route: string) => {
        const c = inChannel.get(route.split("/").pop() as string);
        if (!c) throw apiError(10065, "GET");
        return { channel_id: c };
      }),
    },
    on: jest.fn(),
    off: jest.fn(),
  };

  const rest = {
    put: jest.fn(
      async (route: string, o: { body: Record<string, string | number> }) => {
        const [, , channel, , id] = route.split("/");
        if (gates.put) await gates.put;
        await hooks.put?.(channel, id);
        puts.push({ channel, id, body: o.body });
        const ch = channels.get(channel);
        if (!ch) throw apiError(10003);
        if (hooks.ignoreWrites) return undefined;
        ch.permissionOverwrites.cache.set(`${o.body.type}:${id}`, {
          id,
          type: o.body.type as OverwriteType,
          allow: { bitfield: BigInt(o.body.allow) },
          deny: { bitfield: BigInt(o.body.deny) },
        });
        return undefined;
      },
    ),
    delete: jest.fn(async (route: string) => {
      const [, , channel, , id] = route.split("/");
      if (gates.put) await gates.put;
      const ch = channels.get(channel);
      if (!ch) throw apiError(10003, "DELETE");
      deletes.push({ channel, id });
      if (hooks.ignoreWrites) return undefined;
      for (const key of [...ch.permissionOverwrites.cache.keys()]) {
        if (key.endsWith(`:${id}`)) ch.permissionOverwrites.cache.delete(key);
      }
      return undefined;
    }),
    post: jest.fn(
      async (_route: string, o: { body: Record<string, unknown> }) => {
        posts.push(o);
        nextId += 1;
        const id = `new-${nextId}`;
        const ch = voiceChannel(id, 50 + nextId);
        const list = (o.body.permission_overwrites ?? []) as Array<{
          id: string;
          type: OverwriteType;
          allow: string;
          deny: string;
        }>;
        for (const w of list) {
          ch.permissionOverwrites.cache.set(`${w.type}:${w.id}`, {
            id: w.id,
            type: w.type,
            allow: { bitfield: BigInt(w.allow) },
            deny: { bitfield: BigInt(w.deny) },
          });
        }
        return { id };
      },
    ),
    patch: jest.fn(async () => undefined),
  };
  const movePatch = jest.fn(
    async (route: string, o: { body: { channel_id: string } }) => {
      const user = route.split("/").pop() as string;
      moves.push({ user, to: o.body.channel_id });
      inChannel.set(user, o.body.channel_id);
      return {};
    },
  );
  setMoverDepsForTests({
    rest: { patch: movePatch } as never,
    call: (async (fn: (s: AbortSignal) => Promise<unknown>) =>
      fn(new AbortController().signal)) as never,
    paceMs: 0,
  });

  const call = <T>(
    fn: (signal: AbortSignal) => Promise<T>,
    name: string,
    retry: boolean,
  ): Promise<T> => cancellableCall(manager, fn, name, retry);
  const gc = new EventGroupChannels(
    client as never,
    {
      getPrefix: async () => "E",
      getGraceMs: async () => 0,
      isEnabled: async () => eventsEnabled,
      getAdminRoleIds: async () => {
        if (opts.adminRoles === "fail") throw new Error("database down");
        return opts.adminRoles ?? [];
      },
    },
    { rest: rest as never, call: call as never, paceMs: 0 },
  );
  const overwritesOf = (channelId = "ch-leads") =>
    [...(channels.get(channelId)?.permissionOverwrites.cache.values() ?? [])]
      .map((o) => ({
        id: o.id,
        type: o.type,
        allow: o.allow.bitfield,
        deny: o.deny.bitfield,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  /** Put the leads channel into the state the rules want for the stored row. */
  const seedRight = (channelId = "ch-leads"): void => {
    const doc = store.get(EV) as unknown as {
      createdBy: string;
      captainsEnabled: boolean;
      groups: Group[];
    };
    const leaderIds = doc.captainsEnabled
      ? doc.groups
          .filter(
            (g) => g.captainId && g.memberIds.includes(g.captainId as string),
          )
          .map((g) => g.captainId as string)
      : [];
    const ch = channels.get(channelId);
    if (!ch) throw new Error("no channel");
    ch.permissionOverwrites.cache.clear();
    for (const o of buildLeadsOverwrites([], {
      everyoneId: GUILD,
      hostId: doc.createdBy,
      botId: BOT,
      leaderIds,
    })) {
      ch.permissionOverwrites.cache.set(`${o.type}:${o.id}`, {
        id: o.id,
        type: o.type,
        allow: { bitfield: o.allow },
        deny: { bitfield: o.deny },
      });
    }
  };
  const row = () => ({ _id: EV });
  return {
    guild,
    client,
    rest,
    gc,
    channels,
    inChannel,
    puts,
    deletes,
    posts,
    moves,
    movePatch,
    gates,
    hooks,
    lacks,
    lagging,
    memberRoles,
    overwritesOf,
    seedRight,
    place: (user: string, channel: string) => inChannel.set(user, channel),
    where: (user: string) => inChannel.get(user) ?? null,
    reconcile: () => gc.reconcile(row(), guild as never),
    sync: (takeRevoked?: () => readonly string[]) =>
      gc.syncLeads(EV, guild as never, { takeRevoked }),
    run: (takeRevoked?: () => readonly string[]) =>
      syncLeadsAccess({
        client: client as never,
        channels: gc,
        guildId: GUILD,
        eventId: EV,
        takeRevoked,
      }),
    stored: () => store.get(EV) as unknown as { groups: Group[] },
  };
}
type World = ReturnType<typeof makeWorld>;

async function settle(): Promise<void> {
  for (let i = 0; i < 60; i++)
    await new Promise((r) => globalThis.setTimeout(r, 0));
}
const allowOf = (w: World, id: string, channel = "ch-leads"): bigint =>
  w.overwritesOf(channel).find((o) => o.id === id)?.allow ?? 0n;
const has = (w: World, id: string, channel = "ch-leads"): boolean =>
  w.overwritesOf(channel).some((o) => o.id === id);
const setCaptain = (key: string, id: string | null): void => {
  const g = store.get(EV)?.groups.find((x) => x.key === key);
  if (g) g.captainId = id;
};

let uninstallCleanup: () => void = () => undefined;
let uninstallSync: () => void = () => undefined;

beforeEach(() => {
  uninstallCleanup();
  uninstallSync();
  store.clear();
  fake.gateFindById = null;
  fake.delayFor = null;
  eventsEnabled = true;
  resetMoveGuardForTests();
  uninstallCleanup = installLeaderCleanup();
});
afterEach(() => {
  uninstallSync();
  uninstallSync = () => undefined;
  setMoverDepsForTests(undefined);
});

// ---------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------

describe("creating the leads channel", () => {
  const bodyOf = (w: World) =>
    w.posts[0].body.permission_overwrites as Array<{
      id: string;
      type: number;
      allow: string;
      deny: string;
    }>;
  const entry = (w: World, id: string) => {
    const e = bodyOf(w).find((x) => x.id === id);
    return e && { allow: BigInt(e.allow), deny: BigInt(e.deny) };
  };

  it("sends @everyone denied Connect, the host, the current leaders and the bot, on top of the category", async () => {
    seed({
      groups: [
        group("a", { channelId: "ch-a", memberIds: [L1, L2], captainId: L1 }),
        group("b", { channelId: "ch-b", memberIds: [U3], captainId: "gone" }),
        group("l", { kind: "leads", channelId: null }),
      ],
    });
    const w = makeWorld({
      categoryOverwrites: [
        {
          id: "verified",
          type: OverwriteType.Role,
          allow: V | C | S,
          deny: 0n,
        },
      ],
    });
    const report = await w.reconcile();
    expect(report.created).toBe(1);
    expect(w.posts).toHaveLength(1);
    const everyone = entry(w, GUILD);
    expect(everyone && everyone.deny & C).toBe(C);
    expect(everyone && everyone.allow & V).toBe(V);
    expect(entry(w, HOST)?.allow).toBe(V | C | S | M);
    expect(entry(w, L1)?.allow).toBe(LEADS_LEADER_PERMISSIONS);
    // "gone" is a stored captainId who is not a member: not a leader.
    expect(entry(w, "gone")).toBeUndefined();
    expect(entry(w, L2)).toBeUndefined();
    expect(entry(w, BOT)?.allow).toBe(V | C | M);
    // The category's role overwrite is copied, minus the allow that would
    // let every holder in past @everyone's deny.
    expect(entry(w, "verified")).toEqual({ allow: V, deny: 0n });
    // The new id was recorded on the leads group.
    expect(w.stored().groups.find((g) => g.key === "l")?.channelId).toBe(
      "new-1",
    );
  });

  it("leaves the role of a KoolBot admin group alone, so the Web UI's admins are never denied", async () => {
    seed({ groups: [group("l", { kind: "leads", channelId: null })] });
    const w = makeWorld({
      adminRoles: ["mods"],
      categoryOverwrites: [
        { id: "mods", type: OverwriteType.Role, allow: V | C | S, deny: 0n },
        { id: "verified", type: OverwriteType.Role, allow: V | C, deny: 0n },
      ],
    });
    await w.reconcile();
    expect(entry(w, "mods")).toEqual({ allow: V | C | S, deny: 0n });
    expect(entry(w, "verified")).toEqual({ allow: V, deny: 0n });
  });

  it("touches no role at all when the admin groups cannot be read", async () => {
    seed({ groups: [group("l", { kind: "leads", channelId: null })] });
    const w = makeWorld({
      adminRoles: "fail",
      categoryOverwrites: [
        { id: "verified", type: OverwriteType.Role, allow: V | C, deny: 0n },
      ],
    });
    await w.reconcile();
    // Nobody is denied on a guess; @everyone is still restricted.
    expect(entry(w, "verified")).toEqual({ allow: V | C, deny: 0n });
    const everyone = entry(w, GUILD);
    expect(everyone && everyone.deny & C).toBe(C);
  });

  it("creates an ordinary group channel without any of that", async () => {
    seed({
      groups: [group("a", { channelId: null, memberIds: [L1], captainId: L1 })],
    });
    const w = makeWorld();
    await w.reconcile();
    const body = w.posts[0].body.permission_overwrites as Array<{ id: string }>;
    expect(body.map((o) => o.id)).toEqual([HOST]);
  });

  it("without Manage Roles it creates the channel unrestricted and says so on the panel until it is restricted", async () => {
    seed({
      groups: [
        group("a", { channelId: "ch-a", memberIds: [L1], captainId: L1 }),
        group("l", { kind: "leads", channelId: null }),
      ],
    });
    const w = makeWorld({ botLacks: [PermissionFlagsBits.ManageRoles] });
    const report = await w.reconcile();
    expect(report.created).toBe(1);
    expect(w.posts[0].body.permission_overwrites).toBeUndefined();
    expect(report.warnings.join("\n")).toMatch(
      /leaders-only channel is created WITHOUT its restriction/,
    );
    const shown = w.gc.getReport(EV)?.warnings.join("\n") ?? "";
    expect(shown).toMatch(/WITHOUT the leaders-only restriction/);
    expect(shown).toMatch(/Manage Roles/);

    // The permission arrives: the next verifying pass restricts the channel
    // that already exists and the standing warning goes away.
    w.lacks.clear();
    const result = await w.sync();
    expect(result.status).toBe("ok");
    const everyone = w.overwritesOf("new-1").find((o) => o.id === GUILD);
    expect(everyone && everyone.deny & C).toBe(C);
    expect(has(w, L1, "new-1")).toBe(true);
    expect(
      (await w.sync()).status === "ok" &&
        (w.gc.getReport(EV)?.warnings.join("\n") ?? ""),
    ).not.toMatch(/WITHOUT the leaders-only restriction/);
  });

  it("names the permissions the bot lacks to grant the access, not only Manage Roles", async () => {
    seed({ groups: [group("l", { kind: "leads", channelId: null })] });
    const w = makeWorld({ botLacks: [S] });
    const report = await w.reconcile();
    expect(w.posts[0].body.permission_overwrites).toBeUndefined();
    expect(report.warnings.join("\n")).toMatch(/lacks Speak/);
  });

  it("falls back to an unrestricted channel when Discord refuses the overwrites, and says it is open", async () => {
    seed({ groups: [group("l", { kind: "leads", channelId: null })] });
    const w = makeWorld();
    w.rest.post.mockImplementationOnce(async () => {
      throw apiError(50013, "POST");
    });
    const report = await w.reconcile();
    expect(report.created).toBe(1);
    expect(w.posts).toHaveLength(1);
    expect(w.posts[0].body.permission_overwrites).toBeUndefined();
    expect(w.gc.getReport(EV)?.warnings.join("\n")).toMatch(
      /WITHOUT the leaders-only restriction.*Discord refused the channel's permissions/,
    );
  });
});

// ---------------------------------------------------------------------
// Leader changes
// ---------------------------------------------------------------------

describe("following leader changes", () => {
  it("grants a new leader with one write and leaves everything else alone", async () => {
    seed();
    const w = makeWorld();
    w.seedRight();
    setCaptain("a", null);
    store
      .get(EV)
      ?.groups.find((g) => g.key === "b")
      ?.memberIds.push(L2);
    // L2 is made the leader of b.
    setCaptain("b", L2);
    const out = await w.sync();
    expect(out.status).toBe("ok");
    expect(w.puts.map((p) => p.id)).toEqual([L2]);
    expect(allowOf(w, L2)).toBe(LEADS_LEADER_PERMISSIONS);
    // L1 stopped being a leader in the same change set: revoked and gone.
    expect(has(w, L1)).toBe(false);
    expect(out.evict).toEqual([L1]);
  });

  it("revokes before it grants when one leader replaces another", async () => {
    seed();
    const w = makeWorld();
    w.seedRight();
    setCaptain("a", L2);
    await w.sync();
    const order = [
      ...w.deletes.map((d) => `delete:${d.id}`),
      ...w.puts.map((p) => `put:${p.id}`),
    ];
    expect(order).toEqual([`delete:${L1}`, `put:${L2}`]);
    // Two overwrite requests in the real order, not a batch.
    const calls = [
      ...w.rest.delete.mock.invocationCallOrder,
      ...w.rest.put.mock.invocationCallOrder,
    ];
    expect(Math.min(...w.rest.delete.mock.invocationCallOrder)).toBeLessThan(
      Math.min(...w.rest.put.mock.invocationCallOrder),
    );
    expect(calls).toHaveLength(2);
  });

  it("moves a removed leader out of the leads channel to their group channel", async () => {
    seed();
    const w = makeWorld();
    w.seedRight();
    w.place(L1, "ch-leads");
    w.place(HOST, "ch-leads");
    setCaptain("a", null);
    await w.run(() => [L1]);
    expect(has(w, L1)).toBe(false);
    expect(w.where(L1)).toBe("ch-a");
    // The host keeps access and stays where they are.
    expect(w.where(HOST)).toBe("ch-leads");
    expect(w.moves).toEqual([{ user: L1, to: "ch-a" }]);
  });

  it("sends a removed leader whose group has no channel to main, and one with no group to main", async () => {
    seed({
      groups: [
        group("a", { channelId: null, memberIds: [L1], captainId: L1 }),
        group("l", { kind: "leads", channelId: "ch-leads" }),
      ],
    });
    const w = makeWorld();
    w.seedRight();
    w.place(L1, "ch-leads");
    w.place(L2, "ch-leads");
    // L2 was a leader of nothing in this row: only the hook knows them.
    setCaptain("a", null);
    await w.run(() => [L1, L2]);
    expect(w.where(L1)).toBe("main");
    expect(w.where(L2)).toBe("main");
  });

  it("does not move an administrator, a current leader or someone who walked away", async () => {
    seed();
    const w = makeWorld();
    w.seedRight();
    w.place(ADMIN, "ch-leads");
    w.place(L1, "ch-leads");
    w.place(STRANGER, "ch-b");
    await w.run(() => [ADMIN, L1, STRANGER]);
    expect(w.moves).toEqual([]);
  });

  it("does not move a holder of a KoolBot admin group's role, and moves nobody while the admin groups are unknown", async () => {
    seed();
    const w = makeWorld({ adminRoles: ["mods"] });
    w.seedRight();
    w.place(STRANGER, "ch-leads");
    w.place(U3, "ch-leads");
    w.memberRoles.set(STRANGER, ["mods"]);
    await w.run(() => [STRANGER, U3]);
    // The admin stays; the other one is moved to their team's channel.
    expect(w.where(STRANGER)).toBe("ch-leads");
    expect(w.where(U3)).toBe("ch-b");

    const unknown = makeWorld({ adminRoles: "fail" });
    unknown.seedRight();
    unknown.place(U3, "ch-leads");
    await unknown.run(() => [U3]);
    expect(unknown.moves).toEqual([]);
  });

  it("does not move anyone out at all when the access change itself failed", async () => {
    seed();
    const w = makeWorld();
    w.seedRight();
    w.place(L1, "ch-leads");
    setCaptain("a", null);
    w.rest.delete.mockImplementationOnce(async () => {
      throw apiError(50013, "DELETE");
    });
    await w.run(() => [L1]);
    expect(w.where(L1)).toBe("ch-leads");
    expect(has(w, L1)).toBe(true);
    expect(
      w.gc
        .getReport(EV)
        ?.failures.map((f) => f.reason)
        .join("\n"),
    ).toMatch(/only partly changed/);
  });

  it("keeps the person for the next pass when the mover is busy, and moves them then", async () => {
    seed();
    const w = makeWorld();
    w.seedRight();
    // Verified once, as the scan would have done.
    await w.sync();
    w.place(L1, "ch-leads");
    // The permission cache has not caught up: only the memory of who lost
    // access (not the cache's "cannot connect") can get them out later.
    w.lagging.add(L1);
    setCaptain("a", null);
    let release: () => void = () => undefined;
    const busy = withEventMoveLock(
      EV,
      () => new Promise<void>((r) => (release = r)),
    );
    await w.run(() => [L1]);
    expect(has(w, L1)).toBe(false);
    expect(w.where(L1)).toBe("ch-leads");
    expect(w.moves).toEqual([]);
    release();
    await busy;
    // Held for a minute by the hold; the scan trigger is quiet until then.
    const event = store.get(EV) as never;
    expect(w.gc.leadsNeedsAttention(event, w.guild as never)).toBe(false);
    jest.useFakeTimers({
      now: Date.now() + 2 * 60_000,
      doNotFake: ["setTimeout", "setImmediate", "nextTick", "queueMicrotask"],
    });
    try {
      expect(w.gc.leadsNeedsAttention(event, w.guild as never)).toBe(true);
    } finally {
      jest.useRealTimers();
    }
    await w.run();
    expect(w.where(L1)).toBe("ch-a");
  });

  it("a pass that fails half way still owes the move to the people it was told about", async () => {
    seed();
    const w = makeWorld();
    w.seedRight();
    await w.sync();
    w.place(L1, "ch-leads");
    w.lagging.add(L1);
    // L1 loses the role and L2 gains it: the delete lands, then Discord
    // rate limits the grant, so the pass fails after taking the access away.
    setCaptain("a", L2);
    w.hooks.put = () => {
      throw rateLimit();
    };
    await w.run(() => [L1]);
    expect(has(w, L1)).toBe(false);
    expect(w.where(L1)).toBe("ch-leads");
    w.hooks.put = null;
    jest.useFakeTimers({
      now: Date.now() + 3 * 60_000,
      doNotFake: ["setTimeout", "setImmediate", "nextTick", "queueMicrotask"],
    });
    try {
      // Nothing is left to write for L1, but they are still owed a move.
      expect(
        w.gc.leadsNeedsAttention(store.get(EV) as never, w.guild as never),
      ).toBe(true);
      await w.run();
    } finally {
      jest.useRealTimers();
    }
    expect(w.where(L1)).toBe("ch-a");
    expect(allowOf(w, L2)).toBe(LEADS_LEADER_PERMISSIONS);
  });

  it("ignores the change it was told about: a leader set and cleared again leaves the channel right", async () => {
    seed();
    const w = makeWorld();
    w.seedRight();
    // The hook says L2 became leader, but by the time the pass reads the row
    // nobody changed: nothing is written for L2.
    await w.run(() => [L2]);
    expect(w.puts).toEqual([]);
    expect(has(w, L2)).toBe(false);
  });
});

describe("with the real leader writer and hook", () => {
  it("adds and removes the overwrite when the host sets and clears a leader", async () => {
    seed({
      groups: [
        group("a", { channelId: "ch-a", memberIds: [L1, L2] }),
        group("l", { kind: "leads", channelId: "ch-leads" }),
      ],
    });
    const w = makeWorld();
    w.seedRight();
    uninstallSync = installLeadsChannelSync((g, e, t) =>
      syncLeadsAccess({
        client: w.client as never,
        channels: w.gc,
        guildId: g,
        eventId: e,
        takeRevoked: t,
      }),
    );
    await setGroupLeader({
      guildId: GUILD,
      eventId: EV,
      groupKey: "a",
      userId: L1,
      admission: 1,
    });
    await settle();
    expect(allowOf(w, L1)).toBe(LEADS_LEADER_PERMISSIONS);

    w.place(L1, "ch-leads");
    await setGroupLeader({
      guildId: GUILD,
      eventId: EV,
      groupKey: "a",
      userId: L2,
      admission: 1,
    });
    await settle();
    expect(has(w, L1)).toBe(false);
    expect(allowOf(w, L2)).toBe(LEADS_LEADER_PERMISSIONS);
    expect(w.where(L1)).toBe("ch-a");

    await setGroupLeader({
      guildId: GUILD,
      eventId: EV,
      groupKey: "a",
      userId: null,
      admission: 1,
    });
    await settle();
    expect(has(w, L2)).toBe(false);
  });

  it("takes the access away when a member data reset clears the leader", async () => {
    seed();
    const w = makeWorld();
    w.seedRight();
    uninstallSync = installLeadsChannelSync((g, e, t) =>
      syncLeadsAccess({
        client: w.client as never,
        channels: w.gc,
        guildId: g,
        eventId: e,
        takeRevoked: t,
      }),
    );
    expect(has(w, L1)).toBe(true);
    await removeLeaderFromEvents(GUILD, L1);
    await settle();
    expect(has(w, L1)).toBe(false);
  });

  it("applies a leader changed while overwrites are being written, with nothing stale left behind", async () => {
    seed({
      groups: [
        group("a", { channelId: "ch-a", memberIds: [L1, L2] }),
        group("b", { channelId: "ch-b", memberIds: [U3] }),
        group("l", { kind: "leads", channelId: "ch-leads" }),
      ],
    });
    const w = makeWorld();
    w.seedRight();
    uninstallSync = installLeadsChannelSync((g, e, t) =>
      syncLeadsAccess({
        client: w.client as never,
        channels: w.gc,
        guildId: g,
        eventId: e,
        takeRevoked: t,
      }),
    );
    let release: () => void = () => undefined;
    w.gates.put = new Promise<void>((r) => (release = r));
    await setGroupLeader({
      guildId: GUILD,
      eventId: EV,
      groupKey: "a",
      userId: L1,
      admission: 1,
    });
    await settle();
    // The first pass is parked on its first write. The leader changes now.
    await setGroupLeader({
      guildId: GUILD,
      eventId: EV,
      groupKey: "a",
      userId: L2,
      admission: 1,
    });
    await setGroupLeader({
      guildId: GUILD,
      eventId: EV,
      groupKey: "b",
      userId: U3,
      admission: 1,
    });
    // Everything the later changes trigger has had every chance to run: only
    // the per-event lock keeps it behind the parked write.
    await settle();
    expect(w.puts).toEqual([]);
    w.gates.put = null;
    release();
    await settle();
    expect(
      w
        .overwritesOf()
        .filter((o) => o.type === OverwriteType.Member)
        .map((o) => o.id)
        .sort(),
    ).toEqual([BOT, HOST, L2, U3].sort());
    expect(has(w, L1)).toBe(false);
    // Exactly what was needed: L1 in, then L1 out and L2 and U3 in. A second
    // pass that planned from the state before the first write landed would
    // have sent L2 and U3 without removing L1.
    expect(w.deletes.map((d) => d.id)).toEqual([L1]);
    expect(w.puts.map((p) => p.id).sort()).toEqual([L1, L2, U3].sort());
  });

  it("coalesces changes that arrive while a pass is queued and keeps every stored from-id", async () => {
    seed({
      groups: [
        group("a", { channelId: "ch-a", memberIds: [L1, L2], captainId: L1 }),
        group("b", { channelId: "ch-b", memberIds: [U3], captainId: U3 }),
        group("l", { kind: "leads", channelId: "ch-leads" }),
      ],
    });
    const taken: Array<readonly string[]> = [];
    let first: () => void = () => undefined;
    let second: () => void = () => undefined;
    let calls = 0;
    uninstallSync = installLeadsChannelSync(async (_g, _e, take) => {
      calls += 1;
      if (calls === 1) {
        taken.push(take());
        await new Promise<void>((r) => (first = r));
        return;
      }
      // The second pass is queued behind the first (it waits for the lock).
      await new Promise<void>((r) => (second = r));
      taken.push(take());
    });
    await setGroupLeader({
      guildId: GUILD,
      eventId: EV,
      groupKey: "a",
      userId: null,
      admission: 1,
    });
    await settle();
    // The first pass has started (its flag is cleared) and is blocked.
    await setGroupLeader({
      guildId: GUILD,
      eventId: EV,
      groupKey: "b",
      userId: null,
      admission: 1,
    });
    await setGroupLeader({
      guildId: GUILD,
      eventId: EV,
      groupKey: "a",
      userId: L2,
      admission: 1,
    });
    await setGroupLeader({
      guildId: GUILD,
      eventId: EV,
      groupKey: "a",
      userId: null,
      admission: 1,
    });
    await settle();
    expect(calls).toBe(2);
    first();
    second();
    await settle();
    expect(taken[0]).toEqual([L1]);
    expect([...taken[1]].sort()).toEqual([L2, U3].sort());
  });

  it("does not drop later changes when a pass fails before it starts", async () => {
    seed();
    let n = 0;
    uninstallSync = installLeadsChannelSync(async () => {
      n += 1;
      if (n === 1) throw new Error("fetch failed");
    });
    await setGroupLeader({
      guildId: GUILD,
      eventId: EV,
      groupKey: "a",
      userId: null,
      admission: 1,
    });
    await settle();
    await setGroupLeader({
      guildId: GUILD,
      eventId: EV,
      groupKey: "a",
      userId: L2,
      admission: 1,
    });
    await settle();
    expect(n).toBe(2);
  });
});

describe("a channel recreated while a leader change is in flight", () => {
  it("writes nothing to the old channel, and the replacement is made from the fresh row", async () => {
    seed({
      groups: [
        group("a", { channelId: "ch-a", memberIds: [L1, L2], captainId: L1 }),
        group("l", { kind: "leads", channelId: "ch-leads" }),
      ],
    });
    const w = makeWorld();
    w.seedRight();
    // Verified once, as an earlier scan would have done.
    expect((await w.sync()).status).toBe("ok");
    setCaptain("a", L2);
    let release: () => void = () => undefined;
    w.gates.put = new Promise<void>((r) => (release = r));
    const inFlight = w.sync();
    await settle();
    // Someone deletes the channel while the first write is parked; a group
    // pass is queued behind the sync (same lock).
    w.channels.delete("ch-leads");
    const recreate = w.reconcile();
    w.gates.put = null;
    release();
    const first = await inFlight;
    expect(first.status).toBe("skipped");
    const report = await recreate;
    expect(report.created).toBe(1);
    const body = w.posts[0].body.permission_overwrites as Array<{ id: string }>;
    expect(body.map((o) => o.id)).toContain(L2);
    expect(body.map((o) => o.id)).not.toContain(L1);
    // The id recorded is the new one, and a pass over it finds nothing to do.
    expect(w.stored().groups.find((g) => g.key === "l")?.channelId).toBe(
      "new-1",
    );
    // A replacement has not been verified: the scan asks for a pass.
    expect(
      w.gc.leadsNeedsAttention(store.get(EV) as never, w.guild as never),
    ).toBe(true);
    w.puts.length = 0;
    expect((await w.sync()).wrote).toBe(0);
    expect(w.puts).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// Fail closed, permissions
// ---------------------------------------------------------------------

describe("failing closed", () => {
  it("writes nothing when the leads channel cannot be read, and says so", async () => {
    seed();
    const w = makeWorld();
    w.seedRight();
    setCaptain("a", L2);
    w.hooks.fetchError.set("ch-leads", new Error("gateway down"));
    const out = await w.sync();
    expect(out.status).toBe("failed");
    expect(w.puts).toEqual([]);
    expect(w.deletes).toEqual([]);
    expect(
      w.gc
        .getReport(EV)
        ?.failures.map((f) => f.reason)
        .join("\n"),
    ).toMatch(/could not be read, so its access was not changed/);
    // A standing problem is not read again on every scan.
    expect(
      w.gc.leadsNeedsAttention(store.get(EV) as never, w.guild as never),
    ).toBe(false);
    // It heals on the next successful pass.
    w.hooks.fetchError.clear();
    await w.sync();
    expect(
      (w.gc.getReport(EV)?.failures ?? []).filter((f) => f.key === "#leads"),
    ).toEqual([]);
  });

  it("writes nothing and moves nobody when the event cannot be read as open", async () => {
    seed({ state: "ended" });
    const w = makeWorld();
    w.seedRight();
    w.place(STRANGER, "ch-leads");
    setCaptain("a", null);
    expect((await w.sync()).status).toBe("skipped");
    await w.run(() => [L1]);
    expect(w.puts).toEqual([]);
    expect(w.moves).toEqual([]);
  });

  it("does not trust a recorded id that is not a voice channel", async () => {
    seed();
    const w = makeWorld();
    w.seedRight();
    (w.channels.get("ch-leads") as { type: ChannelType }).type =
      ChannelType.GuildText;
    setCaptain("a", L2);
    expect((await w.sync()).status).toBe("failed");
    expect(w.puts).toEqual([]);
  });

  it("without Manage Roles on the channel it writes nothing, warns the host and holds off", async () => {
    seed();
    const w = makeWorld({ botLacks: [PermissionFlagsBits.ManageRoles] });
    w.seedRight();
    setCaptain("a", L2);
    const out = await w.sync();
    expect(out.status).toBe("failed");
    expect(w.puts).toEqual([]);
    expect(
      w.gc
        .getReport(EV)
        ?.failures.map((f) => f.reason)
        .join("\n"),
    ).toMatch(/lacks Manage Roles/);
    expect(
      w.gc.leadsNeedsAttention(store.get(EV) as never, w.guild as never),
    ).toBe(false);
  });

  it("with events off it only takes access away, never gives it", async () => {
    seed();
    const w = makeWorld();
    w.seedRight();
    // L1 loses the role and L2 gains it; with events off only the first lands.
    setCaptain("a", L2);
    eventsEnabled = false;
    const out = await w.sync();
    expect(out.status).toBe("ok");
    expect(has(w, L1)).toBe(false);
    expect(has(w, L2)).toBe(false);
    expect(w.puts).toEqual([]);
  });

  it("treats an unreadable events switch as off", async () => {
    seed();
    const w = makeWorld();
    w.seedRight();
    setCaptain("a", L2);
    const gc = new EventGroupChannels(
      w.client as never,
      {
        getPrefix: async () => "E",
        getGraceMs: async () => 0,
        isEnabled: async () => {
          throw new Error("config unreadable");
        },
      },
      {
        rest: w.rest as never,
        paceMs: 0,
        call: ((fn: (s: AbortSignal) => Promise<unknown>) =>
          fn(new AbortController().signal)) as never,
      },
    );
    await gc.syncLeads(EV, w.guild as never);
    expect(has(w, L2)).toBe(false);
    expect(has(w, L1)).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Restart reconcile and the scan trigger
// ---------------------------------------------------------------------

describe("reconcile after a restart", () => {
  it("removes a stale member overwrite and adds a missing one, from what Discord holds", async () => {
    seed();
    const w = makeWorld();
    w.seedRight();
    // Left over from before: an old leader, and the current leader's entry is lost.
    w.channels
      .get("ch-leads")
      ?.permissionOverwrites.cache.set(`${OverwriteType.Member}:${STRANGER}`, {
        id: STRANGER,
        type: OverwriteType.Member,
        allow: { bitfield: V | C | S },
        deny: { bitfield: 0n },
      });
    w.channels
      .get("ch-leads")
      ?.permissionOverwrites.cache.delete(`${OverwriteType.Member}:${L1}`);
    const event = store.get(EV) as never;
    expect(w.gc.leadsNeedsAttention(event, w.guild as never)).toBe(true);
    const out = await w.sync();
    expect(out.status).toBe("ok");
    expect(has(w, STRANGER)).toBe(false);
    expect(allowOf(w, L1)).toBe(LEADS_LEADER_PERMISSIONS);
    // Verified from Discord's own state: the scan is quiet afterwards.
    expect((await w.sync()).wrote).toBe(0);
    expect(w.gc.leadsNeedsAttention(event, w.guild as never)).toBe(false);
  });

  it("asks for a pass on the first scan after a restart even when the cache looks right", async () => {
    seed();
    const w = makeWorld();
    w.seedRight();
    const event = store.get(EV) as never;
    expect(w.gc.leadsNeedsAttention(event, w.guild as never)).toBe(true);
    await w.sync();
    expect(w.gc.leadsNeedsAttention(event, w.guild as never)).toBe(false);
  });

  it("notices an overwrite added by hand and a stranger sitting in the channel", async () => {
    seed();
    const w = makeWorld();
    w.seedRight();
    await w.sync();
    const event = store.get(EV) as never;
    expect(w.gc.leadsNeedsAttention(event, w.guild as never)).toBe(false);
    w.place(STRANGER, "ch-leads");
    expect(w.gc.leadsNeedsAttention(event, w.guild as never)).toBe(true);
    // An administrator in the channel is not a stranger.
    w.inChannel.delete(STRANGER);
    w.place(ADMIN, "ch-leads");
    expect(w.gc.leadsNeedsAttention(event, w.guild as never)).toBe(false);
    w.inChannel.delete(ADMIN);
    w.channels
      .get("ch-leads")
      ?.permissionOverwrites.cache.set(`${OverwriteType.Member}:${STRANGER}`, {
        id: STRANGER,
        type: OverwriteType.Member,
        allow: { bitfield: C },
        deny: { bitfield: 0n },
      });
    expect(w.gc.leadsNeedsAttention(event, w.guild as never)).toBe(true);
  });

  it("moves a stranger out when the scan's pass finds them, via the mover", async () => {
    seed();
    const w = makeWorld();
    w.seedRight();
    await w.sync();
    w.place(U3, "ch-leads");
    await w.run();
    expect(w.where(U3)).toBe("ch-b");
    expect(w.moves).toEqual([{ user: U3, to: "ch-b" }]);
  });

  it("never asks for a pass for an event without a leads channel", () => {
    seed({ groups: [group("a", { channelId: "ch-a" })] });
    const w = makeWorld();
    expect(
      w.gc.leadsNeedsAttention(store.get(EV) as never, w.guild as never),
    ).toBe(false);
  });
});

describe("writing", () => {
  it("does not repeat a write that Discord did not take, and says so", async () => {
    seed();
    const w = makeWorld();
    w.seedRight();
    setCaptain("a", L2);
    w.hooks.ignoreWrites = true;
    expect((await w.sync()).status).toBe("ok");
    const sent = w.puts.length + w.deletes.length;
    expect(sent).toBeGreaterThan(0);
    const second = await w.sync();
    expect(second.status).toBe("failed");
    expect(w.puts.length + w.deletes.length).toBe(sent);
    expect(
      w.gc
        .getReport(EV)
        ?.failures.map((f) => f.reason)
        .join("\n"),
    ).toMatch(/Discord still reports different permissions/);
    expect(
      w.gc.leadsNeedsAttention(store.get(EV) as never, w.guild as never),
    ).toBe(false);
    // A different situation is written again.
    w.hooks.ignoreWrites = false;
    setCaptain("a", null);
    jest.useFakeTimers({
      now: Date.now() + REFUSED_CREATE_BACKOFF_MS + 1000,
      doNotFake: ["setTimeout", "setImmediate", "nextTick", "queueMicrotask"],
    });
    try {
      expect((await w.sync()).status).toBe("ok");
    } finally {
      jest.useRealTimers();
    }
  });

  it("writes the same plan again once the channel was seen right in between (a hand edit undoes it)", async () => {
    seed();
    const w = makeWorld();
    w.seedRight();
    expect((await w.sync()).status).toBe("ok");
    setCaptain("a", null);
    expect((await w.sync()).status).toBe("ok");
    expect(w.deletes.map((d) => d.id)).toEqual([L1]);
    // The scan sees the channel right: that write took effect.
    expect(
      w.gc.leadsNeedsAttention(store.get(EV) as never, w.guild as never),
    ).toBe(false);
    // Later someone gives L1 access again by hand, exactly as it was.
    w.channels
      .get("ch-leads")
      ?.permissionOverwrites.cache.set(`${OverwriteType.Member}:${L1}`, {
        id: L1,
        type: OverwriteType.Member,
        allow: { bitfield: LEADS_LEADER_PERMISSIONS },
        deny: { bitfield: 0n },
      });
    const again = await w.sync();
    // Written again, not mistaken for a write Discord ignored.
    expect(again.status).toBe("ok");
    expect(w.deletes.map((d) => d.id)).toEqual([L1, L1]);
    expect(has(w, L1)).toBe(false);
  });

  it("stops at a rate limit, reports what was not applied and holds off", async () => {
    seed({
      groups: [
        group("a", {
          channelId: "ch-a",
          memberIds: [L1, L2, U3],
          captainId: null,
        }),
        group("l", { kind: "leads", channelId: "ch-leads" }),
      ],
    });
    const w = makeWorld();
    w.seedRight();
    // Three people need access; Discord rate limits the second request.
    const g = store.get(EV)?.groups.find((x) => x.key === "a");
    if (g) g.captainId = L1;
    store
      .get(EV)
      ?.groups.push(
        group("b2", { channelId: "ch-b", memberIds: [L2], captainId: L2 }),
      );
    store
      .get(EV)
      ?.groups.push(
        group("b3", { channelId: "ch-b", memberIds: [U3], captainId: U3 }),
      );
    let n = 0;
    w.hooks.put = () => {
      n += 1;
      if (n === 2) throw rateLimit();
    };
    const out = await w.sync(() => [STRANGER]);
    expect(out.status).toBe("failed");
    expect(w.rest.put).toHaveBeenCalledTimes(2);
    expect(
      w.gc
        .getReport(EV)
        ?.failures.map((f) => f.reason)
        .join("\n"),
    ).toMatch(/only partly changed/);
    expect(
      w.gc.leadsNeedsAttention(store.get(EV) as never, w.guild as never),
    ).toBe(false);
    // The person who was to be moved out is remembered for the next pass.
    w.hooks.put = null;
    jest.useFakeTimers({
      now: Date.now() + 3 * 60_000,
      doNotFake: ["setTimeout", "setImmediate", "nextTick", "queueMicrotask"],
    });
    try {
      expect(
        w.gc.leadsNeedsAttention(store.get(EV) as never, w.guild as never),
      ).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it("paces the writes: one request per overwrite, a pause between them", async () => {
    seed({
      groups: [
        group("a", {
          channelId: "ch-a",
          memberIds: [L1, L2, U3],
          captainId: L1,
        }),
        group("b", {
          channelId: "ch-b",
          memberIds: [STRANGER],
          captainId: STRANGER,
        }),
        group("l", { kind: "leads", channelId: "ch-leads" }),
      ],
    });
    const w = makeWorld();
    w.channels.get("ch-leads")?.permissionOverwrites.cache.clear();
    const paced = new EventGroupChannels(
      w.client as never,
      { getPrefix: async () => "E", getGraceMs: async () => 0 },
      {
        rest: w.rest as never,
        call: ((fn: (s: AbortSignal) => Promise<unknown>) =>
          fn(new AbortController().signal)) as never,
        paceMs: 30,
      },
    );
    const started = Date.now();
    const out = await paced.syncLeads(EV, w.guild as never);
    // @everyone, host, bot, two leaders: five writes, four pauses.
    expect(out.wrote).toBe(5);
    expect(w.rest.put).toHaveBeenCalledTimes(5);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });
});
