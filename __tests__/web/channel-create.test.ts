/**
 * The shared helper that creates the channel or category a setting points at
 * (#1659): the plan (nothing written), the apply that re-checks the live
 * server, and the rollback of what one apply created.
 */

import { describe, it, expect, jest } from "@jest/globals";
import { DiscordAPIError, RateLimitError, Routes } from "discord.js";
import type { ChannelCreateDeps } from "../../src/web/channel-create.js";
import type { ManagedChannelView } from "../../src/web/channel-manager.js";

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  isDebugMode: () => false,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { applyChannelPlan, normaliseChannelName, planChannels } =
  await import("../../src/web/channel-create.js");
const { withChannelLock, CHANNEL_LOCK_WAIT_MS, CHANNEL_LOCK_BUSY_MESSAGE } =
  await import("../../src/web/channel-write-lock.js");

const view = (
  id: string,
  name: string,
  kind: ManagedChannelView["kind"],
  parentId: string | null = null,
): ManagedChannelView => ({
  id,
  name,
  kind,
  typeLabel: kind,
  parentId,
  position: 0,
  topic: null,
  userLimit: null,
  bitrate: null,
});

const CAT = "111111111111111111";
const live = [
  view(CAT, "Staff", "category"),
  view("222222222222222222", "mod-log", "text", CAT),
];

const apiError = (code: number, message: string, status = 403): Error =>
  new DiscordAPIError(
    { code, message },
    code,
    status,
    "POST",
    "https://discord.com/api/v10/guilds/1/channels",
    {},
  );

function setup(channels: ManagedChannelView[] = live) {
  let next = 900;
  const post = jest.fn(
    async (route: string, opts: { body: Record<string, unknown> }) => ({
      id: String(++next).padStart(18, "0"),
      name: opts.body.name as string,
    }),
  );
  const del = jest
    .fn<(route: string, opts: unknown) => Promise<void>>()
    .mockResolvedValue(undefined);
  const deps: ChannelCreateDeps = {
    guildId: "1",
    rest: { post, delete: del } as unknown as ChannelCreateDeps["rest"],
    call: (fn) => fn(new AbortController().signal),
    listChannels: async () => channels,
    reason: "test",
  };
  return { deps, post, del };
}

describe("normaliseChannelName", () => {
  it("lowercases and hyphenates a text channel name the way Discord does", () => {
    expect(normaliseChannelName("text", "  Mod  Log ")).toBe("mod-log");
    expect(normaliseChannelName("text", "a -- b")).toBe("a----b");
    expect(normaliseChannelName("text", "raid--alerts")).toBe("raid--alerts");
    expect(normaliseChannelName("text", "-raid-")).toBe("-raid-");
    expect(normaliseChannelName("text", "📢 News")).toBe("📢-news");
  });
  it("keeps voice and category names as typed (control characters aside)", () => {
    expect(normaliseChannelName("voice", " Game  Room ")).toBe("Game Room");
    expect(normaliseChannelName("category", "Staff")).toBe("Staff");
  });
});

describe("planChannels", () => {
  it("plans a create and writes nothing", () => {
    const plan = planChannels([{ kind: "text", name: "Raid Alerts" }], live);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.entries).toEqual([
      { kind: "text", name: "raid-alerts", parentId: null, action: "create" },
    ]);
  });

  it("selects the existing channel when the name exists in the same parent", () => {
    const plan = planChannels(
      [{ kind: "text", name: "Mod Log", parentId: CAT }],
      live,
    );
    expect(plan.ok && plan.entries[0]).toMatchObject({
      action: "existing",
      existingId: "222222222222222222",
    });
  });

  it.each(["raid--alerts", "-raid-", "Raid--Alerts"])(
    "selects an existing channel stored as %s, hyphens as typed",
    (typed) => {
      const channels = [
        ...live,
        view("666666666666666666", typed.toLowerCase(), "text"),
      ];
      const plan = planChannels([{ kind: "text", name: typed }], channels);
      expect(plan.ok && plan.entries[0]).toMatchObject({
        action: "existing",
        existingId: "666666666666666666",
      });
    },
  );

  it("never creates a duplicate of a channel whose stored name has upper case or spaces", () => {
    const channels = [
      ...live,
      view("666666666666666666", "Raid Alerts", "text"),
    ];
    const plan = planChannels(
      [{ kind: "text", name: "raid-alerts" }],
      channels,
    );
    expect(plan.ok && plan.entries[0].action).toBe("existing");
  });

  it("refuses a name that is over 100 characters once lowercased", () => {
    const plan = planChannels([{ kind: "text", name: "İ".repeat(100) }], live);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.errors.join(" ")).toMatch(/at most 100/);
  });

  it("creates when the same name exists only in another parent or kind", () => {
    const plan = planChannels([{ kind: "text", name: "mod-log" }], live);
    expect(plan.ok && plan.entries[0].action).toBe("create");
    const voice = planChannels(
      [{ kind: "voice", name: "mod-log", parentId: CAT }],
      live,
    );
    expect(voice.ok && voice.entries[0].action).toBe("create");
  });

  it.each([
    [{ kind: "text", name: "   " }, /name/i],
    [{ kind: "voice", name: "x".repeat(101) }, /100/],
    [{ kind: "text", name: "ok", parentId: "999999999999999999" }, /category/i],
    [{ kind: "category", name: "ok", parentId: CAT }, /no parent/i],
  ])("refuses %j", (entry, message) => {
    const plan = planChannels(
      [entry as Parameters<typeof planChannels>[0][number]],
      live,
    );
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.errors.join(" ")).toMatch(message);
  });

  it("refuses two entries that would be the same channel", () => {
    const plan = planChannels(
      [
        { kind: "text", name: "Alerts" },
        { kind: "text", name: "alerts" },
      ],
      live,
    );
    expect(plan.ok).toBe(false);
  });

  it("gives the same plan id for the same plan and another when the server changed", () => {
    const a = planChannels([{ kind: "text", name: "alerts" }], live);
    const b = planChannels([{ kind: "text", name: "alerts" }], live);
    const c = planChannels(
      [{ kind: "text", name: "alerts" }],
      [...live, view("333333333333333333", "alerts", "text")],
    );
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (a.ok && b.ok && c.ok) {
      expect(a.planId).toBe(b.planId);
      expect(c.planId).not.toBe(a.planId);
    }
  });
});

describe("applyChannelPlan", () => {
  const entries = [
    { kind: "category" as const, name: "Logs" },
    { kind: "text" as const, name: "Raid Alerts" },
  ];

  it("creates what was reviewed, returns the ids, sets no permission overwrites", async () => {
    const { deps, post } = setup();
    const reviewed = planChannels(entries, live);
    if (!reviewed.ok) throw new Error("plan");
    const result = await applyChannelPlan(deps, entries, reviewed.planId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.channels.map((c) => c.created)).toEqual([true, true]);
    expect(post).toHaveBeenCalledTimes(2);
    for (const [route, opts] of post.mock.calls) {
      expect(route).toBe(Routes.guildChannels("1"));
      expect(opts.body).not.toHaveProperty("permission_overwrites");
    }
  });

  it("returns the existing id without a write when the name exists", async () => {
    const { deps, post } = setup();
    const one = [{ kind: "text" as const, name: "mod-log", parentId: CAT }];
    const reviewed = planChannels(one, live);
    if (!reviewed.ok) throw new Error("plan");
    const result = await applyChannelPlan(deps, one, reviewed.planId);
    expect(result).toEqual({
      ok: true,
      channels: [{ id: "222222222222222222", name: "mod-log", created: false }],
    });
    expect(post).not.toHaveBeenCalled();
  });

  it("writes nothing when the live server no longer matches what Review showed", async () => {
    const reviewed = planChannels(entries, live);
    if (!reviewed.ok) throw new Error("plan");
    // Someone created "raid-alerts" between Review and Apply.
    const changed = [
      ...live,
      view("444444444444444444", "raid-alerts", "text"),
    ];
    const { deps, post } = setup(changed);
    const result = await applyChannelPlan(deps, entries, reviewed.planId);
    expect(result).toMatchObject({ ok: false, removed: [], stuck: [] });
    expect(post).not.toHaveBeenCalled();
  });

  it("removes what it created when the second entry fails", async () => {
    const { deps, post, del } = setup();
    const reviewed = planChannels(entries, live);
    if (!reviewed.ok) throw new Error("plan");
    post.mockImplementationOnce(async (_r, o) => ({
      id: "555555555555555555",
      name: o.body.name as string,
    }));
    post.mockRejectedValueOnce(apiError(50013, "Missing Permissions"));
    const result = await applyChannelPlan(deps, entries, reviewed.planId);
    expect(result).toMatchObject({
      ok: false,
      removed: ["555555555555555555"],
      stuck: [],
    });
    expect(del).toHaveBeenCalledWith(
      Routes.channel("555555555555555555"),
      expect.anything(),
    );
    if (!result.ok) expect(result.error).toMatch(/Discord refused/);
  });

  it("reports a channel it could not remove again", async () => {
    const { deps, post, del } = setup();
    const reviewed = planChannels(entries, live);
    if (!reviewed.ok) throw new Error("plan");
    post.mockImplementationOnce(async (_r, o) => ({
      id: "555555555555555555",
      name: o.body.name as string,
    }));
    post.mockRejectedValueOnce(apiError(50013, "Missing Permissions"));
    del.mockRejectedValueOnce(apiError(50013, "Missing Permissions"));
    const result = await applyChannelPlan(deps, entries, reviewed.planId);
    expect(result).toMatchObject({
      ok: false,
      removed: [],
      stuck: ["555555555555555555"],
    });
  });

  it("counts a channel that is already gone as removed", async () => {
    const { deps, post, del } = setup();
    const reviewed = planChannels(entries, live);
    if (!reviewed.ok) throw new Error("plan");
    post.mockImplementationOnce(async (_r, o) => ({
      id: "555555555555555555",
      name: o.body.name as string,
    }));
    post.mockRejectedValueOnce(apiError(50013, "Missing Permissions"));
    del.mockRejectedValueOnce(apiError(10003, "Unknown Channel", 404));
    const result = await applyChannelPlan(deps, entries, reviewed.planId);
    expect(result).toMatchObject({
      removed: ["555555555555555555"],
      stuck: [],
    });
  });

  it("tells the admin to check Discord when the failed create may have gone through", async () => {
    const { deps, post } = setup();
    const reviewed = planChannels(entries, live);
    if (!reviewed.ok) throw new Error("plan");
    post.mockRejectedValueOnce(new Error("Discord API timeout after 30000ms"));
    const result = await applyChannelPlan(deps, entries, reviewed.planId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Check Discord/);
  });

  it("says reading the channels failed and nothing was created when the read fails", async () => {
    const { deps, post } = setup();
    const reviewed = planChannels(entries, live);
    if (!reviewed.ok) throw new Error("plan");
    deps.listChannels = async () => {
      throw new Error("Discord API timeout after 30000ms");
    };
    const result = await applyChannelPlan(deps, entries, reviewed.planId);
    expect(result).toMatchObject({ ok: false, removed: [], stuck: [] });
    if (!result.ok) {
      expect(result.error).toMatch(/nothing was created/);
      expect(result.error).not.toMatch(/Check Discord|already/);
    }
    expect(post).not.toHaveBeenCalled();
  });

  it("passes a rate limit through as its own message and leaves nothing", async () => {
    const { deps, post } = setup();
    const reviewed = planChannels(entries, live);
    if (!reviewed.ok) throw new Error("plan");
    post.mockRejectedValueOnce(
      new RateLimitError({
        timeToReset: 0,
        retryAfter: 120_000,
        sublimitTimeout: 0,
        limit: 2,
        method: "POST",
        hash: "h",
        url: "https://discord.com/api/v10/guilds/1/channels",
        route: "/guilds/:id/channels",
        majorParameter: "1",
        global: false,
        scope: "user",
      }),
    );
    const result = await applyChannelPlan(deps, entries, reviewed.planId);
    expect(result).toMatchObject({ ok: false, removed: [], stuck: [] });
    if (!result.ok) expect(result.error).toMatch(/limiting changes/);
  });
});

describe("capacity of a whole plan", () => {
  const fill = (count: number, parentId: string | null = null) =>
    Array.from({ length: count }, (_, i) =>
      view(
        `7${String(i).padStart(17, "0")}`,
        `fill-${parentId ?? "top"}-${i}`,
        "text",
        parentId,
      ),
    );
  const two = [
    { kind: "text" as const, name: "one" },
    { kind: "text" as const, name: "two" },
  ];

  it("refuses 499 server channels plus two creates, before any write", () => {
    expect(planChannels(two, fill(499)).ok).toBe(false);
  });
  it("accepts 498 plus two creates (exactly at 500)", () => {
    expect(planChannels(two, fill(498)).ok).toBe(true);
  });
  it("refuses one create on a full server", () => {
    expect(planChannels([two[0]], fill(500)).ok).toBe(false);
  });
  it("does not count selected existing channels against the limit", () => {
    const keep = view("888888888888888888", "keep", "text");
    const full = [...fill(499), keep];
    const plan = planChannels(
      [
        { kind: "text", name: "keep" },
        { kind: "text", name: "fresh" },
      ],
      [...fill(498), keep],
    );
    expect(plan.ok && plan.entries.map((e) => e.action)).toEqual([
      "existing",
      "create",
    ]);
    const onlyExisting = planChannels([{ kind: "text", name: "keep" }], full);
    expect(onlyExisting.ok).toBe(true);
  });

  const inCat = (n: number) => [
    view(CAT, "Staff", "category"),
    ...fill(n, CAT),
  ];
  const twoIn = two.map((e) => ({ ...e, parentId: CAT }));
  it("refuses 49 category children plus two creates", () => {
    const plan = planChannels(twoIn, inCat(49));
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.errors.join(" ")).toMatch(/per category/);
  });
  it("accepts 48 plus two creates (exactly 50)", () => {
    expect(planChannels(twoIn, inCat(48)).ok).toBe(true);
  });
  it("does not count selected existing channels against a category", () => {
    expect(
      planChannels(
        [{ kind: "text", name: "fill-" + CAT + "-0", parentId: CAT }],
        inCat(50),
      ).ok,
    ).toBe(true);
    const plan = planChannels(
      [
        { kind: "text", name: "fill-" + CAT + "-0", parentId: CAT },
        { kind: "text", name: "fresh", parentId: CAT },
      ],
      inCat(49),
    );
    expect(plan.ok).toBe(true);
  });
  it("counts a create in another category separately", () => {
    expect(
      planChannels(
        [
          { kind: "text", name: "x" },
          { kind: "text", name: "y" },
        ],
        inCat(50),
      ).ok,
    ).toBe(true);
  });
});

describe("the message after a failure that follows a first create", () => {
  const rate = (): Error =>
    new RateLimitError({
      timeToReset: 0,
      retryAfter: 120_000,
      sublimitTimeout: 0,
      limit: 2,
      method: "POST",
      hash: "h",
      url: "https://discord.com/api/v10/guilds/1/channels",
      route: "/guilds/:id/channels",
      majorParameter: "1",
      global: false,
      scope: "user",
    });
  const kinds: [string, () => Error][] = [
    ["rate limit", rate],
    ["missing permission", () => apiError(50013, "Missing Permissions")],
    ["timeout", () => new Error("Discord API timeout after 30000ms")],
    ["other error", () => new Error("socket hang up")],
  ];
  const rollbacks: [string, "ok" | "fail" | "gone"][] = [
    ["rollback succeeded", "ok"],
    ["rollback failed", "fail"],
    ["rollback gone (404)", "gone"],
  ];
  const entries = [
    { kind: "category" as const, name: "Logs" },
    { kind: "text" as const, name: "Raid Alerts" },
  ];

  describe.each(kinds)("%s on the second create", (_k, make) => {
    it.each(rollbacks)("%s", async (_r, mode) => {
      const { deps, post, del } = setup();
      const reviewed = planChannels(entries, live);
      if (!reviewed.ok) throw new Error("plan");
      post.mockImplementationOnce(async (_x, o) => ({
        id: "555555555555555555",
        name: o.body.name as string,
      }));
      post.mockRejectedValueOnce(make());
      if (mode === "fail")
        del.mockRejectedValueOnce(apiError(50013, "Missing Permissions"));
      if (mode === "gone")
        del.mockRejectedValueOnce(apiError(10003, "Unknown Channel", 404));
      const result = await applyChannelPlan(deps, entries, reviewed.planId);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      // Something was created in this call, so it never claims no change.
      expect(result.error).not.toMatch(/nothing was changed/i);
      if (mode === "fail") {
        expect(result.stuck).toEqual(["555555555555555555"]);
        expect(result.error).toContain("555555555555555555");
        expect(result.error).toMatch(/still exist/);
        expect(result.error).toMatch(/check/i);
        expect(result.error).not.toMatch(/try again in|retry/i);
        expect(result.error).not.toMatch(/were removed again/);
      } else {
        expect(result.stuck).toEqual([]);
        expect(result.removed).toEqual(["555555555555555555"]);
        expect(result.error).toMatch(/removed again/);
      }
    });
  });

  it("keeps the plain message when the first create fails", async () => {
    const { deps, post } = setup();
    const reviewed = planChannels(entries, live);
    if (!reviewed.ok) throw new Error("plan");
    post.mockRejectedValueOnce(rate());
    const result = await applyChannelPlan(deps, entries, reviewed.planId);
    if (!result.ok) expect(result.error).toMatch(/Nothing was changed/);
  });
});

describe("errors wrapped by makeDiscordApiCall (the cause chain)", () => {
  const rate = (): RateLimitError =>
    new RateLimitError({
      timeToReset: 0,
      retryAfter: 120_000,
      sublimitTimeout: 0,
      limit: 2,
      method: "POST",
      hash: "h",
      url: "https://discord.com/api/v10/guilds/1/channels",
      route: "/guilds/:id/channels",
      majorParameter: "1",
      global: false,
      scope: "user",
    });
  const wrap = (cause: unknown, depth = 1): Error => {
    let e: unknown = cause;
    for (let i = 0; i < depth; i += 1) {
      e = new Error("Failed to create channel after 3 attempts", { cause: e });
    }
    return e as Error;
  };
  const entries = [
    { kind: "category" as const, name: "Logs" },
    { kind: "text" as const, name: "Raid Alerts" },
  ];

  async function run(
    failure: Error,
    opts: { afterFirst: boolean; deleteError?: Error },
  ) {
    const { deps, post, del } = setup();
    const reviewed = planChannels(entries, live);
    if (!reviewed.ok) throw new Error("plan");
    if (opts.afterFirst) {
      post.mockImplementationOnce(async (_x, o) => ({
        id: "555555555555555555",
        name: o.body.name as string,
      }));
    }
    post.mockRejectedValueOnce(failure);
    if (opts.deleteError) del.mockRejectedValueOnce(opts.deleteError);
    return applyChannelPlan(deps, entries, reviewed.planId);
  }

  it.each([1, 2])(
    "reports a wrapped rate limit (depth %i) as a rate limit on the first create",
    async (depth) => {
      const result = await run(wrap(rate(), depth), { afterFirst: false });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/limiting changes/);
        expect(result.error).not.toMatch(/Check Discord|may already/);
      }
    },
  );

  it("reports a wrapped rate limit on a later create, with the leftover channel named", async () => {
    const result = await run(wrap(rate()), {
      afterFirst: true,
      deleteError: apiError(50013, "Missing Permissions"),
    });
    expect(result).toMatchObject({ ok: false, stuck: ["555555555555555555"] });
    if (!result.ok) {
      expect(result.error).toMatch(/limiting changes/);
      expect(result.error).toContain("555555555555555555");
      expect(result.error).not.toMatch(/may already|didn't confirm/);
    }
  });

  it("reports a wrapped missing permission as Discord's refusal", async () => {
    const result = await run(wrap(apiError(50013, "Missing Permissions")), {
      afterFirst: false,
    });
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toMatch(/Discord refused the change/);
  });

  it("keeps a wrapped timeout uncertain", async () => {
    const result = await run(
      wrap(new Error("Discord API timeout after 30000ms")),
      { afterFirst: false },
    );
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toMatch(/Check Discord/);
  });

  it("counts a wrapped 404 on the rollback delete as removed", async () => {
    const result = await run(apiError(50013, "Missing Permissions"), {
      afterFirst: true,
      deleteError: wrap(apiError(10003, "Unknown Channel", 404)),
    });
    expect(result).toMatchObject({
      ok: false,
      removed: ["555555555555555555"],
      stuck: [],
    });
  });

  it("does not loop on a cyclic cause chain", async () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    const result = await run(a, { afterFirst: false });
    expect(result.ok).toBe(false);
  });
});

describe("applyChannelPlan serialises per server (#1714)", () => {
  const entry = { kind: "text" as const, name: "bot-log" };
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };

  /** Hold the lock for a server until `finish()`; resolves once the holder runs. */
  async function holdLock(guildId: string): Promise<{
    finish: () => void;
    done: Promise<unknown>;
  }> {
    let finish!: () => void;
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const done = withChannelLock(guildId, async () => {
      started();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    await running;
    return { finish, done };
  }

  /** One shared server: a create adds to what the next read returns. */
  function sharedServer(guildId = "1") {
    const channels: ManagedChannelView[] = [...live];
    let release: (() => void) | null = null;
    let hold: Promise<void> | null = null;
    const post = jest.fn(
      async (_route: string, opts: { body: Record<string, unknown> }) => {
        if (hold) await hold;
        const id = String(900 + channels.length).padStart(18, "0");
        channels.push(view(id, opts.body.name as string, "text", null));
        return { id, name: opts.body.name as string };
      },
    );
    const del = jest
      .fn<(route: string, opts: unknown) => Promise<void>>()
      .mockResolvedValue(undefined);
    const deps: ChannelCreateDeps = {
      guildId,
      rest: { post, delete: del } as unknown as ChannelCreateDeps["rest"],
      call: (fn) => fn(new AbortController().signal),
      listChannels: async () => [...channels],
      reason: "test",
    };
    return {
      deps,
      post,
      del,
      channels,
      holdCreates: () => {
        hold = new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      releaseCreates: () => release?.(),
    };
  }

  it("two concurrent applies for the same name create one channel", async () => {
    const server = sharedServer();
    const reviewed = planChannels([entry], server.channels);
    if (!reviewed.ok) throw new Error("plan");
    server.holdCreates();
    const first = applyChannelPlan(server.deps, [entry], reviewed.planId);
    const second = applyChannelPlan(server.deps, [entry], reviewed.planId);
    await flush();
    expect(server.post).toHaveBeenCalledTimes(1);
    server.releaseCreates();
    const results = await Promise.all([first, second]);
    expect(server.post).toHaveBeenCalledTimes(1);
    expect(results[0].ok).toBe(true);
    // The second one re-planned inside the lock, saw the name, and wrote nothing.
    expect(results[1]).toMatchObject({ ok: false, removed: [], stuck: [] });
    expect(server.channels.filter((c) => c.name === "bot-log")).toHaveLength(1);
  });

  it("an apply waits for another writer of the same server and re-reads after it", async () => {
    const server = sharedServer();
    const reviewed = planChannels([entry], server.channels);
    if (!reviewed.ok) throw new Error("plan");
    let finishOther!: () => void;
    const other = withChannelLock("1", async () => {
      await new Promise<void>((resolve) => {
        finishOther = resolve;
      });
      // The other writer (the Channel Manager) creates the same name.
      server.channels.push(view("777777777777777777", "bot-log", "text"));
    });
    const apply = applyChannelPlan(server.deps, [entry], reviewed.planId);
    await flush();
    expect(server.post).not.toHaveBeenCalled();
    finishOther();
    await other;
    const result = await apply;
    expect(server.post).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(server.channels.filter((c) => c.name === "bot-log")).toHaveLength(1);
  });

  it("releases the lock after a failed apply and after its rollback", async () => {
    const server = sharedServer();
    const two = [entry, { kind: "text" as const, name: "second" }];
    const reviewed = planChannels(two, server.channels);
    if (!reviewed.ok) throw new Error("plan");
    server.post
      .mockImplementationOnce(async (_r, opts) => ({
        id: "888888888888888881",
        name: opts.body.name as string,
      }))
      .mockRejectedValueOnce(apiError(50013, "Missing Permissions"));
    const failed = await applyChannelPlan(server.deps, two, reviewed.planId);
    expect(failed).toMatchObject({
      ok: false,
      removed: ["888888888888888881"],
    });
    expect(server.del).toHaveBeenCalledTimes(1);
    expect(await withChannelLock("1", async () => "free")).toEqual({
      ok: true,
      value: "free",
    });
  });

  it("releases the lock when the rollback itself fails", async () => {
    const server = sharedServer();
    const two = [entry, { kind: "text" as const, name: "second" }];
    const reviewed = planChannels(two, server.channels);
    if (!reviewed.ok) throw new Error("plan");
    server.post
      .mockImplementationOnce(async (_r, opts) => ({
        id: "888888888888888881",
        name: opts.body.name as string,
      }))
      .mockRejectedValueOnce(apiError(50013, "Missing Permissions"));
    server.del.mockRejectedValue(apiError(50013, "Missing Permissions"));
    const failed = await applyChannelPlan(server.deps, two, reviewed.planId);
    expect(failed).toMatchObject({ ok: false, stuck: ["888888888888888881"] });
    expect(await withChannelLock("1", async () => "free")).toEqual({
      ok: true,
      value: "free",
    });
  });

  it("releases the lock when the channels cannot be read", async () => {
    const server = sharedServer();
    const deps = {
      ...server.deps,
      listChannels: async () => {
        throw new Error("down");
      },
    };
    const result = await applyChannelPlan(deps, [entry], "whatever");
    expect(result.ok).toBe(false);
    expect(await withChannelLock("1", async () => "free")).toEqual({
      ok: true,
      value: "free",
    });
  });

  it("releases the lock after a create that timed out", async () => {
    const server = sharedServer();
    const reviewed = planChannels([entry], server.channels);
    if (!reviewed.ok) throw new Error("plan");
    server.post.mockRejectedValueOnce(new Error("Request timeout"));
    const result = await applyChannelPlan(
      server.deps,
      [entry],
      reviewed.planId,
    );
    expect(result.ok).toBe(false);
    expect(await withChannelLock("1", async () => "free")).toEqual({
      ok: true,
      value: "free",
    });
  });

  it("a caller that waits too long gets the busy message in the unchanged result shape and writes nothing", async () => {
    jest.useFakeTimers();
    try {
      const server = sharedServer();
      const { finish, done: holder } = await holdLock("1");
      const waiting = applyChannelPlan(server.deps, [entry], "any");
      await jest.advanceTimersByTimeAsync(CHANNEL_LOCK_WAIT_MS);
      expect(await waiting).toEqual({
        ok: false,
        error: CHANNEL_LOCK_BUSY_MESSAGE,
        removed: [],
        stuck: [],
      });
      finish();
      await holder;
      expect(server.post).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it("an apply cancelled while it waits writes nothing and leaves the lock free", async () => {
    const server = sharedServer();
    const reviewed = planChannels([entry], server.channels);
    if (!reviewed.ok) throw new Error("plan");
    const { finish, done: holder } = await holdLock("1");
    const abort = new AbortController();
    const waiting = applyChannelPlan(
      { ...server.deps, signal: abort.signal },
      [entry],
      reviewed.planId,
    );
    abort.abort();
    expect(await waiting).toMatchObject({ ok: false, removed: [], stuck: [] });
    finish();
    await holder;
    await flush();
    expect(server.post).not.toHaveBeenCalled();
    expect(await withChannelLock("1", async () => "free")).toEqual({
      ok: true,
      value: "free",
    });
  });

  it("a different server is not blocked", async () => {
    const busy = sharedServer("1");
    const free = sharedServer("2");
    const reviewed = planChannels([entry], free.channels);
    if (!reviewed.ok) throw new Error("plan");
    const { finish, done: holder } = await holdLock("1");
    const result = await applyChannelPlan(free.deps, [entry], reviewed.planId);
    expect(result.ok).toBe(true);
    expect(busy.post).not.toHaveBeenCalled();
    finish();
    await holder;
  });
});
