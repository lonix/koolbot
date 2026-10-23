/**
 * Cleanup plan after a removed bot (#1179): candidate detection, plan
 * generation through the production scan and planner, and apply / rollback on
 * the simulated server shared with the server-adoption end-to-end tests.
 * Discord REST is stubbed; the real gateway, Mongo and Discord are not touched.
 */

import { describe, it, expect, beforeEach, jest } from "@jest/globals";

jest.unstable_mockModule("../../src/services/command-manager.js", () => ({
  CommandManager: {
    getInstance: () => ({
      makeDiscordApiCall: async (fn: () => Promise<unknown>) => fn(),
    }),
  },
}));

const h = await import("../helpers/adoption-world.js");
const fx = await import("../helpers/adoption-fixtures.js");
const {
  cleanupPlanIsApplicable,
  cleanupRevalidator,
  confirmRemovedBots,
  findRemovedBotCandidates,
  planBotCleanup,
  verifyBotRemoved,
} = await import("../../src/services/bot-removal-cleanup.js");
const { ServerScanService } =
  await import("../../src/services/server-scan-service.js");
type World = import("../helpers/adoption-world.js").World;

const { VIEW } = h;
/** Dyno's id in the catalogue: a bot the report knows about. */
const REMOVED = "155149108183695360";
const STAMP = "2026-10-01T10:00:00.000Z";

interface Setup {
  c: ReturnType<typeof fx.communityServer>;
  world: World;
  /** The two channels that still carry an overwrite for the removed bot. */
  chA: string;
  chB: string;
}

function setup(): Setup {
  const c = fx.communityServer();
  const chA = c.ids.general;
  const chB = c.ids.supportersChat;
  for (const id of [chA, chB]) {
    c.world.channels.get(id)!.overwrites.push({
      id: REMOVED,
      type: "member",
      allow: VIEW,
      deny: "0",
    });
  }
  return { c, world: c.world, chA, chB };
}

/** The simulated guild with the REST reads a cleanup plan makes. */
function guildFor(
  w: World,
  rest: {
    bots?: ReadonlySet<string>;
    userFails?: boolean;
    memberFails?: boolean;
    /** Cached as a member (no role), though Discord says it has left. */
    goneButCached?: boolean;
    /** The bot does not request the GuildMembers intent. */
    noIntent?: boolean;
  } = {},
) {
  h.useWorld(w);
  const guild = h.guildFromWorld(w);
  const fetchMember = guild.members.fetch as (id: string) => Promise<unknown>;
  guild.members.fetch = async (arg: string | { user: string }) => {
    const id = typeof arg === "string" ? arg : arg.user;
    // Only the cleanup's own membership check fails; the scan's reads work.
    if (rest.goneButCached && id === REMOVED)
      throw Object.assign(new Error("Unknown Member"), { code: 10007 });
    if (rest.memberFails && id === REMOVED) throw new Error("Discord is down");
    return fetchMember(id);
  };
  if (rest.noIntent) guild.client.options.intents.has = () => false;
  const bots = rest.bots ?? new Set([REMOVED]);
  guild.client.users = {
    fetch: async (id: string) => {
      if (rest.userFails) throw new Error("Discord is down");
      return { id, bot: bots.has(id) };
    },
  };
  return guild;
}

const plan = (
  s: Setup,
  channels: string[],
  rest: Parameters<typeof guildFor>[1] = {},
) =>
  planBotCleanup(
    guildFor(s.world, rest),
    s.world.adminId,
    REMOVED,
    channels,
    STAMP,
  );

let s: Setup;
beforeEach(() => {
  s = setup();
});

describe("findRemovedBotCandidates", () => {
  async function scanOf(w: World) {
    h.useWorld(w);
    ServerScanService.reset();
    return ServerScanService.getInstance(guildFor(w).client).scanGuild(
      guildFor(w),
      { adminUserId: w.adminId },
    );
  }

  it("lists a catalogue bot that left overwrites behind, with its channels", async () => {
    const found = findRemovedBotCandidates(await scanOf(s.world));
    const dyno = found.find((f) => f.userId === REMOVED)!;
    expect(dyno.evidence).toBe("catalogue");
    expect(dyno.name).toBe("Dyno");
    expect(dyno.overwriteChannels.map((o) => o.id).sort()).toEqual(
      [s.chA, s.chB].sort(),
    );
  });

  it("offers a bare leftover overwrite last, and never a bot still in the server", async () => {
    const found = findRemovedBotCandidates(await scanOf(s.world));
    expect(found.map((f) => f.userId)).toEqual([REMOVED, "h-gone"]);
    expect(found[1]!.evidence).toBe("orphan-overwrite");
    // The other bot's join-to-create lobby overwrite is a present bot.
    expect(found.some((f) => f.userId === s.c.ids.jtcBot)).toBe(false);
  });

  it("does not trust the member cache: a bot back in the server is only listed for a check", async () => {
    s.world.members.set(REMOVED, { bot: true, roleIds: [] });
    const found = findRemovedBotCandidates(await scanOf(s.world));
    const dyno = found.find((f) => f.userId === REMOVED)!;
    expect(dyno.needsCheck).toBe(true);
    const confirmed = await confirmRemovedBots(guildFor(s.world), found);
    expect(confirmed.candidates.some((f) => f.userId === REMOVED)).toBe(false);
  });

  it("still lists a removed bot whose cached member entry remains, once Discord confirms it left", async () => {
    s.world.members.set(REMOVED, { bot: true, roleIds: [] });
    const g = guildFor(s.world, { goneButCached: true });
    const scan = await ServerScanService.getInstance(g.client).scanGuild(g, {
      adminUserId: s.world.adminId,
    });
    expect(scan.bots.some((b) => b.userId === REMOVED)).toBe(true);
    const found = findRemovedBotCandidates(scan);
    expect(found.find((f) => f.userId === REMOVED)?.needsCheck).toBe(true);
    const confirmed = await confirmRemovedBots(g, found);
    const dyno = confirmed.candidates.find((f) => f.userId === REMOVED)!;
    expect(dyno.needsCheck).toBe(false);
    // And a direct preview reaches the forced lookup instead of "still present".
    const planned = await planBotCleanup(
      g,
      s.world.adminId,
      REMOVED,
      [s.chA],
      STAMP,
    );
    expect(planned.errors).toEqual([]);
    expect(planned.plan.operations).toHaveLength(1);
  });

  it("does not list a current human member as a leftover, nor a person who left", async () => {
    s.world.channels.get(s.chA)!.overwrites.push({
      id: "h1",
      type: "member",
      allow: VIEW,
      deny: "0",
    });
    const found = findRemovedBotCandidates(await scanOf(s.world));
    // The scan alone cannot tell h1 (still here) from h-gone: both need a check.
    expect(found.find((f) => f.userId === "h1")?.needsCheck).toBe(true);
    const confirmed = await confirmRemovedBots(guildFor(s.world), found);
    expect(confirmed.candidates.map((f) => f.userId)).toEqual([REMOVED]);
    expect(confirmed.unchecked).toBe(0);
  });

  it("walks more than 25 uncertain accounts over consecutive views", async () => {
    // 30 people who are still here, then a removed bot that sorts after them.
    const late = "999999999999999999";
    for (let i = 0; i < 30; i += 1) {
      const id = `h${String(i).padStart(3, "0")}`;
      s.world.members.set(id, { bot: false, roleIds: [] });
      s.world.channels.get(s.chA)!.overwrites.push({
        id,
        type: "member",
        allow: VIEW,
        deny: "0",
      });
    }
    s.world.channels.get(s.chB)!.overwrites.push({
      id: late,
      type: "member",
      allow: VIEW,
      deny: "0",
    });
    const g = guildFor(s.world, { bots: new Set([REMOVED, late]) });
    const found = findRemovedBotCandidates(await scanOf(s.world));
    const seen: string[] = [];
    let after: string | null = null;
    let views = 0;
    do {
      const page: Awaited<ReturnType<typeof confirmRemovedBots>> =
        await confirmRemovedBots(g, found, { after });
      seen.push(...page.candidates.map((c) => c.userId));
      after = page.next;
      views += 1;
    } while (after && views < 10);
    expect(views).toBe(2);
    expect(seen).toContain(late);
    // No view asks about more than the limit.
    const unsure = found.filter((f) => f.needsCheck).length;
    expect(unsure).toBeGreaterThan(25);
  });

  it("always checks the chosen bot, whichever page it is on, without moving the cursor", async () => {
    const late = "999999999999999999";
    for (let i = 0; i < 30; i += 1) {
      const id = `h${String(i).padStart(3, "0")}`;
      s.world.members.set(id, { bot: false, roleIds: [] });
      s.world.channels.get(s.chA)!.overwrites.push({
        id,
        type: "member",
        allow: VIEW,
        deny: "0",
      });
    }
    s.world.channels.get(s.chB)!.overwrites.push({
      id: late,
      type: "member",
      allow: VIEW,
      deny: "0",
    });
    const g = guildFor(s.world, { bots: new Set([REMOVED, late]) });
    const found = findRemovedBotCandidates(await scanOf(s.world));
    // First window, no cursor: the late bot is outside it, yet included.
    const first = await confirmRemovedBots(g, found, { include: late });
    expect(first.candidates.some((c) => c.userId === late)).toBe(true);
    // The cursor still points at the last account of the window, so the next
    // view continues from there.
    const plain = await confirmRemovedBots(g, found);
    expect(first.next).toBe(plain.next);
    // An included account that is not a bot is still dropped.
    const human = found.find((c) => c.userId === "h029")!;
    const dropped = await confirmRemovedBots(g, found, {
      include: human.userId,
    });
    expect(dropped.candidates.some((c) => c.userId === "h029")).toBe(false);
  });

  it("finds an uncatalogued removed bot when the GuildMembers intent is off", async () => {
    const mystery = "888888888888888888";
    s.world.channels.get(s.chB)!.overwrites.push({
      id: mystery,
      type: "member",
      allow: VIEW,
      deny: "0",
    });
    const g = guildFor(s.world, { noIntent: true, bots: new Set([mystery]) });
    const scan = await ServerScanService.getInstance(g.client).scanGuild(g, {
      adminUserId: s.world.adminId,
    });
    expect(scan.readiness.membersIntent).toBe(false);
    const found = findRemovedBotCandidates(scan);
    expect(found.find((f) => f.userId === mystery)?.needsCheck).toBe(true);
    const confirmed = await confirmRemovedBots(g, found);
    expect(confirmed.candidates.some((f) => f.userId === mystery)).toBe(true);
    // A direct preview reaches the checks and plans the removal.
    const planned = await planBotCleanup(
      g,
      s.world.adminId,
      mystery,
      [s.chB],
      STAMP,
    );
    expect(planned.errors).toEqual([]);
    expect(planned.plan.operations).toHaveLength(1);
    // A failed read still refuses.
    const down = await planBotCleanup(
      guildFor(s.world, { noIntent: true, userFails: true }),
      s.world.adminId,
      mystery,
      [s.chB],
      STAMP,
    );
    expect(down.errors[0]?.code).toBe("bot-check-failed");
    expect(down.plan.operations).toEqual([]);
  });

  it("never offers an account whose check fails, and counts it", async () => {
    for (const id of ["h2", "h3"]) {
      s.world.channels.get(s.chB)!.overwrites.push({
        id,
        type: "member",
        allow: VIEW,
        deny: "0",
      });
    }
    const found = findRemovedBotCandidates(await scanOf(s.world));
    const unsure = found.filter((f) => f.needsCheck).length;
    expect(unsure).toBe(3);
    // The catalogue bot needs no check; every unsure account is dropped.
    const down = await confirmRemovedBots(
      guildFor(s.world, { userFails: true }),
      found,
    );
    expect(down.candidates.map((f) => f.userId)).toEqual([REMOVED]);
    expect(down.unchecked).toBe(unsure);
    // Past the limit an account is not listed either.
    const capped = await confirmRemovedBots(guildFor(s.world), found, {
      limit: 1,
    });
    expect(capped.candidates.map((f) => f.userId)).toEqual([REMOVED]);
    expect(capped.unchecked).toBe(0);
    expect(capped.next).not.toBeNull();
  });
});

describe("verifyBotRemoved", () => {
  it("accepts a bot Discord says is not a member", async () => {
    expect(await verifyBotRemoved(guildFor(s.world), REMOVED)).toBeNull();
  });

  it("refuses a bot that is still a member", async () => {
    s.world.members.set(REMOVED, { bot: true, roleIds: [] });
    const p = await verifyBotRemoved(guildFor(s.world), REMOVED);
    expect(p?.code).toBe("bot-still-present");
  });

  it("refuses an account that is not a bot", async () => {
    const p = await verifyBotRemoved(
      guildFor(s.world, { bots: new Set() }),
      "h-gone",
    );
    expect(p?.code).toBe("not-a-bot");
  });

  it("refuses, and never guesses, when either read fails", async () => {
    expect(
      (await verifyBotRemoved(guildFor(s.world, { userFails: true }), REMOVED))
        ?.code,
    ).toBe("bot-check-failed");
    expect(
      (
        await verifyBotRemoved(
          guildFor(s.world, { memberFails: true }),
          REMOVED,
        )
      )?.code,
    ).toBe("membership-check-failed");
  });
});

describe("planBotCleanup", () => {
  it("plans nothing until the admin ticks a channel", async () => {
    const p = await plan(s, []);
    expect(p.errors).toEqual([]);
    expect(p.plan.operations).toEqual([]);
    expect(cleanupPlanIsApplicable(p)).toBe(false);
  });

  it("plans one approved, destructive-class removal per chosen channel and nothing else", async () => {
    const p = await plan(s, [s.chA, s.chB]);
    expect(p.errors).toEqual([]);
    expect(p.plan.errors).toEqual([]);
    expect(
      p.plan.operations.map((o) => [o.type, o.class, o.targetId]).sort(),
    ).toEqual(
      [
        ["overwrite.remove", "destructive", s.chA],
        ["overwrite.remove", "destructive", s.chB],
      ].sort(),
    );
    expect(cleanupPlanIsApplicable(p)).toBe(true);
    // Reproducible, so the apply step can compare it with the preview.
    expect((await plan(s, [s.chA, s.chB])).plan.id).toBe(p.plan.id);
    expect((await plan(s, [s.chA])).plan.id).not.toBe(p.plan.id);
  });

  it("removes only the removed bot's overwrite, keeping every other one", async () => {
    const p = await plan(s, [s.chA]);
    const op = p.plan.operations[0]!;
    expect(op).toMatchObject({
      type: "overwrite.remove",
      channelId: s.chA,
      overwriteTargetId: REMOVED,
    });
    expect(p.plan.operations).toHaveLength(1);
  });

  it("refuses an id that is not a removed bot this server knows", async () => {
    const p = await planBotCleanup(
      guildFor(s.world),
      s.world.adminId,
      "424242424242424242",
      [s.chA],
      STAMP,
    );
    expect(p.errors.map((e) => e.code)).toEqual(["not-a-removed-bot"]);
    expect(p.plan.operations).toEqual([]);
    expect(cleanupPlanIsApplicable(p)).toBe(false);
  });

  it("refuses a person who left, even though an overwrite names them", async () => {
    const p = await planBotCleanup(
      guildFor(s.world, { bots: new Set() }),
      s.world.adminId,
      "h-gone",
      [s.c.ids.general],
      STAMP,
    );
    expect(p.errors.map((e) => e.code)).toEqual(["not-a-bot"]);
    expect(p.plan.operations).toEqual([]);
  });

  it("refuses when the bot is back, or when Discord cannot be read", async () => {
    s.world.members.set(REMOVED, { bot: true, roleIds: [] });
    expect((await plan(s, [s.chA])).errors[0]?.code).toBe("bot-still-present");
    s.world.members.delete(REMOVED);
    expect((await plan(s, [s.chA], { userFails: true })).errors[0]?.code).toBe(
      "bot-check-failed",
    );
    const down = await plan(s, [s.chA], { memberFails: true });
    expect(down.errors[0]?.code).toBe("membership-check-failed");
    expect(down.plan.operations).toEqual([]);
  });

  it("refuses a channel that has no overwrite for the bot", async () => {
    const p = await plan(s, [s.c.ids.rules]);
    expect(p.errors.map((e) => e.code)).toEqual(["channel-not-eligible"]);
    expect(p.plan.operations).toEqual([]);
  });

  it("flags a setting still bound to a channel the bot touched, without changing it", async () => {
    s.world.config.set("quotes.channel_id", s.chA);
    const p = await plan(s, [s.chA]);
    expect(
      p.plan.warnings.some(
        (w) => w.code === "feature-bound" && /quotes/.test(w.message),
      ),
    ).toBe(true);
    expect(p.plan.operations.some((o) => o.type === "config.set")).toBe(false);
  });
});

describe("apply and rollback on the simulated server", () => {
  const revalidate = (w: World, channels: string[]) =>
    cleanupRevalidator(guildFor(w), w.adminId, REMOVED, channels, STAMP);

  it("removes the overwrites, keeps everything else, and rolls back to the exact original", async () => {
    const before = h.snapshotOf(s.world);
    const e = h.engine(s.world);
    const planned = (await plan(s, [s.chA, s.chB])).plan;
    const result = await e.service.apply(
      planned,
      h.applyOpts(s.world, revalidate(s.world, [s.chA, s.chB])),
    );
    expect(result.status).toBe("applied");
    expect(result.failed).toEqual([]);
    for (const id of [s.chA, s.chB]) {
      expect(
        s.world.channels.get(id)!.overwrites.some((o) => o.id === REMOVED),
      ).toBe(false);
    }
    // The person who left and the other bot are untouched, as is every webhook.
    expect(
      s.world.channels.get(s.chA)!.overwrites.some((o) => o.id === "h-gone"),
    ).toBe(true);
    expect(
      s.world.channels
        .get(s.c.ids.foreignLobby)!
        .overwrites.some((o) => o.id === s.c.ids.jtcBot),
    ).toBe(true);
    expect(e.writeCalls().every((c) => c === "removeOverwrite")).toBe(true);
    expect([...s.world.webhooks.values()]).toEqual(before.webhooks);

    // Idempotent: nothing is left to plan.
    expect((await plan(s, [s.chA, s.chB])).plan.operations).toEqual([]);

    const back = await e.service.rollback(result.snapshotId, {
      actor: h.actorFor(s.world),
    });
    expect(back.failed).toEqual([]);
    expect(e.records.get(result.snapshotId)!.status).toBe("rolled_back");
    expect(h.snapshotOf(s.world)).toEqual(before);
  });

  it("the live-state check refuses once the bot has come back", async () => {
    const planned = (await plan(s, [s.chA])).plan;
    const check = revalidate(s.world, [s.chA]);
    expect(await check(planned.operations)).toEqual([]);
    s.world.members.set(REMOVED, { bot: true, roleIds: [] });
    const problems = await check(planned.operations);
    expect(problems.join(" ")).toMatch(/still in the server/);
  });

  it("the live-state check refuses a step whose overwrite is already gone", async () => {
    const planned = (await plan(s, [s.chA])).plan;
    s.world.channels.get(s.chA)!.overwrites = s.world.channels
      .get(s.chA)!
      .overwrites.filter((o) => o.id !== REMOVED);
    const problems = await revalidate(s.world, [s.chA])(planned.operations);
    expect(problems.join(" ")).toMatch(/no longer matches the live server/);
  });

  it("the engine refuses to run the removal without a live-state check", async () => {
    const planned = (await plan(s, [s.chA])).plan;
    const e = h.engine(s.world);
    await expect(
      e.service.apply(planned, {
        actor: h.actorFor(s.world),
        batchDelayMs: 0,
      } as never),
    ).rejects.toThrow(/live-state check/);
    expect(
      s.world.channels.get(s.chA)!.overwrites.some((o) => o.id === REMOVED),
    ).toBe(true);
  });
});
