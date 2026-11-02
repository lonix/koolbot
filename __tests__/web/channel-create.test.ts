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
    expect(normaliseChannelName("text", "a -- b")).toBe("a-b");
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
