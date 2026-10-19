/**
 * End-to-end server adoption on simulated guilds (#1025, #1180, epic #1017).
 *
 * Unlike the engine's unit tests, the gateway, snapshot store and config here
 * really mutate an in-memory server, so "apply", "re-plan gives an empty plan"
 * and "rollback restores the original" are checked against state, not against
 * a list of calls. The machinery lives in `__tests__/helpers/adoption-world.ts`
 * and the servers, as data, in `__tests__/helpers/adoption-fixtures.ts`:
 *
 * 1. the reference gaming server (#1025): the legacy hand-built scan feeds the
 *    claims, role groups run through the production planner;
 * 2. a small Community server (#1180): the production path, from discord.js
 *    shaped objects through `ServerScanService` to `planChannelClaims`;
 * 3. a large community (#1180): the same path at scale, plus the rules role.
 *
 * Webhooks are in every fixture. The engine has no webhook method, so the
 * tests assert the exact webhook set after apply and rollback, that no
 * webhook-shaped gateway call was ever reached for, and (in the harness
 * check at the end) that the guard can fail when a channel is deleted.
 *
 * Not modelled: the real Discord gateway and REST layer, MongoDB, the web
 * routes and job runner, role-hierarchy shifting when a role is created, and
 * crash recovery (resume, reconcile).
 */

import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { performance } from "node:perf_hooks";

// The large fixtures build a 3000-member world and plan it more than once; give
// every test the room that takes on a slow runner under coverage.
jest.setTimeout(30000);

const h = await import("../helpers/adoption-world.js");
const fx = await import("../helpers/adoption-fixtures.js");
const { isBlocking } = await import("../../src/services/channel-claims.js");
const { RulesService } = await import("../../src/services/rules-service.js");
type World = import("../helpers/adoption-world.js").World;
type Claim = import("../helpers/adoption-world.js").Claim;
type Plan = import("../helpers/adoption-world.js").AdoptionPlan;
type Reads = import("../helpers/adoption-world.js").Reads;
type Engine = ReturnType<typeof h.engine>;

const { F, VIEW } = h;
const bits = (...flags: bigint[]): string =>
  flags.reduce((a, b) => a | b, 0n).toString();

/** The overwrite steps a plan has on one channel. */
const overwritesOn = (plan: Plan, channelId: string) =>
  plan.operations.flatMap((o) =>
    o.type === "overwrite.set" && o.channelId === channelId ? [o] : [],
  );
const configSets = (plan: Plan): Record<string, unknown> =>
  Object.fromEntries(
    plan.operations.flatMap((o) =>
      o.type === "config.set" ? [[o.key, o.value]] : [],
    ),
  );
const touchedChannels = (plan: Plan): Set<string> =>
  new Set(
    plan.operations.flatMap((o) =>
      o.type === "overwrite.set" || o.type === "overwrite.remove"
        ? [o.channelId]
        : [],
    ),
  );

/**
 * Webhooks are exactly as they were, and the engine never reached for anything
 * that is not a modelled gateway method (so, in particular, nothing that could
 * write or delete a webhook).
 */
function expectWebhooksUntouched(
  w: World,
  before: ReturnType<typeof h.snapshotOf>,
  e: Engine,
): void {
  expect(before.webhooks.length).toBeGreaterThan(0);
  expect([...w.webhooks.values()]).toEqual(before.webhooks);
  expect([...e.accessed].filter((n) => /webhook/i.test(n))).toEqual([]);
  expect(
    [...e.accessed].filter(
      (n) => !(h.GATEWAY_METHODS as readonly string[]).includes(n),
    ),
  ).toEqual([]);
}

/** What `linkCreatedRoles` does after an apply: link each group to its new role. */
function linkCreatedRoles(
  groups: Array<Record<string, unknown>>,
  record: { createdRoles: Array<{ roleId: string; name: string }> },
): void {
  for (const g of groups) {
    const created = record.createdRoles.find((r) => r.name === g["name"]);
    if (g["roleId"] === null && created) {
      g["roleId"] = created.roleId;
      g["createdByKoolbot"] = true;
    }
  }
}

const group = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: "g",
  name: "Group",
  roleId: null,
  rank: 1,
  permissions: null,
  capabilities: [],
  colour: null,
  createdByKoolbot: false,
  gateOnly: false,
  hoist: false,
  roleName: null,
  unlinked: false,
  lostRoleId: null,
  recreateRoleAt: null,
  recreateRequestedAt: null,
  syncPolicy: null,
  driftSignature: null,
  createdAt: new Date(0),
  ...over,
});

beforeEach(() => {
  h.harness.voiceMigrationDone = true;
  h.harness.groups = [];
  h.harness.roleUses = [];
});

// ---------------------------------------------------------------------------
// Fixture 1: the reference server
// ---------------------------------------------------------------------------

describe("server adoption, end to end on the reference server", () => {
  let world: World;
  let before: ReturnType<typeof h.snapshotOf>;
  /** A role the plan creates itself, to exercise created-role rollback. */
  const extraRoles = [{ name: "Adopted Staff", color: 5 }];
  const plan = (w: World) => h.planHand(w, fx.REFERENCE_CLAIMS, { extraRoles });
  beforeEach(() => {
    world = fx.referenceServer();
    before = h.snapshotOf(world);
  });

  it("plans only additive, reversible changes and nothing for what is left alone", () => {
    const { built, plan: p } = plan(world);
    expect(built.issues.filter(isBlocking)).toEqual([]);
    expect(p.errors).toEqual([]);
    expect(p.operations.length).toBeGreaterThan(0);
    // Non-destructive rule: nothing is deleted or replaced.
    expect(p.operations.filter((o) => o.class === "destructive")).toEqual([]);
    expect(p.operations.filter((o) => /delete|remove/.test(o.type))).toEqual(
      [],
    );

    // Existing feature channels and the voice category are bound, not recreated.
    expect(configSets(p)).toMatchObject({
      "quotes.channel_id": "quotes",
      "voicetracking.announcements.channel_id": "voice-stats",
      "events.announcement_channel_id": "announcement",
      "core.errors.channel_id": "staff-log",
      "voicechannels.category_id": "cat-voice",
      "voicechannels.lobby.channel_id": "lobby",
      "voicechannels.cleanup.managed_only": true,
    });
    // The only role created is the one this test asked for.
    expect(p.operations.filter((o) => o.type === "role.create")).toHaveLength(
      1,
    );

    // Only the claimed channels are written to: the picker, the integration
    // category, the music-bot channel, the AFK channel and every game
    // category are never touched.
    const touched = touchedChannels(p);
    for (const untouched of [
      "picker",
      "cat-integration",
      "integration-feed",
      "music",
      "afk",
      "cat-admin",
      ...Array.from({ length: 10 }, (_, i) => `cat-game-${i}`),
    ]) {
      expect(touched.has(untouched)).toBe(false);
    }
    expect(touched.has("news")).toBe(true);
    expect(touched.has("vip-lounge")).toBe(true);
  });

  it("treats the webhook-fed news channels as feeds and says their webhooks are kept", () => {
    const { built } = plan(world);
    const kept = built.issues.filter((i) => i.code === "feed-preserved");
    expect(kept.map((i) => i.targetId).sort()).toEqual(["news", "updates"]);
    // A feed claim is only valid because the webhooks are there to be found.
    const bare = fx.referenceServer();
    bare.webhooks.delete("wh-news");
    const { built: without } = h.planHand(bare, fx.REFERENCE_CLAIMS);
    expect(
      without.issues.filter(isBlocking).map((i) => [i.code, i.targetId]),
    ).toEqual([["not-a-feed", "news"]]);
  });

  it("applies, is idempotent, and rolls back to the exact original server", async () => {
    const e = h.engine(world);
    const first = plan(world).plan;
    const result = await e.service.apply(first, h.applyOpts(world));
    expect(result.status).toBe("applied");
    expect(result.failed).toEqual([]);

    // Applied: channels are gated / read-only and settings are bound.
    expect(world.config.get("quotes.channel_id")).toBe("quotes");
    expect(
      world.channels.get("news")!.overwrites.some((o) => o.id === "g1"),
    ).toBe(true);
    expect(
      [...world.roles.values()].some((r) => r.name === "Adopted Staff"),
    ).toBe(true);
    // The other bot's overwrites and the foreign channels are exactly as they were.
    for (const id of [
      "picker",
      "music",
      "cat-integration",
      "afk",
      "cat-admin",
    ]) {
      expect(world.channels.get(id)).toEqual(
        before.channels.find((c) => c.id === id),
      );
    }
    expect(e.writes.some((w) => w.startsWith("deleteChannel"))).toBe(false);
    expect(
      e.writeCalls().every((c) => c === "setOverwrite" || c === "createRole"),
    ).toBe(true);
    // The five webhooks, exactly, including the followed channel and the
    // application webhook on the picker.
    expect([...world.webhooks.keys()].sort()).toEqual([
      "wh-integration",
      "wh-news",
      "wh-picker-app",
      "wh-updates",
      "wh-updates-follow",
    ]);
    expectWebhooksUntouched(world, before, e);

    // Idempotent: planning the adopted server again gives an empty plan
    // (the extra role now exists by name, so it is not created twice).
    const again = plan(world);
    expect(again.plan.errors).toEqual([]);
    expect(again.plan.operations).toEqual([]);

    // Roll back: every touched channel, role and setting is back.
    const back = await e.service.rollback(result.snapshotId, {
      actor: h.actorFor(world),
      deleteCreatedRoles: true,
    });
    expect(back.failed).toEqual([]);
    expect(e.records.get(result.snapshotId)!.status).toBe("rolled_back");
    expect(h.snapshotOf(world)).toEqual(before);
    expectWebhooksUntouched(world, before, e);

    // A restored server plans exactly like the original again.
    expect(plan(world).plan.operations).toHaveLength(first.operations.length);
  });

  it("leaves a role the plan created in place unless asked to delete it", async () => {
    const e = h.engine(world);
    const result = await e.service.apply(plan(world).plan, h.applyOpts(world));
    await e.service.rollback(result.snapshotId, { actor: h.actorFor(world) });
    expect(
      [...world.roles.values()].some((r) => r.name === "Adopted Staff"),
    ).toBe(true);
    expect([...world.channels.values()]).toEqual(before.channels);
    expectWebhooksUntouched(world, before, e);
  });

  it("refuses to roll the same snapshot back twice", async () => {
    const e = h.engine(world);
    const result = await e.service.apply(plan(world).plan, h.applyOpts(world));
    await e.service.rollback(result.snapshotId, { actor: h.actorFor(world) });
    await expect(
      e.service.rollback(result.snapshotId, { actor: h.actorFor(world) }),
    ).rejects.toThrow(/already rolled back/);
  });
});

// ---------------------------------------------------------------------------
// Fixture 2: a small Community server
// ---------------------------------------------------------------------------

describe("server adoption, end to end on a small Community server", () => {
  let c: ReturnType<typeof fx.communityServer>;
  let before: ReturnType<typeof h.snapshotOf>;
  beforeEach(() => {
    c = fx.communityServer();
    before = h.snapshotOf(c.world);
  });

  /** Channels adoption must never write to on this server. */
  const foreign = (): string[] => [
    c.ids.foreignLobby,
    c.ids.lounge,
    c.ids.vcChat,
    c.ids.roomAlice,
    c.ids.roomBob,
    c.ids.catRooms,
    c.ids.afk,
    c.ids.rules,
    c.ids.general,
  ];

  it("plans additive steps only and leaves the foreign lobby, the permanent rooms and the rules channel alone", async () => {
    const p = await h.planClaims(c.world, c.claims);
    expect(p.errors).toEqual([]);
    expect(p.plan.errors).toEqual([]);
    expect(h.claimsPlanIsApplicable(p)).toBe(true);
    expect(p.plan.operations.filter((o) => o.class === "destructive")).toEqual(
      [],
    );
    expect(p.plan.operations.map((o) => o.type)).toEqual([
      ...Array(6).fill("overwrite.set"),
      ...Array(2).fill("config.set"),
    ]);
    expect(touchedChannels(p.plan)).toEqual(
      new Set([c.ids.announcements, c.ids.supportersChat, c.ids.catVoice]),
    );
    for (const id of foreign()) {
      expect(touchedChannels(p.plan).has(id)).toBe(false);
    }
    // The voice category is bound with managed-only cleanup; nothing turns
    // voice or the rules gate on.
    expect(configSets(p.plan)).toEqual({
      "voicechannels.cleanup.managed_only": true,
      "voicechannels.category_id": c.ids.catVoice,
    });
    // Advice, not blockers: another bot may run join-to-create, and the
    // announcement channel's webhooks are kept.
    expect(p.warnings.map((i) => i.code).sort()).toEqual([
      "feed-preserved",
      "voice-handover",
      "voice-managed-only",
    ]);
  });

  it("applies, re-plans empty and rolls back, never touching the foreign lobby, the rooms or the webhooks", async () => {
    const e = h.engine(c.world);
    const p = await h.planClaims(c.world, c.claims);
    const result = await e.service.apply(p.plan, h.applyOpts(c.world));
    expect(result.status).toBe("applied");
    expect(result.failed).toEqual([]);

    expect(c.world.config.get("voicechannels.category_id")).toBe(
      c.ids.catVoice,
    );
    expect(c.world.config.get("voicechannels.cleanup.managed_only")).toBe(true);
    const gated = c.world.channels
      .get(c.ids.supportersChat)!
      .overwrites.find((o) => o.id === c.ids.guild)!;
    expect(BigInt(gated.deny) & F.ViewChannel).toBe(F.ViewChannel);
    // Nothing is deleted, recreated or moved; only overwrites are written.
    expect(e.writeCalls().every((x) => x === "setOverwrite")).toBe(true);
    expect(e.writes.filter((w) => w.startsWith("setOverwrite"))).toHaveLength(
      p.plan.operations.filter((o) => o.type === "overwrite.set").length,
    );
    for (const id of foreign()) {
      expect(c.world.channels.get(id)).toEqual(
        before.channels.find((x) => x.id === id),
      );
    }
    expect([...c.world.webhooks.keys()]).toHaveLength(3);
    expectWebhooksUntouched(c.world, before, e);

    const again = await h.planClaims(c.world, c.claims);
    expect(again.errors).toEqual([]);
    expect(again.plan.errors).toEqual([]);
    expect(again.plan.operations).toEqual([]);

    const back = await e.service.rollback(result.snapshotId, {
      actor: h.actorFor(c.world),
    });
    expect(back.failed).toEqual([]);
    expect(h.snapshotOf(c.world)).toEqual(before);
    expectWebhooksUntouched(c.world, before, e);
    expect(
      (await h.planClaims(c.world, c.claims)).plan.operations,
    ).toHaveLength(p.plan.operations.length);
  });

  it("treats the owner as the admin: the gate that locks a role-less non-owner admin out is fine for the owner", async () => {
    const asOwner = await h.planClaims(c.world, c.claims);
    expect(asOwner.scan.scanned.adminUserId).toBe(c.ids.owner);
    expect(asOwner.scan.scanned.adminRoleIds).toEqual([]);
    expect(asOwner.plan.errors).toEqual([]);

    // The same server and claims, planned by a member who is only an admin by
    // role: with no role of the right kind they would lose the channel.
    c.world.adminId = "h5";
    const asMember = await h.planClaims(c.world, c.claims);
    expect(asMember.plan.errors.map((x) => x.code)).toContain(
      "admin-access-lost",
    );
    expect(h.claimsPlanIsApplicable(asMember)).toBe(false);
    const e = h.engine(c.world);
    await expect(
      e.service.apply(asMember.plan, h.applyOpts(c.world)),
    ).rejects.toThrow(/blocking error/);
    expect(e.writeCalls()).toEqual([]);
  });

  it("flags the native rules gate and plans no rules gate by default on a Community server", async () => {
    const p = await h.planClaims(c.world, c.claims);
    expect(p.scan.community.community).toBe(true);
    expect(p.scan.community.rulesChannelId).toBe(c.ids.rules);
    expect(p.scan.community.onboardingRoleIds).toEqual([c.ids.newcomer]);
    expect(p.scan.channels.find((x) => x.id === c.ids.rules)!.flags.rules).toBe(
      true,
    );
    // Adoption neither binds the rules settings nor writes to the channel.
    expect(
      Object.keys(configSets(p.plan)).filter((k) => k.startsWith("rules.")),
    ).toEqual([]);
    expect(touchedChannels(p.plan).has(c.ids.rules)).toBe(false);
    // The rules page sees the native gate, and a rollout with nothing ticked
    // plans nothing (the KoolBot gate is opt-in and off by default).
    const guild = h.guildFromWorld(c.world);
    expect(RulesService.nativeGate(guild)).toEqual({
      community: true,
      screening: false,
    });
    h.useWorld(c.world);
    const rules = await h.planRulesGate(guild, c.ids.owner, {
      createRole: false,
      grantExisting: false,
      gateChannelIds: [],
    });
    expect(rules.plan.operations).toEqual([]);
    expect(rules.extraErrors).toEqual([]);
  });

  it("plans the same whatever the operator's environment says", async () => {
    const baseline = (
      await h.planClaims(c.world, c.claims)
    ).plan.operations.map((o) => o.summary);
    const keys = [
      "voicechannels.cleanup.managed_only",
      "voicechannels.category_id",
    ];
    const saved = keys.map((k) => process.env[k]);
    process.env[keys[0]!] = "true";
    process.env[keys[1]!] = "999999999999999999";
    try {
      const p = await h.planClaims(c.world, c.claims);
      expect(p.plan.operations.map((o) => o.summary)).toEqual(baseline);
      expect(p.plan.baseline.config["voicechannels.category_id"]).toBe("");
    } finally {
      keys.forEach((k, i) => {
        if (saved[i] === undefined) delete process.env[k];
        else process.env[k] = saved[i];
      });
    }
  });

  it("derives which channels follow their category from their overwrites, as Discord does", async () => {
    const synced = async (): Promise<Record<string, boolean | null>> => {
      const p = await h.planClaims(c.world, c.claims);
      return Object.fromEntries(
        p.scan.channels.map((x) => [x.id, x.syncedToParent]),
      );
    };
    const first = await synced();
    expect(first[c.ids.rules]).toBe(true); // no overwrites, like Information
    expect(first[c.ids.supportersChat]).toBe(true);
    expect(first[c.ids.general]).toBe(false); // the stale member overwrite
    expect(first[c.ids.foreignLobby]).toBe(false); // the other bot's overwrite
    expect(first[c.ids.catInfo]).toBeNull(); // a category has no parent

    // Gating a child gives it overwrites of its own: it no longer follows.
    // An approved sync of `general` removes the stale one: it now does.
    const claims: Claim[] = [
      ...c.claims,
      { channelId: c.ids.general, action: "sync", approveReplace: true },
    ];
    const e = h.engine(c.world);
    const p = await h.planClaims(c.world, claims);
    await e.service.apply(
      p.plan,
      h.applyOpts(c.world, h.revalidatorFor(c.world, claims)),
    );
    const after = await synced();
    expect(after[c.ids.supportersChat]).toBe(false);
    expect(after[c.ids.general]).toBe(true);
  });

  it("mirrors a category gate onto the children that follow it and leaves the others alone", async () => {
    // Alice's room follows the Rooms category; Bob's has an overwrite of its own.
    c.world.channels.get(c.ids.roomBob)!.overwrites.push({
      id: c.ids.supporters,
      type: "role",
      allow: VIEW,
      deny: "0",
    });
    const p = await h.planClaims(c.world, [
      {
        channelId: c.ids.catRooms,
        action: "gate",
        roleIds: [c.ids.supporters],
      },
    ]);
    expect(p.plan.errors).toEqual([]);
    expect(touchedChannels(p.plan)).toEqual(
      new Set([c.ids.catRooms, c.ids.roomAlice]),
    );
  });

  it("blocks binding the shared Voice Chat category while empty cleanup could delete the foreign lobby (#1032)", async () => {
    const risky: Claim[] = c.claims.map((x) =>
      x.channelId === c.ids.catVoice ? { ...x, voiceManagedOnly: false } : x,
    );
    const p = await h.planClaims(c.world, risky);
    const risk = p.errors.find((x) => x.code === "voice-cleanup-risk");
    expect(risk?.targetId).toBe(c.ids.catVoice);
    // It names what would be lost: the other bot's lobby and the lounge.
    expect(risk?.message).toContain("➕ Create Room");
    expect(risk?.message).toContain("Lounge");
    expect(risk?.message).not.toContain("Alice");
    expect(h.claimsPlanIsApplicable(p)).toBe(false);

    // The same mistake with the personal rooms category names the rooms.
    const rooms: Claim[] = [
      {
        channelId: c.ids.catRooms,
        action: "leave",
        bindKey: "voicechannels.category_id",
      },
    ];
    const r = await h.planClaims(c.world, rooms);
    const roomRisk = r.errors.find((x) => x.code === "voice-cleanup-risk");
    expect(roomRisk?.message).toContain("Alice's Room");
    expect(roomRisk?.message).toContain("Bob's Room");
    expect(h.claimsPlanIsApplicable(r)).toBe(false);
  });

  it("blocks adopting a category whose channels the first managed-only cleanup would take for KoolBot's (#1032)", async () => {
    // A permanent room that happens to follow KoolBot's default naming.
    c.world.channels.get(c.ids.lounge)!.name = "🎮 Raid Room";
    h.harness.voiceMigrationDone = false;
    const p = await h.planClaims(c.world, c.claims);
    const risk = p.errors.find((x) => x.code === "voice-adoption-risk");
    expect(risk?.message).toContain("🎮 Raid Room");
    expect(risk?.message).not.toContain("Create Room");
    expect(h.claimsPlanIsApplicable(p)).toBe(false);

    // Once the first cleanup has run, adopting the category is safe again, and
    // without a lookalike the unmigrated server is fine too.
    h.harness.voiceMigrationDone = true;
    expect((await h.planClaims(c.world, c.claims)).errors).toEqual([]);
    c.world.channels.get(c.ids.lounge)!.name = "Lounge";
    h.harness.voiceMigrationDone = false;
    expect((await h.planClaims(c.world, c.claims)).errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Fixture 3: a large community
// ---------------------------------------------------------------------------

describe("server adoption, end to end on a large community", () => {
  let L: ReturnType<typeof fx.largeCommunity>;
  let before: ReturnType<typeof h.snapshotOf>;
  beforeEach(() => {
    L = fx.largeCommunity();
    before = h.snapshotOf(L.world);
  });

  it("plans a handful of additive steps for hundreds of claims, in a bounded number of Discord reads", async () => {
    // A small server of the same shape, for what must not grow with size.
    const small = fx.largeCommunity({
      categories: 4,
      perCategory: 3,
      humans: 20,
    });
    const smallReads: Reads = {};
    const smallPlan = await h.planClaims(small.world, small.claims, smallReads);

    const reads: Reads = {};
    const started = performance.now();
    const p = await h.planClaims(L.world, L.claims, reads);
    const elapsed = performance.now() - started;

    expect(p.scan.channels).toHaveLength(L.world.channels.size);
    expect(L.world.channels.size).toBeGreaterThan(400);
    expect(L.claims).toHaveLength(L.world.channels.size);
    expect(p.errors).toEqual([]);
    expect(p.plan.errors).toEqual([]);

    // The scan reads each thing once, however big the server is: no per-channel
    // or per-member request. (This counts Discord reads; it does not time them.)
    expect(reads).toEqual({
      "roles.fetch": 1,
      "channels.fetch": 1,
      "members.fetchOne": 1,
      fetchWebhooks: 1,
      fetchOnboarding: 1,
    });
    expect(reads).toEqual(smallReads);
    // The plan grows with what the claims change, not with the channels they
    // list: ten times the channels, the same steps.
    const overwriteSteps = (pl: Plan): number =>
      pl.operations.filter((o) => o.type === "overwrite.set").length;
    expect(overwriteSteps(p.plan)).toBe(overwriteSteps(smallPlan.plan));
    expect(p.plan.operations).toHaveLength(13);
    expect(p.plan.id).toBe((await h.planClaims(L.world, L.claims)).plan.id);

    // A loose wall-clock ceiling, to catch an accidental quadratic walk (this
    // takes well under a second); the counts above are the real assertions.
    const budgetMs = 8000;
    if (elapsed > budgetMs) {
      throw new Error(
        `scan and plan of ${L.world.channels.size} channels and ${L.world.members.size} members took ${Math.round(elapsed)} ms, over the ${budgetMs} ms budget: look for a per-channel or per-member walk`,
      );
    }
  }, 30000);

  it("applies forum and announcement read-only rules with the exact bits, gates the booster channel and never edits a managed role", async () => {
    const p = await h.planClaims(L.world, L.claims);
    expect(p.plan.operations.filter((o) => o.class === "destructive")).toEqual(
      [],
    );
    // Only what was claimed to change is written, nothing among the other ~400.
    expect(touchedChannels(p.plan)).toEqual(
      new Set([
        L.ids.news,
        L.ids.feedback,
        L.ids.vip,
        L.ids.catVoice,
        L.ids.lobby,
      ]),
    );
    const everyone = (id: string) =>
      overwritesOn(p.plan, id).find(
        (o) => o.overwriteTargetId === L.ids.guild,
      )!;
    // Announcement channel: no posts, no thread replies, no new threads, no reactions.
    expect(everyone(L.ids.news)).toMatchObject({
      allow: "0",
      deny: bits(
        F.SendMessages,
        F.SendMessagesInThreads,
        F.CreatePublicThreads,
        F.CreatePrivateThreads,
        F.AddReactions,
      ),
    });
    // Forum: no new posts or threads, replies in existing posts stay open.
    expect(everyone(L.ids.feedback)).toMatchObject({
      allow: "0",
      deny: bits(
        F.SendMessages,
        F.CreatePublicThreads,
        F.CreatePrivateThreads,
        F.AddReactions,
      ),
    });
    expect(
      BigInt(everyone(L.ids.feedback).deny) & F.SendMessagesInThreads,
    ).toBe(0n);
    // The bot may still post in both.
    for (const id of [L.ids.news, L.ids.feedback]) {
      const bot = overwritesOn(p.plan, id).find(
        (o) => o.overwriteTargetId === h.KOOLBOT_USER,
      )!;
      expect(BigInt(bot.allow) & F.SendMessages).toBe(F.SendMessages);
    }
    // The booster channel is hidden from everyone and shown to the managed
    // Server Booster role, which is used as a gate and nothing else.
    expect(everyone(L.ids.vip).deny).toBe(VIEW);
    expect(
      overwritesOn(p.plan, L.ids.vip).find(
        (o) => o.overwriteTargetId === L.ids.booster,
      ),
    ).toMatchObject({ allow: VIEW, deny: "0" });
    expect(p.plan.operations.filter((o) => o.type.startsWith("role."))).toEqual(
      [],
    );
    // Onboarding hands out the region roles: they are recognised and untouched.
    expect(
      p.scan.roles
        .filter((r) => r.onboardingManaged)
        .map((r) => r.id)
        .sort(),
    ).toEqual([...L.ids.regionRoles].sort());
  });

  it("follows the server's naming convention for the voice channels KoolBot will create", async () => {
    const p = await h.planClaims(L.world, L.claims);
    const sets = configSets(p.plan);
    const names = [...L.world.channels.values()];
    const expected = h.detectNamingConvention(
      names.filter((x) => x.kind !== "category").map((x) => x.name),
      names.filter((x) => x.kind === "category").map((x) => x.name),
    );
    expect(expected.pattern).toBe("emoji-separator");
    expect(expected.suggestedPrefix).toBeTruthy();
    expect(sets["voicechannels.channel.prefix"]).toBe(
      expected.suggestedPrefix?.trim(),
    );
    // A channel made with that prefix reads like every other one.
    const prefix = String(sets["voicechannels.channel.prefix"]);
    const withNew = h.detectNamingConvention(
      [
        ...names.filter((x) => x.kind !== "category").map((x) => x.name),
        `${prefix} Fresh Room`,
      ],
      names.filter((x) => x.kind === "category").map((x) => x.name),
    );
    expect(withNew.pattern).toBe("emoji-separator");
    expect(withNew.confidence).toBe(1);
    // Adoption creates no channel itself.
    expect(
      p.plan.operations.some(
        (o) => /create/.test(o.type) && o.type !== "role.create",
      ),
    ).toBe(false);
  });

  it("applies, re-plans empty and rolls back, keeping the lobby's live rooms, the team channels, the booster role and every webhook", async () => {
    // Without the forum claim, which cannot be applied today (#1244, below).
    const claims = L.claims.filter((x) => x.channelId !== L.ids.feedback);
    const e = h.engine(L.world);
    const p = await h.planClaims(L.world, claims);
    const result = await e.service.apply(p.plan, h.applyOpts(L.world));
    expect(result.status).toBe("applied");
    expect(result.failed).toEqual([]);
    // One gateway write per overwrite step and four settings, nothing else.
    expect(e.writeCalls()).toHaveLength(7);
    expect(e.writeCalls().every((x) => x === "setOverwrite")).toBe(true);
    expect(e.writes.filter((w) => w.startsWith("config:"))).toHaveLength(4);

    // Permanent team channels, live temporary rooms and the booster role survive.
    expect(L.ids.teamChannels).toHaveLength(40);
    for (const id of [...L.ids.teamChannels, ...L.ids.tempRooms]) {
      expect(L.world.channels.get(id)).toEqual(
        before.channels.find((x) => x.id === id),
      );
    }
    expect(L.world.roles.get(L.ids.booster)).toEqual(
      before.roles.find((r) => r.id === L.ids.booster),
    );
    expect(
      e.writes.some((w) =>
        /deleteChannel|deleteRole|editRole|createRole/.test(w),
      ),
    ).toBe(false);
    expect(L.world.webhooks.size).toBe(13);
    expectWebhooksUntouched(L.world, before, e);

    const again = await h.planClaims(L.world, claims);
    expect(again.errors).toEqual([]);
    expect(again.plan.errors).toEqual([]);
    expect(again.plan.operations).toEqual([]);

    const back = await e.service.rollback(result.snapshotId, {
      actor: h.actorFor(L.world),
    });
    expect(back.failed).toEqual([]);
    expect(h.snapshotOf(L.world)).toEqual(before);
    expectWebhooksUntouched(L.world, before, e);
  }, 30000);

  describe("a read-only claim on the forum channel", () => {
    const forumClaim = (): Claim[] => [
      { channelId: L.ids.feedback, action: "read-only" },
    ];

    it("applies once the live read classifies the forum the way the scan does", async () => {
      // The scan reports a forum as "other". With the live read agreeing, the
      // plan applies, is idempotent and rolls back like any other.
      const e = h.engine(L.world, {
        liveKind: (type) => (type === h.T.forum ? "other" : undefined),
      });
      const p = await h.planClaims(L.world, forumClaim());
      expect(p.plan.errors).toEqual([]);
      const result = await e.service.apply(p.plan, h.applyOpts(L.world));
      expect(result.status).toBe("applied");
      expect(
        (await h.planClaims(L.world, forumClaim())).plan.operations,
      ).toEqual([]);
      await e.service.rollback(result.snapshotId, {
        actor: h.actorFor(L.world),
      });
      expect(h.snapshotOf(L.world)).toEqual(before);
    });

    // Known bug #1244: the scan calls a forum "other", the live read calls it
    // "text", and the engine refuses the plan as "changed since it was made".
    // When it is fixed this starts passing, which fails `it.failing`: make it
    // a plain `it` then.
    it.failing("applies against the real live read (#1244)", async () => {
      const e = h.engine(L.world);
      const p = await h.planClaims(L.world, forumClaim());
      const result = await e.service.apply(p.plan, h.applyOpts(L.world));
      expect(result.status).toBe("applied");
    });
  });

  it("blocks binding a per-game category whose permanent team channel cleanup could delete (#1032)", async () => {
    const team = L.ids.teamChannels[3]!;
    const cat = L.world.channels.get(team)!.parentId!;
    const risky: Claim[] = [
      { channelId: cat, action: "leave", bindKey: "voicechannels.category_id" },
    ];
    const p = await h.planClaims(L.world, risky);
    const risk = p.errors.find((x) => x.code === "voice-cleanup-risk");
    expect(risk?.message).toContain("🔊 | team-3");
    expect(h.claimsPlanIsApplicable(p)).toBe(false);
  });

  it("reuses an Onboarding role for a role group of the same name instead of creating a duplicate", async () => {
    const norway = L.world.roles.get(L.ids.regionRoles[0]!)!;
    h.harness.groups = [
      group({ id: "gn", name: norway.name, roleId: null, rank: 1 }),
    ];
    h.useWorld(L.world);
    const p = await h.planRoleGroups(
      h.guildFromWorld(L.world) as never,
      L.world.adminId,
    );
    expect(p.plan.errors).toEqual([]);
    expect(p.extraErrors).toEqual([]);
    expect(p.plan.operations.filter((o) => o.type === "role.create")).toEqual(
      [],
    );
    // The existing role is adopted by name: the only thing planned is an edit
    // of that very role, and its name is left as it is.
    expect(
      p.plan.operations.map((o) => [
        o.type,
        o.type === "role.edit" && o.roleId,
      ]),
    ).toEqual(p.plan.operations.map(() => ["role.edit", norway.id]));
    for (const o of p.plan.operations) {
      expect(o.type === "role.edit" && Object.keys(o.changes)).not.toContain(
        "name",
      );
    }

    // Even spelled differently it is matched to the existing role, never made twice.
    h.harness.groups = [
      group({
        id: "gn",
        name: norway.name.toUpperCase(),
        roleId: null,
        rank: 1,
      }),
    ];
    const loose = await h.planRoleGroups(
      h.guildFromWorld(L.world) as never,
      L.world.adminId,
    );
    expect(
      loose.plan.operations.filter((o) => o.type === "role.create"),
    ).toEqual([]);
    expect(
      loose.plan.operations.filter((o) => o.type === "role.delete"),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Role groups, end to end
// ---------------------------------------------------------------------------

describe("role groups, end to end on the reference server", () => {
  let world: World;
  let before: ReturnType<typeof h.snapshotOf>;
  const modPerms = bits(F.ManageMessages, F.MoveMembers);
  beforeEach(() => {
    world = fx.referenceServer();
    before = h.snapshotOf(world);
    h.harness.groups = [
      group({
        id: "ga",
        name: "Admin",
        roleId: "admin-role",
        rank: 5,
        permissions: h.ADMIN,
        capabilities: ["admin", "staff"],
      }),
      group({
        id: "gm",
        name: "Moderator",
        roleId: "mod-role",
        rank: 4,
        permissions: modPerms,
        capabilities: ["staff"],
      }),
      group({
        id: "gh",
        name: "Helper",
        roleId: null,
        rank: 3,
        permissions: bits(F.ManageMessages),
        capabilities: ["staff"],
      }),
      group({
        id: "gv",
        name: "VIP",
        roleId: "vip-role",
        rank: 2,
        permissions: "0",
        colour: 0xffaa00,
      }),
      group({
        id: "gb",
        name: "Bots",
        roleId: "bots-role",
        rank: 1,
        permissions: "0",
        capabilities: ["bot"],
      }),
    ];
  });
  const planGroups = async () => {
    h.useWorld(world);
    return h.planRoleGroups(h.guildFromWorld(world) as never, world.adminId);
  };

  it("plans a role create, role edits and a bot grant, and nothing else", async () => {
    const p = await planGroups();
    expect(p.plan.errors).toEqual([]);
    expect(p.extraErrors).toEqual([]);
    expect(h.planIsApplicable(p)).toBe(true);
    expect(
      p.plan.operations.map((o) => `${o.type}:${o.summary}`).sort(),
    ).toEqual([
      "member.role.add:Grant a role to 2 member(s)",
      'role.create:Create role "Helper"',
      'role.edit:Edit role "Admin"',
      'role.edit:Edit role "Moderator"',
      'role.edit:Edit role "VIP"',
    ]);
    // The bot group grants its role to the bots that lack it, never to a human
    // and never to the bot that already holds it.
    const grant = p.plan.operations.find((o) => o.type === "member.role.add")!;
    expect(grant.type === "member.role.add" && grant.memberIds.sort()).toEqual([
      "bot-music",
      "bot-picker",
    ]);
  });

  it("applies, re-plans empty, and rolls back the edits and the grant (the created role stays)", async () => {
    const e = h.engine(world);
    const p = await planGroups();
    const result = await e.service.apply(p.plan, h.applyOpts(world));
    expect(result.status).toBe("applied");
    expect(result.failed).toEqual([]);

    // Applied.
    const helper = [...world.roles.values()].find((r) => r.name === "Helper")!;
    expect(helper.permissions).toBe(bits(F.ManageMessages));
    expect(world.roles.get("mod-role")!.permissions).toBe(modPerms);
    expect(world.roles.get("vip-role")!.color).toBe(0xffaa00);
    expect(world.members.get("bot-music")!.roleIds).toContain("bots-role");
    expect(world.members.get("bot-picker")!.roleIds).toContain("bots-role");
    expect(world.members.get("u-vip")!.roleIds).toEqual(["vip-role"]);
    expect(e.writes.filter((w) => w.startsWith("addMemberRole"))).toHaveLength(
      2,
    );
    expectWebhooksUntouched(world, before, e);

    // The groups are linked to what the apply created (what `linkCreatedRoles`
    // does after a real apply), and the server then matches them.
    linkCreatedRoles(
      h.harness.groups as Array<Record<string, unknown>>,
      e.records.get(result.snapshotId)!,
    );
    const again = await planGroups();
    expect(again.plan.errors).toEqual([]);
    expect(again.plan.operations).toEqual([]);

    // Rollback restores the edits and takes the role back from the bots; the
    // role the plan created stays unless asked to be deleted.
    const back = await e.service.rollback(result.snapshotId, {
      actor: h.actorFor(world),
    });
    expect(back.failed).toEqual([]);
    expect(
      e.writes.filter((w) => w.startsWith("removeMemberRole")),
    ).toHaveLength(2);
    const after = h.snapshotOf(world);
    expect(after.members).toEqual(before.members);
    expect(after.channels).toEqual(before.channels);
    expect(after.config).toEqual(before.config);
    expect(after.roles.filter((r) => r.name !== "Helper")).toEqual(
      before.roles,
    );
    expect(after.roles.filter((r) => r.name === "Helper")).toHaveLength(1);
    expectWebhooksUntouched(world, before, e);
  });

  it("can delete the created role on rollback, leaving the exact original server", async () => {
    const e = h.engine(world);
    const p = await planGroups();
    const result = await e.service.apply(p.plan, h.applyOpts(world));
    const back = await e.service.rollback(result.snapshotId, {
      actor: h.actorFor(world),
      deleteCreatedRoles: true,
    });
    expect(back.failed).toEqual([]);
    expect(h.snapshotOf(world)).toEqual(before);
    expectWebhooksUntouched(world, before, e);
  });
});

// ---------------------------------------------------------------------------
// The rules acceptance role, end to end
// ---------------------------------------------------------------------------

describe("rules acceptance role, end to end on a large community", () => {
  let L: ReturnType<typeof fx.largeCommunity>;
  let before: ReturnType<typeof h.snapshotOf>;
  let gate: string[];
  beforeEach(() => {
    L = fx.largeCommunity();
    // The acceptance flow is live: enabled, in the rules channel, message posted.
    L.world.config.set("rules.enabled", true);
    L.world.config.set("rules.channel_id", L.ids.rules);
    L.world.config.set("rules.message_id", "msg-rules");
    before = h.snapshotOf(L.world);
    // A webhook-fed game channel, a plain one and the forum.
    gate = [h.sf("l3.ch-0-1"), h.sf("l3.ch-1-1"), L.ids.feedback];
  });
  const options = () => ({
    createRole: true,
    grantExisting: true,
    gateChannelIds: gate,
  });
  const planRules = async () => {
    h.useWorld(L.world);
    return h.planRulesGate(
      h.guildFromWorld(L.world) as never,
      L.world.adminId,
      options(),
    );
  };
  const humans = (): string[] =>
    [...L.world.members].flatMap(([id, m]) => (m.bot ? [] : [id]));

  it("plans the role, the grant, the setting and the gate in a safe order", async () => {
    const p = await planRules();
    expect(p.plan.errors).toEqual([]);
    expect(p.extraErrors).toEqual([]);
    expect(h.rulesPlanIsApplicable(p)).toBe(true);
    expect(p.preview).toEqual({
      totalMembers: 3002,
      holders: null,
      lockedOut: 0,
    });
    expect(p.plan.operations.map((o) => o.type)).toEqual([
      "role.create",
      "member.role.add",
      "config.set",
      ...Array(6).fill("overwrite.set"),
    ]);
    const grant = p.plan.operations.find((o) => o.type === "member.role.add")!;
    expect(grant.type === "member.role.add" && grant.memberCount).toBe(3002);
    expect(configSets(p.plan)).toEqual({
      "rules.role_id": "new:rules accepted",
    });
    // The rules channel is never gated.
    expect(touchedChannels(p.plan).has(L.ids.rules)).toBe(false);
    expect(touchedChannels(p.plan)).toEqual(new Set(gate));
  }, 30000);

  it("applies in pages, re-plans empty and rolls back the grant, the setting and the gate", async () => {
    const e = h.engine(L.world);
    const p = await planRules();
    const result = await e.service.apply(p.plan, {
      ...h.applyOpts(L.world),
      memberPageSize: 500,
    });
    expect(result.status).toBe("applied");
    expect(result.failed).toEqual([]);

    const created = [...L.world.roles.values()].find(
      (r) => r.name === "Rules accepted",
    )!;
    expect(L.world.config.get("rules.role_id")).toBe(created.id);
    // Every human (and no bot) holds the role: 3002 checks, 3002 grants.
    expect(
      humans().every((id) =>
        L.world.members.get(id)!.roleIds.includes(created.id),
      ),
    ).toBe(true);
    expect(
      [...L.world.members.values()].filter((m) =>
        m.roleIds.includes(created.id),
      ),
    ).toHaveLength(3002);
    expect(e.calls.filter((x) => x === "memberHasRole")).toHaveLength(3002);
    expect(e.calls.filter((x) => x === "addMemberRole")).toHaveLength(3002);
    // Each gated channel is hidden from @everyone and shown to the role.
    for (const id of gate) {
      const ow = L.world.channels.get(id)!.overwrites;
      const ev = ow.find((o) => o.id === L.ids.guild)!;
      const holder = ow.find((o) => o.id === created.id)!;
      expect(BigInt(ev.deny) & F.ViewChannel).toBe(F.ViewChannel);
      expect(BigInt(holder.allow) & F.ViewChannel).toBe(F.ViewChannel);
    }
    expectWebhooksUntouched(L.world, before, e);

    const again = await planRules();
    expect(again.plan.errors).toEqual([]);
    expect(again.extraErrors).toEqual([]);
    expect(again.plan.operations).toEqual([]);

    // Rollback revokes every grant, restores the gate and "no acceptance role
    // set", and leaves the created role in place.
    const back = await e.service.rollback(result.snapshotId, {
      actor: h.actorFor(L.world),
    });
    expect(back.failed).toEqual([]);
    expect(e.calls.filter((x) => x === "removeMemberRole")).toHaveLength(3002);
    const after = h.snapshotOf(L.world);
    expect(after.members).toEqual(before.members);
    expect(after.channels).toEqual(before.channels);
    expect(after.config).toEqual(before.config);
    expect(L.world.config.has("rules.role_id")).toBe(false);
    expect(after.roles.filter((r) => r.name !== "Rules accepted")).toEqual(
      before.roles,
    );
    expectWebhooksUntouched(L.world, before, e);
  }, 60000);

  it("deletes the created role on request, leaving the exact original server", async () => {
    const e = h.engine(L.world);
    const p = await planRules();
    const result = await e.service.apply(p.plan, h.applyOpts(L.world));
    const back = await e.service.rollback(result.snapshotId, {
      actor: h.actorFor(L.world),
      deleteCreatedRoles: true,
    });
    expect(back.failed).toEqual([]);
    expect(h.snapshotOf(L.world)).toEqual(before);
    expectWebhooksUntouched(L.world, before, e);
  }, 60000);

  it("refuses to gate without a live acceptance flow, and never plans a gate on the rules channel", async () => {
    L.world.config.set("rules.enabled", false);
    const off = await planRules();
    expect(off.extraErrors.map((x) => x.code)).toContain("acceptance-inactive");
    expect(h.rulesPlanIsApplicable(off)).toBe(false);

    L.world.config.set("rules.enabled", true);
    gate = [L.ids.rules];
    const onRules = await planRules();
    expect(onRules.extraErrors.map((x) => x.code)).toContain(
      "gate-rules-channel",
    );
    expect(h.rulesPlanIsApplicable(onRules)).toBe(false);
  }, 30000);
});

// ---------------------------------------------------------------------------
// Approved destructive steps, end to end
// ---------------------------------------------------------------------------

describe("approved destructive steps, end to end", () => {
  describe("replacing a channel's own overwrites with its category's (claims)", () => {
    let c: ReturnType<typeof fx.communityServer>;
    let before: ReturnType<typeof h.snapshotOf>;
    let claims: Claim[];
    beforeEach(() => {
      c = fx.communityServer();
      before = h.snapshotOf(c.world);
      claims = [
        ...c.claims,
        { channelId: c.ids.general, action: "sync", approveReplace: true },
      ];
    });
    const stale = () =>
      c.world.channels
        .get(c.ids.general)!
        .overwrites.find((o) => o.id === "h-gone");

    it("is refused without the admin's approval", async () => {
      const p = await h.planClaims(c.world, [
        ...c.claims,
        { channelId: c.ids.general, action: "sync" },
      ]);
      expect(p.errors.map((x) => x.code)).toEqual(["approval-required"]);
      expect(h.claimsPlanIsApplicable(p)).toBe(false);
    });

    it("plans exactly one approved removal, naming the admin and the target", async () => {
      const p = await h.planClaims(c.world, claims);
      expect(p.errors).toEqual([]);
      expect(p.plan.errors).toEqual([]);
      const removals = p.plan.operations.filter(
        (o) => o.class === "destructive",
      );
      expect(removals).toHaveLength(1);
      expect(removals[0]).toMatchObject({
        type: "overwrite.remove",
        channelId: c.ids.general,
        overwriteTargetId: "h-gone",
        approval: {
          kind: "overwrite.remove",
          targetId: `${c.ids.general}:h-gone`,
          approvedBy: c.ids.owner,
          approvedAt: h.APPROVED_AT,
        },
      });
    });

    it("needs a live-state check to run at all", async () => {
      const e = h.engine(c.world);
      const p = await h.planClaims(c.world, claims);
      await expect(
        e.service.apply(p.plan, {
          actor: h.actorFor(c.world),
          batchDelayMs: 0,
        }),
      ).rejects.toThrow(/live-state check/);
      expect(e.writeCalls()).toEqual([]);
      expect(stale()).toBeDefined();
    });

    it("applies after a live check, re-plans empty and restores the removed overwrite exactly on rollback", async () => {
      const e = h.engine(c.world);
      const p = await h.planClaims(c.world, claims);
      const result = await e.service.apply(
        p.plan,
        h.applyOpts(c.world, h.revalidatorFor(c.world, claims)),
      );
      expect(result.status).toBe("applied");
      expect(result.failed).toEqual([]);
      // The intent is on the audit trail before the removal; it ran last.
      expect(e.audits).toContain("adoption.overwrite.remove.intent:success");
      expect(e.writes.filter((w) => w.startsWith("removeOverwrite"))).toEqual([
        `removeOverwrite:${c.ids.general}:h-gone`,
      ]);
      expect(e.writes.at(-1)).toBe(`removeOverwrite:${c.ids.general}:h-gone`);
      expect(stale()).toBeUndefined();
      expectWebhooksUntouched(c.world, before, e);

      const again = await h.planClaims(c.world, claims);
      expect(again.errors).toEqual([]);
      expect(again.plan.operations).toEqual([]);

      const back = await e.service.rollback(result.snapshotId, {
        actor: h.actorFor(c.world),
      });
      expect(back.failed).toEqual([]);
      expect(back.notes).toEqual([]);
      expect(h.snapshotOf(c.world)).toEqual(before);
      expect(stale()).toEqual({
        id: "h-gone",
        type: "member",
        allow: VIEW,
        deny: "0",
      });
      expectWebhooksUntouched(c.world, before, e);
    });

    it("is refused when the overwrite changed after the preview, writing nothing", async () => {
      const e = h.engine(c.world);
      const p = await h.planClaims(c.world, claims);
      const check = h.revalidatorFor(c.world, claims);
      expect(await check(p.plan.operations)).toEqual([]);

      stale()!.allow = bits(F.ViewChannel, F.SendMessages);
      // The production live check no longer finds the previewed removal.
      const problems = await check(p.plan.operations);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("no longer matches the live server");
      await expect(
        e.service.apply(p.plan, h.applyOpts(c.world, check)),
      ).rejects.toThrow();
      expect(e.writeCalls()).toEqual([]);
      expect(stale()).toBeDefined();
    });
  });

  describe("deleting a role (role groups)", () => {
    let world: World;
    let before: ReturnType<typeof h.snapshotOf>;
    const retired = group({
      id: "gold",
      name: "Old Event",
      roleId: "retired-role",
    });
    const planDelete = (approved: boolean) => {
      h.useWorld(world);
      return h.planRoleDeletion(
        h.guildFromWorld(world) as never,
        world.adminId,
        retired as never,
        approved,
        h.APPROVED_AT,
      );
    };
    beforeEach(() => {
      world = fx.referenceServer();
      before = h.snapshotOf(world);
    });

    it("needs the admin's approval, and never deletes a managed role even with it", async () => {
      const unapproved = await planDelete(false);
      expect(unapproved.plan.errors.map((x) => x.code)).toEqual([
        "approval-required",
      ]);
      const e = h.engine(world);
      await expect(
        e.service.apply(unapproved.plan, h.applyOpts(world)),
      ).rejects.toThrow(/blocking error/);
      expect(e.writeCalls()).toEqual([]);

      h.useWorld(world);
      const managed = await h.planRoleDeletion(
        h.guildFromWorld(world) as never,
        world.adminId,
        group({ id: "gcarl", name: "Music Bot", roleId: "carl" }) as never,
        true,
        h.APPROVED_AT,
      );
      expect(managed.plan.errors.map((x) => x.code)).toEqual([
        "role-protected",
      ]);
    });

    it("deletes after a live check and rolls back by recreating the role, which says what it cannot restore", async () => {
      const e = h.engine(world);
      const p = await planDelete(true);
      expect(p.plan.errors).toEqual([]);
      expect(p.plan.operations.map((o) => [o.type, o.class])).toEqual([
        ["role.delete", "destructive"],
      ]);
      const revalidate = h.roleDeletionRevalidator(
        h.guildFromWorld(world) as never,
        world.adminId,
        retired as never,
        true,
        h.APPROVED_AT,
      );
      const result = await e.service.apply(
        p.plan,
        h.applyOpts(world, revalidate),
      );
      expect(result.status).toBe("applied");
      expect(world.roles.has("retired-role")).toBe(false);
      expect(world.members.get("u-old")!.roleIds).toEqual([]);
      expect(e.audits).toContain("adoption.role.delete.intent:success");
      expectWebhooksUntouched(world, before, e);

      const back = await e.service.rollback(result.snapshotId, {
        actor: h.actorFor(world),
      });
      expect(back.failed).toEqual([]);
      // The role is back with its structure but a new id, and without its members.
      const restored = [...world.roles.values()].find(
        (r) => r.name === "Old Event",
      )!;
      expect(restored.id).not.toBe("retired-role");
      const original = before.roles.find((r) => r.id === "retired-role")!;
      expect({ ...restored, id: original.id }).toEqual(original);
      expect(world.members.get("u-old")!.roleIds).toEqual([]);
      expect(back.notes.join(" ")).toContain("role memberships");
      expect(back.notes.join(" ")).toContain("webhooks");
      expectWebhooksUntouched(world, before, e);
    });

    it("ignores an approval that someone other than the planning admin gave", () => {
      const p = h.planAdoption(
        h.scanHand(world),
        {
          deletions: [{ kind: "role", id: "retired-role" }],
          approvals: [
            {
              kind: "role.delete",
              targetId: "retired-role",
              approvedBy: "u-mod",
              approvedAt: h.APPROVED_AT,
            },
          ],
        },
        { approverId: world.adminId },
      );
      expect(p.errors.map((x) => x.code)).toEqual(["approval-required"]);
      expect(p.operations).toEqual([]);
    });

    it("is refused when the role came into use after the preview, deleting nothing", async () => {
      const e = h.engine(world);
      const p = await planDelete(true);
      h.harness.roleUses = ["birthdays"];
      const revalidate = h.roleDeletionRevalidator(
        h.guildFromWorld(world) as never,
        world.adminId,
        retired as never,
        true,
        h.APPROVED_AT,
      );
      await expect(
        e.service.apply(p.plan, h.applyOpts(world, revalidate)),
      ).rejects.toThrow(/Live check failed/);
      expect(e.writeCalls()).toEqual([]);
      expect(world.roles.has("retired-role")).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// The webhook guard itself
// ---------------------------------------------------------------------------

describe("webhook guard", () => {
  it("can fail: deleting a webhook-fed channel takes its webhooks with it, and a rollback does not bring them back", async () => {
    // Not a product path (no production planner deletes a channel); it shows
    // the assertions above would catch a change that reached a webhook.
    const world = fx.referenceServer();
    const before = h.snapshotOf(world);
    const scanned = h.scanHand(world);
    const plan = h.planAdoption(
      scanned,
      {
        deletions: [{ kind: "channel", id: "news" }],
        approvals: [
          {
            kind: "channel.delete",
            targetId: "news",
            approvedBy: "admin",
            approvedAt: h.APPROVED_AT,
          },
        ],
      },
      { approverId: "admin" },
    );
    expect(plan.errors).toEqual([]);
    const e = h.engine(world);
    const result = await e.service.apply(plan, h.applyOpts(world));
    expect(result.status).toBe("applied");
    expect(world.webhooks.has("wh-news")).toBe(false);
    expect(() => expectWebhooksUntouched(world, before, e)).toThrow();

    await e.service.rollback(result.snapshotId, { actor: h.actorFor(world) });
    expect(world.channels.get("news")).toEqual(
      before.channels.find((x) => x.id === "news"),
    );
    expect(world.webhooks.has("wh-news")).toBe(false);
  });

  it("rejects a gateway call that is not modelled", () => {
    const world = fx.referenceServer();
    const e = h.engine(world);
    const gateway = (
      e.service as unknown as { deps: { gateway: Record<string, unknown> } }
    ).deps.gateway;
    expect(() => gateway["deleteWebhook"]).toThrow(/not modelled/);
    expect([...e.accessed]).toEqual(["deleteWebhook"]);
  });
});
