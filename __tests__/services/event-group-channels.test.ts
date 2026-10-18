import { describe, it, expect, jest, beforeEach } from "@jest/globals";
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
}

function makeEnv(
  opts: { perms?: bigint[] | null; categoryOverwrites?: unknown[] } = {},
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
      fetch: jest.fn(async (id: string, _o?: unknown) => {
        if (fetchErrors.has(id)) throw fetchErrors.get(id);
        const channel = channels.get(id);
        if (!channel) throw apiError(10003);
        return channel;
      }),
    },
  };
  let seq = 0;
  const rest = {
    post: jest.fn(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async (_route: string, _o: { body: Record<string, unknown> }) => {
        seq += 1;
        const id = `chan-${seq}`;
        channels.set(id, {
          id,
          type: ChannelType.GuildVoice,
          guildId: GUILD,
          members: { size: 0 },
        });
        return { id };
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
      resolveCategory: async () => category as never,
      getPrefix: async () => "📅",
      getGraceMs: async () => 15 * MIN,
    },
    { rest: rest as never, call: call as never, paceMs: 0 },
  );
  return {
    service,
    guild: guild as never,
    rest,
    call,
    channels,
    fetchErrors,
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
    expect(report.warnings.join(" ")).toContain("Manage Roles or Move Members");
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
    expect(report.warnings.join(" ")).toContain("refused");
  });

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

  it("does nothing for an event without recorded channels", async () => {
    store.set("evt1", makeRow({ state: "cancelled" }));
    const env = makeEnv({ perms: ALL_PERMS });
    await env.service.cleanup({ _id: "evt1" }, env.guild, NOW_AFTER_GRACE);
    expect(env.fetch).not.toHaveBeenCalled();
    expect(env.rest.delete).not.toHaveBeenCalled();
  });
});
