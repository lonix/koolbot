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

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// A small in-memory event store that understands exactly the two update
// shapes the module writes, so the tests prove behaviour, not call shapes.
type Group = {
  key: string;
  name: string;
  size: number | null;
  marker: string;
  channelId: string | null;
};
type Row = {
  _id: string;
  guildId: string;
  state: string;
  startTime: Date;
  durationMinutes: number;
  channelId: string | null;
  createdBy: string;
  seriesCancelled?: boolean;
  groupsEnabled: boolean;
  groups: Group[];
};
const store = new Map<string, Row>();
const updateOne = jest.fn(
  async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
    const row = store.get(String(filter._id));
    if (!row) return { matchedCount: 0 };
    const state = filter.state as { $in: string[] } | undefined;
    if (state && !state.$in.includes(row.state)) return { matchedCount: 0 };
    if (filter.seriesCancelled && row.seriesCancelled) {
      return { matchedCount: 0 };
    }
    const elem = (
      filter.groups as { $elemMatch: { key: string; channelId: string | null } }
    ).$elemMatch;
    const group = row.groups.find(
      (g) => g.key === elem.key && g.channelId === elem.channelId,
    );
    if (!group) return { matchedCount: 0 };
    group.channelId = (update.$set as Record<string, string | null>)[
      "groups.$.channelId"
    ];
    return { matchedCount: 1 };
  },
);
const findById = jest.fn((id: string) => ({
  lean: async () => {
    const row = store.get(id);
    return row
      ? {
          ...row,
          startTime: new Date(row.startTime),
          groups: row.groups.map((g) => ({ ...g })),
        }
      : null;
  },
}));
jest.unstable_mockModule("../../src/models/event.js", () => ({
  Event: { findById, updateOne },
}));

const {
  EventGroupChannels,
  buildHostOverwrites,
  groupChannelName,
  REFUSED_CREATE_BACKOFF_MS,
} = await import("../../src/services/event-group-channels.js");

const GUILD = "111111111111111111";
const HOST = "222222222222222222";
const CATEGORY = "333333333333333333";
const OTHER_CATEGORY = "444444444444444444";
const MIN = 60_000;

function apiError(code: number): DiscordAPIError {
  return new DiscordAPIError(
    { code, message: "x" },
    code,
    400,
    "POST",
    "/",
    {},
  );
}

function makeRow(overrides: Partial<Row> = {}): Row {
  return {
    _id: "evt1",
    guildId: GUILD,
    state: "active",
    startTime: new Date("2026-07-04T20:00:00Z"),
    durationMinutes: 120,
    channelId: "main-1",
    createdBy: HOST,
    groupsEnabled: true,
    groups: [
      { key: "g_a", name: "Alpha", size: 5, marker: "🟢", channelId: null },
      { key: "g_b", name: "Bravo", size: null, marker: "", channelId: null },
      { key: "g_c", name: "Charlie", size: 3, marker: "", channelId: null },
    ],
    ...overrides,
  };
}

interface FakeChannel {
  id: string;
  type: ChannelType;
  guildId: string;
  members: { size: number };
  parentId?: string;
  rawPosition?: number;
}

function makeEnv(
  opts: {
    perms?: bigint[] | null;
    categoryOverwrites?: unknown[];
    paceMs?: number;
    /** Foreign voice channels in the event's category (id, raw position). */
    foreign?: Array<{ id: string; rawPosition: number }>;
  } = {},
) {
  const channels = new Map<string, FakeChannel>();
  const fetchErrors = new Map<string, unknown>();
  const cache = new Map<string, unknown>();
  const heldPerms = opts.perms === undefined ? null : opts.perms;
  const category = {
    id: CATEGORY,
    type: ChannelType.GuildCategory,
    permissionOverwrites: {
      cache: new Map(
        (opts.categoryOverwrites ?? []).map((o, i) => [String(i), o]),
      ),
    },
  };
  const otherCategory = {
    ...category,
    id: OTHER_CATEGORY,
    permissionOverwrites: { cache: new Map() },
  };
  // The event's main channel and the categories, read by id (not group channels).
  const fixed = new Map<string, unknown>([
    [
      "main-1",
      {
        id: "main-1",
        type: ChannelType.GuildVoice,
        guildId: GUILD,
        parentId: CATEGORY,
        members: { size: 0 },
        rawPosition: 0,
      },
    ],
    [CATEGORY, category],
    [OTHER_CATEGORY, otherCategory],
    ...(opts.foreign ?? []).map(
      (f) =>
        [
          f.id,
          {
            id: f.id,
            type: ChannelType.GuildVoice,
            guildId: GUILD,
            parentId: CATEGORY,
            members: { size: 0 },
            rawPosition: f.rawPosition,
          },
        ] as [string, unknown],
    ),
  ]);
  // Discord appends a new channel to the bottom of its category.
  let nextPosition = 100;
  const guild = {
    id: GUILD,
    members: {
      me:
        heldPerms === null
          ? null
          : {
              permissionsIn: () => ({
                has: (bit: bigint) => heldPerms.includes(bit),
              }),
            },
    },
    channels: {
      cache,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      fetch: jest.fn(async (id?: string, _o?: unknown) => {
        if (id === undefined) {
          // The whole server, read fresh (what the ordering step uses).
          if (fetchErrors.has("*")) throw fetchErrors.get("*");
          return new Map<string, unknown>([...fixed, ...channels]);
        }
        if (fetchErrors.has(id)) throw fetchErrors.get(id);
        if (fixed.has(id)) return fixed.get(id);
        const channel = channels.get(id);
        if (!channel) throw apiError(10003);
        return channel;
      }),
    },
  };
  let seq = 0;
  const rest = {
    post: jest.fn(
      async (_route: string, _o: { body: Record<string, unknown> }) => {
        seq += 1;
        nextPosition += 1;
        const id = `chan-${seq}`;
        channels.set(id, {
          id,
          type: ChannelType.GuildVoice,
          guildId: GUILD,
          members: { size: 0 },
          parentId: String(_o.body.parent_id),
          rawPosition: nextPosition,
        });
        return { id };
      },
    ),
    patch: jest.fn(
      async (
        _route: string,
        o: { body: Array<{ id: string; position: number }> },
      ) => {
        for (const move of o.body) {
          const target = (channels.get(move.id) ?? fixed.get(move.id)) as
            FakeChannel | undefined;
          if (!target) throw apiError(10003);
          target.rawPosition = move.position;
        }
        return undefined;
      },
    ),
    delete: jest.fn(async (route: string) => {
      const id = route.split("/").pop() as string;
      if (!channels.delete(id)) throw apiError(10003);
    }),
  };
  const call = jest.fn(async (fn: (s: AbortSignal) => Promise<unknown>) =>
    fn(new AbortController().signal),
  );
  const service = new EventGroupChannels(
    {} as never,
    {
      getPrefix: async () => "📅",
      getGraceMs: async () => 15 * MIN,
    },
    { rest: rest as never, call: call as never, paceMs: opts.paceMs ?? 0 },
  );
  return {
    service,
    guild: guild as never,
    rest,
    call,
    channels,
    fetchErrors,
    fixed,
    cache,
    fetch: guild.channels.fetch,
  };
}

const ALL_PERMS = [
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.MoveMembers,
];

beforeEach(() => {
  store.clear();
  updateOne.mockClear();
  findById.mockClear();
});

describe("groupChannelName", () => {
  it("joins prefix, marker and name and caps at 100 characters", () => {
    expect(groupChannelName("📅", { name: "Alpha", marker: "🟢" })).toBe(
      "📅 🟢 Alpha",
    );
    expect(groupChannelName("📅", { name: "Alpha", marker: "" })).toBe(
      "📅 Alpha",
    );
    const long = groupChannelName("📅", {
      name: "x".repeat(60),
      marker: "🟢".repeat(4),
    });
    expect(Array.from(long).length).toBeLessThanOrEqual(100);
  });
});

describe("buildHostOverwrites", () => {
  it("copies the category's overwrites and adds the host without dropping their other bits", () => {
    const everyone = {
      id: GUILD,
      type: OverwriteType.Role,
      allow: { bitfield: 0n },
      deny: { bitfield: PermissionFlagsBits.ViewChannel },
    };
    const host = {
      id: HOST,
      type: OverwriteType.Member,
      allow: { bitfield: PermissionFlagsBits.Speak },
      deny: { bitfield: PermissionFlagsBits.Connect },
    };
    const category = {
      permissionOverwrites: {
        cache: new Map([
          ["a", everyone],
          ["b", host],
        ]),
      },
    };
    const out = buildHostOverwrites(category as never, HOST);
    expect(out).toHaveLength(2);
    expect(out.find((o) => o.id === GUILD)?.deny).toBe(
      PermissionFlagsBits.ViewChannel,
    );
    const mine = out.find((o) => o.id === HOST);
    expect(mine?.type).toBe(OverwriteType.Member);
    expect(mine?.allow).toBe(
      PermissionFlagsBits.Speak |
        PermissionFlagsBits.ViewChannel |
        PermissionFlagsBits.Connect |
        PermissionFlagsBits.MoveMembers,
    );
    expect((mine?.deny ?? 1n) & PermissionFlagsBits.Connect).toBe(0n);
  });
});

describe("EventGroupChannels.reconcile", () => {
  it("creates one channel per group in order with the size as user limit, and records each id", async () => {
    store.set("evt1", makeRow());
    const { service, guild, rest } = makeEnv({ perms: ALL_PERMS });
    const report = await service.reconcile({ _id: "evt1" }, guild);

    expect(report.created).toBe(3);
    expect(report.failures).toEqual([]);
    const bodies = rest.post.mock.calls.map((c) => c[1].body);
    expect(bodies.map((b) => b.name)).toEqual([
      "📅 🟢 Alpha",
      "📅 Bravo",
      "📅 Charlie",
    ]);
    expect(bodies.map((b) => b.user_limit)).toEqual([5, 0, 3]);
    expect(bodies.every((b) => b.parent_id === CATEGORY)).toBe(true);
    expect(bodies.every((b) => b.type === ChannelType.GuildVoice)).toBe(true);
    expect(store.get("evt1")?.groups.map((g) => g.channelId)).toEqual([
      "chan-1",
      "chan-2",
      "chan-3",
    ]);
  });

  it("gives the host View, Connect and Move Members as a Member overwrite on every group channel", async () => {
    store.set("evt1", makeRow());
    const { service, guild, rest } = makeEnv({
      perms: ALL_PERMS,
      categoryOverwrites: [
        {
          id: GUILD,
          type: OverwriteType.Role,
          allow: { bitfield: 0n },
          deny: { bitfield: PermissionFlagsBits.ViewChannel },
        },
      ],
    });
    await service.reconcile({ _id: "evt1" }, guild);
    for (const call of rest.post.mock.calls) {
      const overwrites = call[1].body.permission_overwrites as Array<{
        id: string;
        type: number;
        allow: string;
        deny: string;
      }>;
      // The private category stays private.
      expect(overwrites.find((o) => o.id === GUILD)?.deny).toBe(
        String(PermissionFlagsBits.ViewChannel),
      );
      const host = overwrites.find((o) => o.id === HOST);
      expect(host?.type).toBe(OverwriteType.Member);
      expect(BigInt(host?.allow ?? 0)).toBe(
        PermissionFlagsBits.ViewChannel |
          PermissionFlagsBits.Connect |
          PermissionFlagsBits.MoveMembers,
      );
    }
  });

  it("does nothing for an event without groups, without its main channel, or already over", async () => {
    for (const row of [
      makeRow({ groupsEnabled: false }),
      makeRow({ groups: [] }),
      makeRow({ channelId: null }),
      makeRow({ state: "ended" }),
      makeRow({ state: "cancelled" }),
      makeRow({ seriesCancelled: true }),
    ]) {
      store.set("evt1", row);
      const { service, guild, rest } = makeEnv({ perms: ALL_PERMS });
      await service.reconcile({ _id: "evt1" }, guild);
      expect(rest.post).not.toHaveBeenCalled();
    }
  });

  it("skips the groups with a warning when the bot lacks Manage Channels", async () => {
    store.set("evt1", makeRow());
    const { service, guild, rest } = makeEnv({
      perms: [PermissionFlagsBits.ManageRoles, PermissionFlagsBits.MoveMembers],
    });
    const report = await service.reconcile({ _id: "evt1" }, guild);
    expect(rest.post).not.toHaveBeenCalled();
    expect(report.created).toBe(0);
    expect(report.warnings.join(" ")).toContain("Manage Channels");
    expect(service.getReport("evt1")?.warnings).toEqual(report.warnings);
  });

  it("creates the channels without the host's access, and warns, when Manage Roles or Move Members is missing", async () => {
    store.set("evt1", makeRow());
    const { service, guild, rest } = makeEnv({
      perms: [PermissionFlagsBits.ManageChannels],
    });
    const report = await service.reconcile({ _id: "evt1" }, guild);
    expect(report.created).toBe(3);
    for (const call of rest.post.mock.calls) {
      expect(call[1].body).not.toHaveProperty("permission_overwrites");
    }
    const shown = service.getReport("evt1")?.warnings ?? [];
    expect(shown.join(" ")).toContain("Manage Roles or Move Members");
    expect(shown.filter((w) => w.startsWith("Alpha:"))).toHaveLength(1);
  });

  it("retries a create without overwrites when Discord refuses them (50013)", async () => {
    store.set("evt1", makeRow({ groups: [makeRow().groups[0]] }));
    const env = makeEnv({ perms: ALL_PERMS });
    const original = env.rest.post.getMockImplementation() as (
      ...a: never[]
    ) => Promise<{ id: string }>;
    env.rest.post.mockImplementationOnce(async () => {
      throw apiError(50013);
    });
    env.rest.post.mockImplementation(original as never);
    const report = await env.service.reconcile({ _id: "evt1" }, env.guild);
    expect(report.created).toBe(1);
    expect(env.rest.post).toHaveBeenCalledTimes(2);
    expect(env.rest.post.mock.calls[0][1].body).toHaveProperty(
      "permission_overwrites",
    );
    expect(env.rest.post.mock.calls[1][1].body).not.toHaveProperty(
      "permission_overwrites",
    );
    expect(env.service.getReport("evt1")?.warnings.join(" ")).toContain(
      "refused",
    );
  });

  it("keeps a channel's host-access warning across a later successful retry, until that channel is replaced", async () => {
    store.set("evt1", makeRow({ groups: makeRow().groups.slice(0, 2) }));
    const env = makeEnv({ perms: ALL_PERMS });
    const original = env.rest.post.getMockImplementation() as never;
    // Alpha: created through the 50013 fallback. Bravo: refused.
    env.rest.post
      .mockImplementationOnce(async () => {
        throw apiError(50013);
      })
      .mockImplementationOnce(original)
      .mockImplementationOnce(async () => {
        throw apiError(30013);
      });
    await env.service.reconcile({ _id: "evt1" }, env.guild);
    expect(
      env.service
        .getReport("evt1")
        ?.warnings.filter((w) => w.startsWith("Alpha:")),
    ).toHaveLength(1);

    // Later retry: Bravo is created, with the host's access this time.
    env.rest.post.mockImplementation(original);
    const spy = jest
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + 10 * 60_000);
    const retry = await env.service.reconcile({ _id: "evt1" }, env.guild);
    spy.mockRestore();
    expect(retry.created).toBe(1);
    // Alpha still lacks the host's access, so the host panel still says so.
    const shown = env.service.getReport("evt1")?.warnings ?? [];
    expect(shown.filter((w) => w.startsWith("Alpha:"))).toHaveLength(1);
    expect(shown.some((w) => w.startsWith("Bravo:"))).toBe(false);

    // Alpha's channel is deleted in Discord: it is created again, with access,
    // and the warning goes.
    const alphaId = store.get("evt1")?.groups[0].channelId as string;
    env.channels.delete(alphaId);
    await env.service.reconcile({ _id: "evt1" }, env.guild);
    expect(
      (env.service.getReport("evt1")?.warnings ?? []).some((w) =>
        w.startsWith("Alpha:"),
      ),
    ).toBe(false);
  });

  it("creates in the category the main channel is in now, not the current default (#1190)", async () => {
    store.set("evt1", makeRow({ groups: [makeRow().groups[0]] }));
    const env = makeEnv({ perms: ALL_PERMS });
    (env.fixed.get("main-1") as { parentId: string }).parentId = OTHER_CATEGORY;
    await env.service.reconcile({ _id: "evt1" }, env.guild);
    expect(env.rest.post.mock.calls[0][1].body.parent_id).toBe(OTHER_CATEGORY);
  });

  it.each([
    [
      "the main channel cannot be read",
      (e: ReturnType<typeof makeEnv>) =>
        e.fetchErrors.set("main-1", new Error("socket hang up")),
    ],
    [
      "the main channel is gone",
      (e: ReturnType<typeof makeEnv>) => e.fixed.delete("main-1"),
    ],
    [
      "the main channel has no category",
      (e: ReturnType<typeof makeEnv>) =>
        ((e.fixed.get("main-1") as { parentId: string | null }).parentId =
          null),
    ],
    [
      "its category cannot be read",
      (e: ReturnType<typeof makeEnv>) =>
        e.fetchErrors.set(CATEGORY, new Error("socket hang up")),
    ],
    [
      "its parent is not a category",
      (e: ReturnType<typeof makeEnv>) =>
        ((e.fixed.get(CATEGORY) as { type: ChannelType }).type =
          ChannelType.GuildText),
    ],
  ])(
    "creates nothing, and says so, when %s (fails closed)",
    async (_n, break_) => {
      store.set("evt1", makeRow());
      const env = makeEnv({ perms: ALL_PERMS });
      break_(env);
      const report = await env.service.reconcile({ _id: "evt1" }, env.guild);
      expect(env.rest.post).not.toHaveBeenCalled();
      expect(report.created).toBe(0);
      expect(report.warnings).toHaveLength(1);
      expect(report.failures).toHaveLength(3);
    },
  );

  it("never aborts the batch: one refused group is listed, the others are created", async () => {
    store.set("evt1", makeRow());
    const env = makeEnv({ perms: ALL_PERMS });
    const original = env.rest.post.getMockImplementation();
    env.rest.post.mockImplementationOnce(original as never);
    env.rest.post.mockImplementationOnce(async () => {
      throw apiError(30013); // category full
    });
    env.rest.post.mockImplementation(original as never);
    const report = await env.service.reconcile({ _id: "evt1" }, env.guild);
    expect(report.created).toBe(2);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0].key).toBe("g_b");
    expect(store.get("evt1")?.groups.map((g) => g.channelId)).toEqual([
      "chan-1",
      null,
      "chan-2",
    ]);
  });

  it("stops creating on a rate limit and lists the rest as not attempted", async () => {
    store.set("evt1", makeRow());
    const env = makeEnv({ perms: ALL_PERMS });
    env.rest.post.mockImplementationOnce(async () => {
      throw new RateLimitError({
        timeToReset: 60_000,
        limit: 1,
        method: "POST",
        hash: "h",
        url: "/",
        route: "/",
        majorParameter: "",
        global: false,
        retryAfter: 60_000,
        sublimitTimeout: 0,
      } as never);
    });
    const report = await env.service.reconcile({ _id: "evt1" }, env.guild);
    expect(report.created).toBe(0);
    expect(env.rest.post).toHaveBeenCalledTimes(1);
    expect(report.failures.map((f) => f.key)).toEqual(["g_a", "g_b", "g_c"]);
    expect(report.failures[1].reason).toContain("rate limiting");
  });

  it("does not post again on the next pass after Discord refused a create (a full category), and says why", async () => {
    store.set("evt1", makeRow({ groups: [makeRow().groups[0]] }));
    const env = makeEnv({ perms: ALL_PERMS });
    env.rest.post.mockImplementation(async () => {
      throw apiError(30013);
    });
    const first = await env.service.reconcile({ _id: "evt1" }, env.guild);
    const second = await env.service.reconcile({ _id: "evt1" }, env.guild);
    const third = await env.service.reconcile({ _id: "evt1" }, env.guild);
    expect(env.rest.post).toHaveBeenCalledTimes(1);
    expect(first.failures).toHaveLength(1);
    expect(second.failures).toEqual(third.failures);
    expect(second.failures[0].reason).toContain("Tried again later");
  });

  it("tries a refused create again once its back-off has passed", async () => {
    store.set("evt1", makeRow({ groups: [makeRow().groups[0]] }));
    const env = makeEnv({ perms: ALL_PERMS });
    const original = env.rest.post.getMockImplementation();
    env.rest.post.mockImplementationOnce(async () => {
      throw apiError(30013);
    });
    await env.service.reconcile({ _id: "evt1" }, env.guild);
    const spy = jest
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + REFUSED_CREATE_BACKOFF_MS + 1000);
    env.rest.post.mockImplementation(original as never);
    const report = await env.service.reconcile({ _id: "evt1" }, env.guild);
    spy.mockRestore();
    expect(report.created).toBe(1);
  });

  it("does not repeat a create whose outcome is unknown (timeout) until the back-off ends", async () => {
    store.set("evt1", makeRow({ groups: [makeRow().groups[0]] }));
    const env = makeEnv({ perms: ALL_PERMS });
    env.rest.post.mockImplementationOnce(async () => {
      throw new Error("Discord API timeout after 30000ms");
    });
    const first = await env.service.reconcile({ _id: "evt1" }, env.guild);
    expect(first.failures[0].reason).toContain("unknown");
    const second = await env.service.reconcile({ _id: "evt1" }, env.guild);
    expect(env.rest.post).toHaveBeenCalledTimes(1);
    expect(second.failures[0].reason).toContain("may or may not");
    expect(store.get("evt1")?.groups[0].channelId).toBeNull();
  });

  it("removes the channel it just made when the event was cancelled meanwhile (record does not match)", async () => {
    store.set("evt1", makeRow({ groups: [makeRow().groups[0]] }));
    const env = makeEnv({ perms: ALL_PERMS });
    const original = env.rest.post.getMockImplementation() as (
      ...a: never[]
    ) => Promise<{ id: string }>;
    env.rest.post.mockImplementation((async (...a: never[]) => {
      const made = await original(...a);
      (store.get("evt1") as Row).state = "cancelled"; // cancel lands mid-create
      return made;
    }) as never);
    const report = await env.service.reconcile({ _id: "evt1" }, env.guild);
    expect(report.created).toBe(0);
    expect(report.failures[0].reason).toContain("changed");
    expect(env.rest.delete).toHaveBeenCalledWith(
      "/channels/chan-1",
      expect.anything(),
    );
    expect(env.channels.size).toBe(0);
    expect(store.get("evt1")?.groups[0].channelId).toBeNull();
  });

  it("removes the channel it just made when recording it throws", async () => {
    store.set("evt1", makeRow({ groups: [makeRow().groups[0]] }));
    const env = makeEnv({ perms: ALL_PERMS });
    updateOne.mockImplementationOnce(async () => {
      throw new Error("db down");
    });
    const report = await env.service.reconcile({ _id: "evt1" }, env.guild);
    expect(report.created).toBe(0);
    expect(env.channels.size).toBe(0);
  });

  it("never creates a duplicate when two passes run at once (per-event lock across create and record)", async () => {
    store.set("evt1", makeRow());
    const env = makeEnv({ perms: ALL_PERMS });
    await Promise.all([
      env.service.reconcile({ _id: "evt1" }, env.guild),
      env.service.reconcile({ _id: "evt1" }, env.guild),
    ]);
    expect(env.rest.post).toHaveBeenCalledTimes(3);
    expect(env.channels.size).toBe(3);
  });

  it("leaves a group whose recorded channel is in the cache alone, with no Discord read", async () => {
    store.set(
      "evt1",
      makeRow({
        groups: [{ ...makeRow().groups[0], channelId: "chan-x" }],
      }),
    );
    const env = makeEnv({ perms: ALL_PERMS });
    env.cache.set("chan-x", {});
    await env.service.reconcile({ _id: "evt1" }, env.guild);
    expect(env.rest.post).not.toHaveBeenCalled();
    expect(env.fetch).not.toHaveBeenCalled();
  });

  it("creates a group's channel again after a restart when the recorded one is confirmed gone (10003)", async () => {
    store.set(
      "evt1",
      makeRow({
        groups: [{ ...makeRow().groups[0], channelId: "chan-old" }],
      }),
    );
    const env = makeEnv({ perms: ALL_PERMS });
    const report = await env.service.reconcile({ _id: "evt1" }, env.guild);
    expect(env.fetch).toHaveBeenCalledWith("chan-old", { force: true });
    expect(report.created).toBe(1);
    expect(store.get("evt1")?.groups[0].channelId).toBe("chan-1");
  });

  it("does not create over a recorded channel it could not read (not a 10003)", async () => {
    store.set(
      "evt1",
      makeRow({
        groups: [{ ...makeRow().groups[0], channelId: "chan-old" }],
      }),
    );
    const env = makeEnv({ perms: ALL_PERMS });
    env.fetchErrors.set("chan-old", new Error("socket hang up"));
    const report = await env.service.reconcile({ _id: "evt1" }, env.guild);
    expect(env.rest.post).not.toHaveBeenCalled();
    expect(report.failures).toHaveLength(1);
    expect(store.get("evt1")?.groups[0].channelId).toBe("chan-old");
  });
});

describe("EventGroupChannels.cleanup", () => {
  function recordedRow(overrides: Partial<Row> = {}): Row {
    const row = makeRow(overrides);
    row.groups.forEach((g, i) => (g.channelId = `chan-${i + 1}`));
    return row;
  }
  function seed(
    env: ReturnType<typeof makeEnv>,
    occupied: string[] = [],
  ): void {
    for (const id of ["chan-1", "chan-2", "chan-3"]) {
      env.channels.set(id, {
        id,
        type: ChannelType.GuildVoice,
        guildId: GUILD,
        members: { size: occupied.includes(id) ? 2 : 0 },
      });
    }
  }
  const NOW_AFTER_GRACE = new Date("2026-07-04T22:16:00Z"); // end 22:00 + 15 min grace
  const NOW_IN_GRACE = new Date("2026-07-04T22:10:00Z");

  it("removes the empty group channels of a cancelled event at once and keeps the occupied one for the next scan", async () => {
    store.set("evt1", recordedRow({ state: "cancelled" }));
    const env = makeEnv({ perms: ALL_PERMS });
    seed(env, ["chan-2"]);
    const report = await env.service.cleanup(
      { _id: "evt1" },
      env.guild,
      NOW_IN_GRACE,
    );
    expect(report.removed).toBe(2);
    expect(report.occupied).toBe(1);
    expect(store.get("evt1")?.groups.map((g) => g.channelId)).toEqual([
      null,
      "chan-2",
      null,
    ]);
    expect(env.channels.has("chan-2")).toBe(true);

    // The member leaves; the next scan finishes the job.
    (env.channels.get("chan-2") as FakeChannel).members.size = 0;
    const again = await env.service.cleanup(
      { _id: "evt1" },
      env.guild,
      NOW_IN_GRACE,
    );
    expect(again.removed).toBe(1);
    expect(store.get("evt1")?.groups.every((g) => g.channelId === null)).toBe(
      true,
    );
    expect(env.channels.size).toBe(0);
  });

  it("waits for the grace period after a scheduled end, like the main channel", async () => {
    store.set("evt1", recordedRow({ state: "ended" }));
    const env = makeEnv({ perms: ALL_PERMS });
    seed(env);
    await env.service.cleanup({ _id: "evt1" }, env.guild, NOW_IN_GRACE);
    expect(env.rest.delete).not.toHaveBeenCalled();
    const report = await env.service.cleanup(
      { _id: "evt1" },
      env.guild,
      NOW_AFTER_GRACE,
    );
    expect(report.removed).toBe(3);
  });

  it("does nothing for an event that is still open, whatever the caller believes", async () => {
    store.set("evt1", recordedRow({ state: "active" }));
    const env = makeEnv({ perms: ALL_PERMS });
    seed(env);
    await env.service.cleanup({ _id: "evt1" }, env.guild, NOW_AFTER_GRACE);
    expect(env.rest.delete).not.toHaveBeenCalled();
    expect(env.fetch).not.toHaveBeenCalled();
  });

  it("reads each channel from Discord with force before deleting it", async () => {
    store.set("evt1", recordedRow({ state: "cancelled" }));
    const env = makeEnv({ perms: ALL_PERMS });
    seed(env);
    await env.service.cleanup({ _id: "evt1" }, env.guild, NOW_AFTER_GRACE);
    for (const id of ["chan-1", "chan-2", "chan-3"]) {
      expect(env.fetch).toHaveBeenCalledWith(id, { force: true });
    }
  });

  it("fails closed: a channel it cannot read is neither deleted nor forgotten", async () => {
    store.set("evt1", recordedRow({ state: "cancelled" }));
    const env = makeEnv({ perms: ALL_PERMS });
    seed(env);
    env.fetchErrors.set("chan-1", new Error("socket hang up"));
    const report = await env.service.cleanup(
      { _id: "evt1" },
      env.guild,
      NOW_AFTER_GRACE,
    );
    expect(report.failures.map((f) => f.key)).toEqual(["g_a"]);
    expect(env.channels.has("chan-1")).toBe(true);
    expect(store.get("evt1")?.groups[0].channelId).toBe("chan-1");
    // The others were still handled.
    expect(report.removed).toBe(2);
  });

  it("forgets a channel Discord confirms is gone (10003) without a delete call", async () => {
    store.set("evt1", recordedRow({ state: "cancelled" }));
    const env = makeEnv({ perms: ALL_PERMS });
    seed(env);
    env.channels.delete("chan-3");
    await env.service.cleanup({ _id: "evt1" }, env.guild, NOW_AFTER_GRACE);
    expect(env.rest.delete).not.toHaveBeenCalledWith(
      "/channels/chan-3",
      expect.anything(),
    );
    expect(store.get("evt1")?.groups[2].channelId).toBeNull();
  });

  it("never deletes a recorded id that is not a voice channel of this server", async () => {
    store.set("evt1", recordedRow({ state: "cancelled" }));
    const env = makeEnv({ perms: ALL_PERMS });
    seed(env);
    (env.channels.get("chan-1") as FakeChannel).type = ChannelType.GuildText;
    (env.channels.get("chan-2") as FakeChannel).guildId = "other-guild";
    await env.service.cleanup({ _id: "evt1" }, env.guild, NOW_AFTER_GRACE);
    expect(env.channels.has("chan-1")).toBe(true);
    expect(env.channels.has("chan-2")).toBe(true);
    expect(env.channels.has("chan-3")).toBe(false);
  });

  it("keeps the id when the delete fails, so the next scan reads it again", async () => {
    store.set(
      "evt1",
      recordedRow({ state: "cancelled", groups: [recordedRow().groups[0]] }),
    );
    const env = makeEnv({ perms: ALL_PERMS });
    seed(env);
    env.rest.delete.mockImplementationOnce(async () => {
      throw new Error("Discord API timeout after 30000ms");
    });
    const report = await env.service.cleanup(
      { _id: "evt1" },
      env.guild,
      NOW_AFTER_GRACE,
    );
    expect(report.removed).toBe(0);
    expect(report.failures).toHaveLength(1);
    expect(store.get("evt1")?.groups[0].channelId).toBe("chan-1");
  });

  it("does not delete a channel someone joined after it was read, keeps its record and counts it as occupied", async () => {
    store.set("evt1", recordedRow({ state: "cancelled" }));
    const env = makeEnv({ perms: ALL_PERMS });
    seed(env);
    // The read (fetch) saw chan-2 empty; the live voice state says otherwise.
    env.cache.set("chan-2", {
      type: ChannelType.GuildVoice,
      members: { size: 1 },
    });
    const report = await env.service.cleanup(
      { _id: "evt1" },
      env.guild,
      NOW_AFTER_GRACE,
    );
    expect(report.occupied).toBe(1);
    expect(report.removed).toBe(2);
    expect(env.rest.delete).not.toHaveBeenCalledWith(
      "/channels/chan-2",
      expect.anything(),
    );
    expect(env.channels.has("chan-2")).toBe(true);
    expect(store.get("evt1")?.groups[1].channelId).toBe("chan-2");
  });

  it("checks occupancy again on a timeout retry of the same delete", async () => {
    store.set(
      "evt1",
      recordedRow({ state: "cancelled", groups: [recordedRow().groups[0]] }),
    );
    const env = makeEnv({ perms: ALL_PERMS });
    seed(env);
    // First attempt times out; before the retry a member joins.
    let attempts = 0;
    env.call.mockImplementation((async (
      fn: (s: AbortSignal) => Promise<unknown>,
    ) => {
      for (;;) {
        attempts += 1;
        try {
          return await fn(new AbortController().signal);
        } catch (error) {
          if (attempts > 1 || !/timeout/.test(String(error))) throw error;
        }
      }
    }) as never);
    env.rest.delete.mockImplementationOnce(async () => {
      env.cache.set("chan-1", {
        type: ChannelType.GuildVoice,
        members: { size: 1 },
      });
      throw new Error("Discord API timeout after 30000ms");
    });
    const report = await env.service.cleanup(
      { _id: "evt1" },
      env.guild,
      NOW_AFTER_GRACE,
    );
    expect(env.rest.delete).toHaveBeenCalledTimes(1);
    expect(report.occupied).toBe(1);
    expect(report.removed).toBe(0);
    expect(store.get("evt1")?.groups[0].channelId).toBe("chan-1");
  });

  it("waits out the pacing before it reads the next channel, so the check and the delete are not a pause apart", async () => {
    store.set("evt1", recordedRow({ state: "cancelled" }));
    const env = makeEnv({ perms: ALL_PERMS, paceMs: 30 });
    seed(env);
    const times: Record<string, number> = {};
    env.rest.delete.mockImplementation(async (route: string) => {
      const id = route.split("/").pop() as string;
      times[`delete-${id}`] = Date.now();
      env.channels.delete(id);
    });
    const realFetch = env.fetch.getMockImplementation() as (
      id: string,
      o?: unknown,
    ) => Promise<unknown>;
    env.fetch.mockImplementation(async (id: string, o?: unknown) => {
      times[`fetch-${id}`] ??= Date.now();
      return realFetch(id, o);
    });
    await env.service.cleanup({ _id: "evt1" }, env.guild, NOW_AFTER_GRACE);
    expect(
      times["fetch-chan-2"] - times["delete-chan-1"],
    ).toBeGreaterThanOrEqual(25);
    expect(
      times["fetch-chan-3"] - times["delete-chan-2"],
    ).toBeGreaterThanOrEqual(25);
  });

  it("stores the cleanup report, so a failed delete shows instead of an old creation report", async () => {
    store.set("evt1", makeRow());
    const env = makeEnv({ perms: ALL_PERMS });
    await env.service.reconcile({ _id: "evt1" }, env.guild);
    expect(env.service.getReport("evt1")?.created).toBe(3);
    (store.get("evt1") as Row).state = "cancelled";
    env.fetchErrors.set("chan-1", new Error("socket hang up"));
    await env.service.cleanup({ _id: "evt1" }, env.guild, NOW_AFTER_GRACE);
    const shown = env.service.getReport("evt1");
    expect(shown?.created).toBe(0);
    expect(shown?.failures.map((f) => f.key)).toEqual(["g_a"]);
    // Once everything is gone the report is dropped.
    env.fetchErrors.clear();
    await env.service.cleanup({ _id: "evt1" }, env.guild, NOW_AFTER_GRACE);
    expect(env.service.getReport("evt1")).toBeNull();
  });

  it("keeps a notice added for an event across the group passes, and drops it when the channels are gone", async () => {
    store.set("evt1", makeRow());
    const env = makeEnv({ perms: ALL_PERMS });
    env.service.addNotice({ _id: "evt1" }, "main channel without host access");
    expect(env.service.getReport("evt1")?.warnings).toEqual([
      "main channel without host access",
    ]);
    await env.service.reconcile({ _id: "evt1" }, env.guild);
    const shown = env.service.getReport("evt1");
    expect(shown?.created).toBe(3);
    expect(shown?.warnings).toContain("main channel without host access");
    (store.get("evt1") as Row).state = "cancelled";
    await env.service.cleanup({ _id: "evt1" }, env.guild, NOW_AFTER_GRACE);
    expect(env.service.getReport("evt1")).toBeNull();
  });

  it("does nothing for an event without recorded channels", async () => {
    store.set("evt1", makeRow({ state: "cancelled" }));
    const env = makeEnv({ perms: ALL_PERMS });
    await env.service.cleanup({ _id: "evt1" }, env.guild, NOW_AFTER_GRACE);
    expect(env.fetch).not.toHaveBeenCalled();
    expect(env.rest.delete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------
// Order (#1214)
// ---------------------------------------------------------------------

const { planGroupOrder } =
  await import("../../src/services/event-group-channels.js");

function vc(id: string, rawPosition: number, parentId: string | null = "cat") {
  return { id, parentId, type: ChannelType.GuildVoice, rawPosition };
}

function rateLimit(waitMs = 60_000): RateLimitError {
  return new RateLimitError({
    timeToReset: waitMs,
    limit: 1,
    method: "PATCH",
    hash: "h",
    url: "/",
    route: "/",
    majorParameter: "",
    global: false,
    retryAfter: waitMs,
    sublimitTimeout: 0,
  } as never);
}

type Env = ReturnType<typeof makeEnv>;

/** The ids of the voice channels of the event's category, top to bottom. */
function orderOf(env: Env): string[] {
  const all = [...env.fixed.values(), ...env.channels.values()] as Array<{
    id: string;
    parentId?: string;
    rawPosition?: number;
    type: ChannelType;
  }>;
  return all
    .filter((c) => c.parentId === CATEGORY && c.type === ChannelType.GuildVoice)
    .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0))
    .map((c) => c.id);
}

/** Copy what Discord reports into the gateway cache (what events would do). */
function syncCache(env: Env): void {
  for (const [id, channel] of [...env.fixed, ...env.channels]) {
    env.cache.set(id, channel);
  }
}

function patches(env: Env): unknown[] {
  return env.rest.patch.mock.calls.map((c) => c[1].body);
}

/** What the scan asks before it starts a pass (cache only). */
function looksWrong(env: Env): boolean {
  const row = store.get("evt1") as Row;
  return env.service.orderLooksWrong(
    { _id: "evt1", channelId: "main-1", groups: row.groups },
    env.guild,
  );
}

/** A voice channel that is already recorded and cached in the test's server. */
function seedChannel(
  env: Env,
  id: string,
  rawPosition: number,
  parentId: string = CATEGORY,
): void {
  env.channels.set(id, {
    id,
    type: ChannelType.GuildVoice,
    guildId: GUILD,
    members: { size: 0 },
    parentId,
    rawPosition,
  });
  env.cache.set(id, env.channels.get(id));
}

const T0 = 1_800_000_000_000;

describe("planGroupOrder", () => {
  it("is in order when the groups follow the main channel, even with gaps in the numbers", () => {
    const plan = planGroupOrder(
      "m",
      ["a", "b"],
      [vc("x", 0), vc("m", 5), vc("a", 9), vc("b", 30), vc("y", 31)],
    );
    expect(plan).toEqual({ inOrder: true, moves: [] });
  });

  it("moves only the groups and what has to shift, and keeps foreign channels in their relative order", () => {
    const plan = planGroupOrder(
      "m",
      ["a", "b"],
      [
        vc("x", 0),
        vc("m", 1),
        vc("f1", 2),
        vc("f2", 3),
        vc("a", 4),
        vc("y", 5),
        vc("b", 6),
      ],
    );
    // main (1) keeps its number, a and b take 2 and 3, f1 and f2 shift to 4
    // and 5, y (5) moves to 6; x above the main channel is not sent.
    expect(plan.inOrder).toBe(false);
    expect(plan.moves).toEqual([
      { id: "a", position: 2 },
      { id: "b", position: 3 },
      { id: "f1", position: 4 },
      { id: "f2", position: 5 },
      { id: "y", position: 6 },
    ]);
  });

  it("does not send a foreign channel that already sits far enough down", () => {
    const plan = planGroupOrder(
      "m",
      ["a"],
      [vc("m", 0), vc("f", 7), vc("a", 9)],
    );
    expect(plan.moves).toEqual([{ id: "a", position: 1 }]);
  });

  it("reads equal positions by id, as discord.js does: ties that are already in id order are in order", () => {
    const plan = planGroupOrder(
      "100000000000000001",
      ["100000000000000002", "100000000000000003"],
      [
        vc("100000000000000001", 3),
        vc("100000000000000002", 3),
        vc("100000000000000003", 3),
      ],
    );
    expect(plan).toEqual({ inOrder: true, moves: [] });
  });

  it("moves a group whose tie with the main channel resolves the wrong way by id", () => {
    const plan = planGroupOrder("m", ["a"], [vc("m", 3), vc("a", 3)]);
    expect(plan.inOrder).toBe(false);
    expect(plan.moves).toEqual([{ id: "a", position: 4 }]);
  });

  it("does not shift foreign channels that are tied with each other once there is room", () => {
    const plan = planGroupOrder(
      "m",
      ["a"],
      [vc("m", 0), vc("f1", 3), vc("f2", 3), vc("a", 9)],
    );
    expect(plan.moves).toEqual([{ id: "a", position: 1 }]);
  });

  it("shifts a foreign channel that sits exactly where the last group channel goes, and stops after it", () => {
    const plan = planGroupOrder(
      "m",
      ["a"],
      [vc("m", 0), vc("f1", 1), vc("f2", 5), vc("a", 9)],
    );
    expect(plan.moves).toEqual([
      { id: "a", position: 1 },
      { id: "f1", position: 2 },
    ]);
  });

  it("handles a foreign channel between two groups", () => {
    const plan = planGroupOrder(
      "m",
      ["a", "b"],
      [vc("m", 0), vc("a", 1), vc("f", 2), vc("b", 3)],
    );
    expect(plan.moves).toEqual([
      { id: "b", position: 2 },
      { id: "f", position: 3 },
    ]);
  });

  it("ignores nothing it was not given: only the channels passed in are ever planned", () => {
    const plan = planGroupOrder("m", ["a"], [vc("m", 0), vc("a", 5)]);
    expect(plan.moves).toEqual([]);
    expect(plan.inOrder).toBe(true);
  });

  it("puts a group that was above the main channel below it", () => {
    const plan = planGroupOrder(
      "m",
      ["a", "b"],
      [vc("b", 0), vc("m", 1), vc("a", 2)],
    );
    // a already has the number right below the main channel; only b moves.
    expect(plan.moves).toEqual([{ id: "b", position: 3 }]);
  });
});

describe("EventGroupChannels ordering", () => {
  it("leaves the groups where they are when they already sit below the main channel", async () => {
    store.set("evt1", makeRow());
    const env = makeEnv({ perms: ALL_PERMS });
    const report = await env.service.reconcile({ _id: "evt1" }, env.guild);
    expect(report.created).toBe(3);
    expect(report.failures).toEqual([]);
    expect(env.rest.patch).not.toHaveBeenCalled();
    expect(orderOf(env)).toEqual(["main-1", "chan-1", "chan-2", "chan-3"]);
  });

  it("writes one bulk position update after creates that landed below foreign channels, leaving the groups directly below the main channel in group order", async () => {
    store.set("evt1", makeRow());
    const env = makeEnv({
      perms: ALL_PERMS,
      foreign: [
        { id: "f1", rawPosition: 1 },
        { id: "f2", rawPosition: 2 },
      ],
    });
    const report = await env.service.reconcile({ _id: "evt1" }, env.guild);
    expect(report.failures).toEqual([]);
    expect(env.rest.post).toHaveBeenCalledTimes(3);
    expect(env.rest.patch).toHaveBeenCalledTimes(1);
    expect(env.rest.patch.mock.calls[0][0]).toBe(`/guilds/${GUILD}/channels`);
    expect(patches(env)[0]).toEqual([
      { id: "chan-1", position: 1 },
      { id: "chan-2", position: 2 },
      { id: "chan-3", position: 3 },
      { id: "f1", position: 4 },
      { id: "f2", position: 5 },
    ]);
    expect(orderOf(env)).toEqual([
      "main-1",
      "chan-1",
      "chan-2",
      "chan-3",
      "f1",
      "f2",
    ]);
  });

  it("moves a recreated group channel back into its place", async () => {
    store.set(
      "evt1",
      makeRow({
        groups: [
          { key: "g_a", name: "Alpha", size: 5, marker: "", channelId: "A" },
          { key: "g_b", name: "Bravo", size: null, marker: "", channelId: "B" },
          { key: "g_c", name: "Charlie", size: 3, marker: "", channelId: "C" },
        ],
      }),
    );
    const env = makeEnv({
      perms: ALL_PERMS,
      foreign: [{ id: "f", rawPosition: 3 }],
    });
    seedChannel(env, "A", 1);
    seedChannel(env, "B", 2);
    // "C" was deleted by someone: Discord says 10003, so it is created again,
    // at the bottom of the category.
    const report = await env.service.reconcile({ _id: "evt1" }, env.guild);
    expect(report.created).toBe(1);
    expect(patches(env)).toEqual([
      [
        { id: "chan-1", position: 3 },
        { id: "f", position: 4 },
      ],
    ]);
    expect(orderOf(env)).toEqual(["main-1", "A", "B", "chan-1", "f"]);
  });

  it("makes no write and no whole-server read when the cache shows the order right and nothing was created", async () => {
    store.set("evt1", makeRow());
    const env = makeEnv({ perms: ALL_PERMS });
    await env.service.reconcile({ _id: "evt1" }, env.guild);
    syncCache(env);
    env.fetch.mockClear();
    const report = await env.service.reconcile({ _id: "evt1" }, env.guild);
    expect(report).toMatchObject({ created: 0, failures: [] });
    expect(env.fetch).not.toHaveBeenCalled();
    expect(env.rest.post).toHaveBeenCalledTimes(3);
    expect(env.rest.patch).not.toHaveBeenCalled();
  });

  it("repairs a group channel someone dragged away: the cache says wrong, a fresh read confirms, one write", async () => {
    store.set("evt1", makeRow());
    const env = makeEnv({ perms: ALL_PERMS });
    await env.service.reconcile({ _id: "evt1" }, env.guild);
    // Someone drags the second group channel to the top.
    (env.channels.get("chan-2") as { rawPosition: number }).rawPosition = -1;
    syncCache(env);
    expect(looksWrong(env)).toBe(true);
    const report = await env.service.reconcile({ _id: "evt1" }, env.guild);
    expect(report.created).toBe(0);
    expect(env.rest.patch).toHaveBeenCalledTimes(1);
    expect(orderOf(env)).toEqual(["main-1", "chan-1", "chan-2", "chan-3"]);
  });

  it("does not write when the cache looks wrong but the fresh read says the order is right", async () => {
    store.set("evt1", makeRow());
    const env = makeEnv({ perms: ALL_PERMS });
    await env.service.reconcile({ _id: "evt1" }, env.guild);
    syncCache(env);
    // A stale cache entry: the channel is already back in place in Discord.
    env.cache.set("chan-2", {
      ...(env.channels.get("chan-2") as object),
      rawPosition: -1,
    });
    await env.service.reconcile({ _id: "evt1" }, env.guild);
    expect(env.fetch).toHaveBeenCalledWith();
    expect(env.rest.patch).not.toHaveBeenCalled();
  });

  describe("fails closed", () => {
    function setup(): Env {
      store.set("evt1", makeRow());
      return makeEnv({
        perms: ALL_PERMS,
        foreign: [{ id: "f1", rawPosition: 1 }],
      });
    }

    it("writes nothing and reports when the channels cannot be read", async () => {
      const env = setup();
      env.fetchErrors.set("*", new Error("network down"));
      const report = await env.service.reconcile({ _id: "evt1" }, env.guild);
      expect(env.rest.patch).not.toHaveBeenCalled();
      expect(report.created).toBe(3);
      expect(report.failures).toHaveLength(1);
      expect(report.failures[0].name).toBe("Group channel order");
      expect(report.failures[0].reason).toMatch(/could not be read/);
    });

    it("writes nothing when the category is not in the listing", async () => {
      const env = setup();
      env.fetch.mockImplementation((async (id?: string) => {
        if (id === undefined) {
          const all = new Map<string, unknown>([...env.fixed, ...env.channels]);
          all.delete(CATEGORY);
          return all;
        }
        return env.fixed.get(id) ?? env.channels.get(id);
      }) as never);
      const report = await env.service.reconcile({ _id: "evt1" }, env.guild);
      expect(env.rest.patch).not.toHaveBeenCalled();
      expect(report.failures.map((f) => f.reason).join()).toMatch(/category/);
    });

    it("writes nothing when a recorded group channel is missing from the listing", async () => {
      const env = setup();
      env.fetch.mockImplementation((async (id?: string) => {
        if (id === undefined) {
          const all = new Map<string, unknown>([...env.fixed, ...env.channels]);
          all.delete("chan-2");
          return all;
        }
        return env.fixed.get(id) ?? env.channels.get(id);
      }) as never);
      const report = await env.service.reconcile({ _id: "evt1" }, env.guild);
      expect(env.rest.patch).not.toHaveBeenCalled();
      expect(report.failures.map((f) => f.reason).join()).toMatch(/Bravo/);
    });

    it("writes nothing when the main channel is not in the listing as a channel in a category", async () => {
      const env = setup();
      env.fetch.mockImplementation((async (id?: string) => {
        if (id === undefined) {
          const all = new Map<string, unknown>([...env.fixed, ...env.channels]);
          all.set("main-1", {
            ...(env.fixed.get("main-1") as object),
            parentId: null,
          });
          return all;
        }
        return env.fixed.get(id) ?? env.channels.get(id);
      }) as never);
      const report = await env.service.reconcile({ _id: "evt1" }, env.guild);
      expect(env.rest.patch).not.toHaveBeenCalled();
      expect(report.failures.map((f) => f.reason).join()).toMatch(
        /main voice channel/,
      );
    });

    it("writes nothing without Manage Channels, and says so", async () => {
      // Channels already exist and are out of order; the bot cannot manage them.
      store.set(
        "evt1",
        makeRow({
          groups: [
            { key: "g_a", name: "Alpha", size: 5, marker: "", channelId: "A" },
          ],
        }),
      );
      const env = makeEnv({
        perms: [],
        foreign: [{ id: "f1", rawPosition: 1 }],
      });
      seedChannel(env, "A", 50);
      syncCache(env);
      const report = await env.service.reconcile({ _id: "evt1" }, env.guild);
      expect(env.rest.patch).not.toHaveBeenCalled();
      expect(report.warnings.join()).toMatch(/Manage Channels/);

      // Held: the next scan neither starts a pass nor reads the whole server,
      // and a pass that runs for another reason shows the reason again.
      expect(looksWrong(env)).toBe(false);
      env.fetch.mockClear();
      const again = await env.service.reconcile({ _id: "evt1" }, env.guild);
      expect(env.fetch).not.toHaveBeenCalledWith();
      expect(again.failures.map((f) => f.reason).join()).toMatch(
        /Manage Channels/,
      );
    });

    it("does not move a group channel out of another category into the main channel's, and says so", async () => {
      store.set(
        "evt1",
        makeRow({
          groups: [
            { key: "g_a", name: "Alpha", size: 5, marker: "", channelId: "A" },
            {
              key: "g_b",
              name: "Bravo",
              size: null,
              marker: "",
              channelId: "B",
            },
          ],
        }),
      );
      const env = makeEnv({
        perms: ALL_PERMS,
        foreign: [{ id: "f", rawPosition: 1 }],
      });
      seedChannel(env, "A", 0, OTHER_CATEGORY);
      seedChannel(env, "B", 9);
      syncCache(env);
      const report = await env.service.reconcile({ _id: "evt1" }, env.guild);
      expect(patches(env)).toEqual([
        [
          { id: "B", position: 1 },
          { id: "f", position: 2 },
        ],
      ]);
      expect(report.warnings.join()).toMatch(/Alpha.*left where it is/);
    });
  });

  describe("rate limits, timeouts and the hold", () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("reports a rate-limited write without aborting, holds the retry, and writes on a later pass after a fresh read", async () => {
      store.set("evt1", makeRow());
      const env = makeEnv({
        perms: ALL_PERMS,
        foreign: [{ id: "f1", rawPosition: 1 }],
      });
      env.rest.patch.mockImplementationOnce(async () => {
        throw rateLimit(90_000);
      });
      const now = jest.spyOn(Date, "now").mockReturnValue(T0);
      const first = await env.service.reconcile({ _id: "evt1" }, env.guild);
      expect(first.created).toBe(3);
      expect(first.failures).toHaveLength(1);
      expect(first.failures[0].reason).toMatch(/limiting/);
      expect(orderOf(env)).toEqual([
        "main-1",
        "f1",
        "chan-1",
        "chan-2",
        "chan-3",
      ]);

      // Inside the wait the scan does not start a pass, and a pass that runs
      // for another reason reports the hold without a read or a write.
      syncCache(env);
      now.mockReturnValue(T0 + 30_000);
      expect(looksWrong(env)).toBe(false);
      env.fetch.mockClear();
      env.rest.patch.mockClear();
      const held = await env.service.reconcile({ _id: "evt1" }, env.guild);
      expect(held.failures[0].reason).toMatch(/limiting/);
      expect(env.fetch).not.toHaveBeenCalledWith();
      expect(env.rest.patch).not.toHaveBeenCalled();

      // After the wait: read again, then write.
      now.mockReturnValue(T0 + 91_000);
      expect(looksWrong(env)).toBe(true);
      const later = await env.service.reconcile({ _id: "evt1" }, env.guild);
      expect(later.failures).toEqual([]);
      expect(env.fetch).toHaveBeenCalledWith();
      expect(env.rest.patch).toHaveBeenCalledTimes(1);
      expect(orderOf(env)).toEqual([
        "main-1",
        "chan-1",
        "chan-2",
        "chan-3",
        "f1",
      ]);
    });

    it.each([
      ["a refused write", apiError(50013), REFUSED_CREATE_BACKOFF_MS],
      ["a timed-out write", new Error("timeout"), 10 * MIN],
    ])(
      "holds %s for the same time as a failed create",
      async (_n, error, ms) => {
        store.set("evt1", makeRow());
        const env = makeEnv({
          perms: ALL_PERMS,
          foreign: [{ id: "f1", rawPosition: 1 }],
        });
        env.rest.patch.mockImplementationOnce(async () => {
          throw error;
        });
        const now = jest.spyOn(Date, "now").mockReturnValue(T0);
        const first = await env.service.reconcile({ _id: "evt1" }, env.guild);
        expect(first.failures).toHaveLength(1);
        syncCache(env);
        now.mockReturnValue(T0 + ms - 1000);
        expect(looksWrong(env)).toBe(false);
        now.mockReturnValue(T0 + ms + 1000);
        expect(looksWrong(env)).toBe(true);
      },
    );

    it("does not write after a rate-limited create, and reports it", async () => {
      store.set("evt1", makeRow());
      const env = makeEnv({
        perms: ALL_PERMS,
        foreign: [{ id: "f1", rawPosition: 1 }],
      });
      // The first create goes through, the second is rate limited.
      const post = env.rest.post.getMockImplementation() as never as (
        ...a: unknown[]
      ) => Promise<unknown>;
      env.rest.post.mockImplementationOnce(post as never);
      env.rest.post.mockImplementationOnce(async () => {
        throw rateLimit();
      });
      const report = await env.service.reconcile({ _id: "evt1" }, env.guild);
      expect(report.created).toBe(1);
      expect(env.rest.patch).not.toHaveBeenCalled();
      expect(report.failures.map((f) => f.reason).join()).toMatch(
        /Not attempted: Discord is rate limiting/,
      );
    });

    it("stops writing when a written order is still reported wrong (no request every scan)", async () => {
      store.set("evt1", makeRow());
      const env = makeEnv({
        perms: ALL_PERMS,
        foreign: [{ id: "f1", rawPosition: 1 }],
      });
      // Discord accepts the write but the order does not change.
      env.rest.patch.mockImplementation(async () => undefined);
      await env.service.reconcile({ _id: "evt1" }, env.guild);
      expect(env.rest.patch).toHaveBeenCalledTimes(1);
      syncCache(env);
      const second = await env.service.reconcile({ _id: "evt1" }, env.guild);
      expect(env.rest.patch).toHaveBeenCalledTimes(1);
      expect(second.failures[0].reason).toMatch(
        /still reports a different order/,
      );
      expect(looksWrong(env)).toBe(false);
    });

    it("writes again for a different problem after a successful write (a channel deleted and created again later)", async () => {
      store.set("evt1", makeRow());
      const env = makeEnv({
        perms: ALL_PERMS,
        foreign: [{ id: "f1", rawPosition: 1 }],
      });
      await env.service.reconcile({ _id: "evt1" }, env.guild);
      expect(env.rest.patch).toHaveBeenCalledTimes(1);
      // The write took effect and the gateway updated the cache. No scan has
      // looked in between (so nothing cleared the stored write).
      syncCache(env);
      // Later someone deletes the second group channel; it is created again at
      // the bottom, and the order is wrong in a new way.
      env.channels.delete("chan-2");
      env.cache.delete("chan-2");
      const report = await env.service.reconcile({ _id: "evt1" }, env.guild);
      expect(report.created).toBe(1);
      expect(report.failures).toEqual([]);
      expect(env.rest.patch).toHaveBeenCalledTimes(2);
      expect(orderOf(env)).toEqual([
        "main-1",
        "chan-1",
        "chan-4",
        "chan-3",
        "f1",
      ]);
    });

    it("writes the same plan again once the order was seen right in between", async () => {
      store.set("evt1", makeRow());
      const env = makeEnv({
        perms: ALL_PERMS,
        foreign: [{ id: "f1", rawPosition: 1 }],
      });
      await env.service.reconcile({ _id: "evt1" }, env.guild);
      const firstBody = patches(env)[0];
      syncCache(env);
      expect(looksWrong(env)).toBe(false); // seen right
      // Someone puts everything back exactly as it was at the start.
      for (const [id, pos] of [
        ["chan-1", 101],
        ["chan-2", 102],
        ["chan-3", 103],
        ["f1", 1],
      ] as const) {
        const channel = (env.channels.get(id) ?? env.fixed.get(id)) as {
          rawPosition: number;
        };
        channel.rawPosition = pos;
      }
      syncCache(env);
      expect(looksWrong(env)).toBe(true);
      const report = await env.service.reconcile({ _id: "evt1" }, env.guild);
      expect(report.failures).toEqual([]);
      expect(env.rest.patch).toHaveBeenCalledTimes(2);
      expect(patches(env)[1]).toEqual(firstBody);
    });
  });

  it("decides from a fresh read: an event cancelled during the pass is not ordered", async () => {
    store.set("evt1", makeRow());
    const env = makeEnv({
      perms: ALL_PERMS,
      foreign: [{ id: "f1", rawPosition: 1 }],
    });
    const original = findById.getMockImplementation() as (id: string) => {
      lean: () => Promise<object>;
    };
    // The pass's own read sees an open event; the ordering step's read, after
    // the creates, finds it cancelled.
    let reads = 0;
    findById.mockImplementation(((id: string) => {
      reads += 1;
      const base = original(id);
      return reads === 1
        ? base
        : {
            lean: async () => ({ ...(await base.lean()), state: "cancelled" }),
          };
    }) as never);
    await env.service.reconcile({ _id: "evt1" }, env.guild);
    findById.mockImplementation(original as never);
    expect(env.rest.patch).not.toHaveBeenCalled();
    expect(env.fetch).not.toHaveBeenCalledWith();
  });

  it("writes the order only after the pace when the pass already wrote", async () => {
    store.set("evt1", makeRow());
    const env = makeEnv({
      perms: ALL_PERMS,
      paceMs: 40,
      foreign: [{ id: "f1", rawPosition: 1 }],
    });
    let lastPost = 0;
    let patchedAt = 0;
    const post = env.rest.post.getMockImplementation() as never as (
      ...a: unknown[]
    ) => Promise<unknown>;
    env.rest.post.mockImplementation((async (...a: unknown[]) => {
      lastPost = Date.now();
      return post(...a);
    }) as never);
    env.rest.patch.mockImplementationOnce(async () => {
      patchedAt = Date.now();
      return undefined;
    });
    await env.service.reconcile({ _id: "evt1" }, env.guild);
    expect(patchedAt - lastPost).toBeGreaterThanOrEqual(35);
  });

  it("makes no extra Discord call for events without groups", async () => {
    for (const row of [
      makeRow({ groups: [] }),
      makeRow({ groupsEnabled: false }),
      makeRow({ state: "ended" }),
    ]) {
      store.set("evt1", row);
      const env = makeEnv({ perms: ALL_PERMS });
      await env.service.reconcile({ _id: "evt1" }, env.guild);
      expect(env.fetch).not.toHaveBeenCalled();
      expect(env.rest.post).not.toHaveBeenCalled();
      expect(env.rest.patch).not.toHaveBeenCalled();
      expect(env.call).not.toHaveBeenCalled();
      expect(looksWrong(env)).toBe(false);
    }
  });

  describe("orderLooksWrong reads the cache only", () => {
    const groups = [{ channelId: "a" }, { channelId: "b" }];
    const e = { _id: "e", channelId: "m", groups };
    function guildWith(entries: Array<Record<string, unknown>>): {
      guild: never;
      fetch: jest.Mock;
    } {
      const fetch = jest.fn();
      return {
        guild: {
          channels: {
            cache: new Map(entries.map((c) => [c.id as string, c])),
            fetch,
          },
        } as never,
        fetch,
      };
    }

    it("is true for a group channel above the main channel, with no Discord call", () => {
      const { guild, fetch } = guildWith([vc("m", 1), vc("a", 0), vc("b", 2)]);
      expect(makeEnv().service.orderLooksWrong(e, guild)).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    });

    it("is false when it cannot tell: main, a group channel or a position is not cached", () => {
      const service = makeEnv().service;
      expect(service.orderLooksWrong(e, guildWith([vc("a", 0)]).guild)).toBe(
        false,
      );
      expect(
        service.orderLooksWrong(e, guildWith([vc("m", 1), vc("a", 0)]).guild),
      ).toBe(false);
      const noPosition = {
        id: "b",
        parentId: "cat",
        type: ChannelType.GuildVoice,
      };
      expect(
        service.orderLooksWrong(
          e,
          guildWith([vc("m", 1), vc("a", 0), noPosition]).guild,
        ),
      ).toBe(false);
      expect(service.orderLooksWrong(e, guildWith([]).guild)).toBe(false);
    });

    it("ignores text channels and other categories", () => {
      const text = {
        id: "t",
        parentId: "cat",
        type: ChannelType.GuildText,
        rawPosition: 2,
      };
      const { guild } = guildWith([
        vc("m", 1),
        vc("a", 2),
        vc("b", 3),
        text,
        vc("o", 2, "other"),
      ]);
      expect(makeEnv().service.orderLooksWrong(e, guild)).toBe(false);
    });
  });
});
