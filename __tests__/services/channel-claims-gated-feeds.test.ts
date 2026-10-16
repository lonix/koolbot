import { describe, it, expect } from "@jest/globals";
import { ChannelType, PermissionsBitField } from "discord.js";
import {
  buildClaimsDesiredState,
  splitIssues,
  type ChannelClaim,
  type ClaimContext,
} from "../../src/services/channel-claims.js";
import {
  DEFAULT_PAIR_EMOJI,
  detectFeeds,
  detectRolePairings,
  isValidPickerEmoji,
} from "../../src/services/channel-claims-suggestions.js";
import {
  acceptAllPairs,
  claimsForRevalidation,
} from "../../src/services/channel-claims-adoption.js";
import { claimsFromForm } from "../../src/services/channel-claims-form.js";
import {
  permissionNames,
  planAdoption,
  type AdoptionPlan,
  type ChannelState,
  type OverwriteState,
  type PlanOperation,
  type ScannedState,
} from "../../src/services/server-adoption-planner.js";
import { bitsOf } from "../../src/utils/channel-permissions.js";
import type { GroupSpec } from "../../src/services/role-group-plan.js";
import type { ServerScan } from "../../src/services/server-scan-service.js";

/**
 * Pure planner tests for the adoption claims added in the "gated pairings and
 * feeds" slice of #1022: role-gated categories registered as game roles, the
 * webhook / followed-channel feed suggestion, stage speaker gating and the
 * unsynced-child warning. None of it touches Discord or the database.
 */

const F = PermissionsBitField.Flags;
const GUILD = "100000000000000000";
const BOT = "100000000000000001";
const ADMIN = "100000000000000002";
const OTHER_BOT = "100000000000000003";
const R_ADMIN = "200000000000000001";
const R_GAME = "200000000000000002";
const R_DANGER = "200000000000000003";
const R_BOOST = "200000000000000004";
const R_KOOL = "200000000000000005";
const R_INTEG = "200000000000000006";
const R_HIGH = "200000000000000007";
const R_GAME2 = "200000000000000008";
const R_GROUP = "200000000000000009";
const R_VIEW = "200000000000000010";
const CAT_GAME = "300000000000000001";
const CAT_DANGER = "300000000000000002";
const CAT_TWO = "300000000000000003";
const CAT_BOOST = "300000000000000004";
const CAT_HIGH = "300000000000000005";
const CAT_PLAIN = "300000000000000006";
const CAT_GROUP = "300000000000000007";
const CAT_DONE = "300000000000000008";
const FEED = "300000000000000010";
const FOLLOW = "300000000000000011";
const APP_ONLY = "300000000000000012";
const STAGE = "300000000000000013";
const LEAKY = "300000000000000014";
const PICKER = "300000000000000099";

const role = (id: string, position: number, over = {}) => ({
  id,
  name: `role-${id.slice(-2)}`,
  color: 0,
  permissions: "0",
  position,
  managed: false,
  ...over,
});

const ow = (
  id: string,
  allow: bigint = 0n,
  deny: bigint = 0n,
  type: "role" | "member" = "role",
): OverwriteState => ({
  id,
  type,
  allow: allow.toString(),
  deny: deny.toString(),
});

const chan = (id: string, over: Partial<ChannelState> = {}): ChannelState => ({
  id,
  name: `chan-${id.slice(-2)}`,
  kind: "text",
  rawType: ChannelType.GuildText,
  parentId: null,
  position: 0,
  topic: null,
  overwrites: [],
  voiceMemberCount: 0,
  ...over,
});

const category = (id: string, overwrites: OverwriteState[]): ChannelState =>
  chan(id, {
    kind: "category",
    rawType: ChannelType.GuildCategory,
    overwrites,
  });

const gated = (...allowed: string[]): OverwriteState[] => [
  ow(GUILD, 0n, F.ViewChannel),
  ...allowed.map((id) => ow(id, F.ViewChannel)),
];

function fixture(over: Partial<ScannedState> = {}): ScannedState {
  return {
    guildId: GUILD,
    ownerId: "owner",
    botUserId: BOT,
    botRoleIds: [R_KOOL],
    botHighestRolePosition: 50,
    adminUserId: ADMIN,
    adminRoleIds: [R_ADMIN],
    otherBotIds: [OTHER_BOT],
    roles: [
      role(GUILD, 0, { permissions: bitsOf(["ViewChannel", "SendMessages"]) }),
      role(R_ADMIN, 30, { permissions: bitsOf(["ManageGuild"]) }),
      role(R_GAME, 10),
      role(R_GAME2, 11),
      role(R_DANGER, 12, { permissions: bitsOf(["Administrator"]) }),
      role(R_BOOST, 5, { managed: true }),
      role(R_KOOL, 50, { permissions: PermissionsBitField.All.toString() }),
      role(R_INTEG, 6, { managed: true }),
      role(R_HIGH, 60),
      role(R_GROUP, 13),
      role(R_VIEW, 14),
    ],
    channels: [
      // The reference-server pattern: gated by one role; another bot keeps a
      // member overwrite of its own on the category.
      category(CAT_GAME, [
        ...gated(R_GAME),
        ow(OTHER_BOT, F.ViewChannel | F.ManageChannels, 0n, "member"),
        ow(R_INTEG, F.ViewChannel),
      ]),
      category(CAT_DANGER, gated(R_DANGER)),
      category(CAT_TWO, gated(R_GAME2, R_VIEW)),
      category(CAT_BOOST, gated(R_BOOST)),
      category(CAT_HIGH, gated(R_HIGH)),
      category(CAT_PLAIN, []),
      category(CAT_GROUP, gated(R_GROUP)),
      category(CAT_DONE, gated(R_VIEW)),
      chan(FEED, {
        parentId: CAT_GAME,
        overwrites: [ow(OTHER_BOT, F.SendMessages, 0n, "member")],
      }),
      chan(FOLLOW, {
        parentId: CAT_GAME,
        rawType: ChannelType.GuildAnnouncement,
      }),
      chan(APP_ONLY, { parentId: CAT_GAME }),
      chan(STAGE, {
        parentId: CAT_PLAIN,
        kind: "voice",
        rawType: ChannelType.GuildStageVoice,
        overwrites: [ow(OTHER_BOT, F.Connect, 0n, "member")],
      }),
      chan(LEAKY, {
        parentId: CAT_GAME,
        overwrites: [ow(GUILD, F.ViewChannel)],
      }),
      chan(PICKER),
    ],
    config: { "reactionroles.message_channel_id": PICKER },
    boundChannelIds: [],
    koolbotCreatedIds: [],
    ...over,
  };
}

const groups: GroupSpec[] = [
  {
    id: "g-staff",
    name: "Staff",
    roleId: R_GROUP,
    rank: 5,
    permissions: null,
    capabilities: [],
    colour: null,
    createdByKoolbot: false,
    gateOnly: false,
  },
];

/** The scan the suggestions read, derived from the planner's scanned state. */
function scanOf(
  scanned: ScannedState,
  webhooks: ServerScan["webhooks"] = {
    known: true,
    unavailable: null,
    list: [
      { id: "w1", name: "bridge", channelId: FEED, kind: "incoming" },
      { id: "w2", name: "news", channelId: FOLLOW, kind: "channel-follower" },
      { id: "w3", name: "bot", channelId: APP_ONLY, kind: "application" },
    ],
  },
  usedBy: Record<string, string[]> = { [R_VIEW]: [] },
): ServerScan {
  const names = (bits: string): string[] => permissionNames(bits);
  return {
    guildId: scanned.guildId,
    scanned,
    webhooks,
    roles: scanned.roles.map((r) => ({
      id: r.id,
      name: r.name,
      managed: r.managed,
      botId: r.id === R_INTEG || r.id === R_KOOL ? "bot" : null,
      usedBy: usedBy[r.id] ?? [],
    })),
    channels: scanned.channels.map((c) => ({
      id: c.id,
      name: c.name,
      kind: c.kind,
      parentId: c.parentId,
      flags: { forum: false },
      overwrites: c.overwrites.map((o) => ({
        id: o.id,
        type: o.type,
        allow: names(o.allow),
        deny: names(o.deny),
      })),
    })),
  } as unknown as ServerScan;
}

function plan(
  claims: ChannelClaim[],
  opts: {
    scanned?: ScannedState;
    scan?: ServerScan;
    synced?: Array<[string, boolean | null]>;
  } = {},
): {
  plan: AdoptionPlan;
  built: ReturnType<typeof buildClaimsDesiredState>;
  errors: string[];
  warnings: string[];
} {
  const scanned = opts.scanned ?? fixture();
  const scan = opts.scan ?? scanOf(scanned);
  const ctx: ClaimContext = {
    scanned,
    groups,
    integrationRoleIds: new Set([R_INTEG]),
    syncedToParent: new Map(opts.synced ?? []),
    membersIntent: true,
    suggestedPrefix: null,
    pairings: new Map(
      detectRolePairings(scan, groups).map((p) => [p.categoryId, p]),
    ),
    feeds: detectFeeds(scan),
    approvedAt: "2026-01-01T00:00:00.000Z",
  };
  const built = buildClaimsDesiredState(claims, ctx);
  const p = planAdoption(scanned, built.desired, {
    approverId: ADMIN,
    gateTargetIds: built.gateTargetIds,
  });
  const { errors, warnings } = splitIssues(built.issues);
  return {
    plan: p,
    built,
    errors: [...p.errors.map((e) => e.code), ...errors.map((e) => e.code)],
    warnings: warnings.map((w) => w.code),
  };
}

const sets = (p: AdoptionPlan) =>
  p.operations.flatMap((o) => (o.type === "overwrite.set" ? [o] : []));
const setFor = (p: AdoptionPlan, channelId: string, target: string) =>
  sets(p).find(
    (o) => o.channelId === channelId && o.overwriteTargetId === target,
  );
const pair = (channelId: string, pairEmoji?: string): ChannelClaim => ({
  channelId,
  action: "leave",
  registerPairing: true,
  ...(pairEmoji ? { pairEmoji } : {}),
});

describe("detecting role-gated categories", () => {
  const found = (over: Partial<ScannedState> = {}) =>
    detectRolePairings(scanOf(fixture(over)), groups);

  it("proposes a category hidden from @everyone and visible to exactly one role", () => {
    const game = found().find((p) => p.categoryId === CAT_GAME)!;
    expect(game).toMatchObject({ roleId: R_GAME, state: "proposed" });
    // The other bot's integration role and member overwrite are not counted.
  });

  it("does not propose an ungated category or one with two gating roles", () => {
    const ids = found().map((p) => p.categoryId);
    expect(ids).not.toContain(CAT_PLAIN);
    expect(ids).not.toContain(CAT_TWO);
  });

  it("refuses, and says why, for Administrator, managed, group-backed and too-high roles", () => {
    const by = (id: string) => found().find((p) => p.categoryId === id)!;
    expect(by(CAT_DANGER)).toMatchObject({ state: "refused" });
    expect(by(CAT_DANGER).reason).toContain("Administrator");
    expect(by(CAT_BOOST).reason).toContain("managed");
    expect(by(CAT_GROUP).reason).toContain("role group");
    expect(by(CAT_HIGH).reason).toContain("highest role");
  });

  it("refuses a role whose category overwrite grants Manage Channels or Webhooks", () => {
    const scanned = fixture();
    scanned.channels.find((c) => c.id === CAT_GAME)!.overwrites = [
      ow(GUILD, 0n, F.ViewChannel),
      ow(R_GAME, F.ViewChannel | F.ManageChannels),
    ];
    const pairing = detectRolePairings(scanOf(scanned), groups).find(
      (p) => p.categoryId === CAT_GAME,
    )!;
    expect(pairing.state).toBe("refused");
    expect(pairing.reason).toContain("ManageChannels");
    expect(pairing.reason).toContain("its own overwrite");
    const r = plan([pair(CAT_GAME)], { scanned });
    expect(r.errors).toContain("pairing-refused");
    expect(r.plan.operations).toHaveLength(0);
  });

  it("the planner refuses a dangerous category overwrite, including one the same plan adds", () => {
    const scanned = fixture();
    scanned.channels.find((c) => c.id === CAT_GAME)!.overwrites = [
      ow(GUILD, 0n, F.ViewChannel),
      ow(R_GAME, F.ViewChannel | F.ManageWebhooks),
    ];
    const existing = planAdoption(scanned, {
      reactionRoles: [{ roleId: R_GAME, categoryId: CAT_GAME, emoji: "🎮" }],
    });
    expect(existing.errors.map((e) => e.code)).toEqual(["role-unsafe"]);
    expect(existing.errors[0].message).toContain("ManageWebhooks");
    const added = planAdoption(fixture(), {
      overwrites: [
        {
          channelId: CAT_GAME,
          target: { id: R_GAME },
          allow: (F.ViewChannel | F.ManageChannels).toString(),
          deny: "0",
        },
      ],
      reactionRoles: [{ roleId: R_GAME, categoryId: CAT_GAME, emoji: "🎮" }],
    });
    expect(added.errors.map((e) => e.code)).toContain("role-unsafe");
  });

  it("refuses a role whose overwrite on an unsynced child channel grants Manage Channels", () => {
    const scanned = fixture();
    scanned.channels.find((c) => c.id === LEAKY)!.overwrites = [
      ow(R_GAME, F.ViewChannel | F.ManageChannels),
    ];
    const pairing = detectRolePairings(scanOf(scanned), groups).find(
      (p) => p.categoryId === CAT_GAME,
    )!;
    expect(pairing.state).toBe("refused");
    expect(pairing.reason).toContain("ManageChannels");
    expect(pairing.reason).toContain(`chan-${LEAKY.slice(-2)}`);
    const direct = planAdoption(scanned, {
      reactionRoles: [{ roleId: R_GAME, categoryId: CAT_GAME, emoji: "🎮" }],
    });
    expect(direct.errors.map((e) => e.code)).toEqual(["role-unsafe"]);
    // A plan that adds the grant to a child is refused too.
    const added = planAdoption(fixture(), {
      overwrites: [
        {
          channelId: LEAKY,
          target: { id: R_GAME },
          allow: (F.ViewChannel | F.ManageWebhooks).toString(),
          deny: "0",
        },
      ],
      reactionRoles: [{ roleId: R_GAME, categoryId: CAT_GAME, emoji: "🎮" }],
    });
    expect(added.errors.map((e) => e.code)).toContain("role-unsafe");
  });

  it("a role KoolBot holds still gates a category; only integration roles are ignored", () => {
    const scanned = fixture({ botRoleIds: [R_KOOL, R_GAME] });
    const found = detectRolePairings(scanOf(scanned), groups);
    expect(found.find((p) => p.categoryId === CAT_GAME)).toMatchObject({
      roleId: R_GAME,
      state: "proposed",
    });
    // The two-role category stays ambiguous when the bot holds one of them.
    const two = fixture({ botRoleIds: [R_KOOL, R_GAME2] });
    expect(
      detectRolePairings(scanOf(two), groups).map((p) => p.categoryId),
    ).not.toContain(CAT_TWO);
  });

  it("marks a role that is already a reaction role instead of proposing it again", () => {
    const scanned = fixture();
    const scan = scanOf(scanned, undefined, { [R_VIEW]: ["reactionroles"] });
    const done = detectRolePairings(scan, groups).find(
      (p) => p.categoryId === CAT_DONE,
    )!;
    expect(done.state).toBe("registered");
  });

  it("validates picker emoji", () => {
    for (const ok of ["🎮", "<:valorant:123456789012345678>", "1️⃣", "🇳🇴"]) {
      expect(isValidPickerEmoji(ok)).toBe(true);
    }
    for (const bad of ["", "abc", "<script>", ":game:", "x".repeat(70)]) {
      expect(isValidPickerEmoji(bad)).toBe(false);
    }
  });
});

describe("registering a gated category as a game role", () => {
  it("plans one registration and nothing else: no role, channel, overwrite or webhook step", () => {
    const r = plan([pair(CAT_GAME, "🎯")]);
    expect(r.errors).toEqual([]);
    expect(r.plan.operations).toHaveLength(1);
    expect(r.plan.operations[0]).toMatchObject({
      type: "reactionrole.register",
      class: "additive",
      roleId: R_GAME,
      categoryId: CAT_GAME,
      emoji: "🎯",
    });
    expect(r.built.desired.overwrites).toEqual([]);
  });

  it("preserves another bot's overwrites and the integration role on the category", () => {
    const r = plan([pair(CAT_GAME)]);
    expect(setFor(r.plan, CAT_GAME, OTHER_BOT)).toBeUndefined();
    expect(setFor(r.plan, CAT_GAME, R_INTEG)).toBeUndefined();
    expect(r.plan.operations.some((o) => o.type === "overwrite.remove")).toBe(
      false,
    );
  });

  it("uses the default emoji when none is given and refuses an invalid one", () => {
    expect(plan([pair(CAT_GAME)]).built.desired.reactionRoles?.[0].emoji).toBe(
      DEFAULT_PAIR_EMOJI,
    );
    expect(plan([pair(CAT_GAME, "nope")]).errors).toContain("invalid-emoji");
  });

  it("refuses a role with Administrator and names the reason", () => {
    const r = plan([pair(CAT_DANGER)]);
    expect(r.errors).toContain("pairing-refused");
    expect(r.plan.operations).toHaveLength(0);
    expect(
      splitIssues(r.built.issues).errors.find(
        (e) => e.code === "pairing-refused",
      )!.message,
    ).toContain("Administrator");
  });

  it("refuses managed, group-backed and too-high roles", () => {
    for (const cat of [CAT_BOOST, CAT_GROUP, CAT_HIGH]) {
      const r = plan([pair(cat)]);
      expect(r.errors).toContain("pairing-refused");
      expect(r.plan.operations).toHaveLength(0);
    }
  });

  it("the planner itself refuses a dangerous role, whatever the caller checked", () => {
    const scanned = fixture();
    const p = planAdoption(scanned, {
      reactionRoles: [
        { roleId: R_DANGER, categoryId: CAT_DANGER, emoji: "🎮" },
        { roleId: R_BOOST, categoryId: CAT_BOOST, emoji: "🎮" },
        { roleId: R_HIGH, categoryId: CAT_HIGH, emoji: "🎮" },
        { roleId: GUILD, categoryId: CAT_GAME, emoji: "🎮" },
      ],
    });
    expect(p.errors.map((e) => e.code)).toEqual([
      "role-unsafe",
      "role-unsafe",
      "role-unsafe",
      "role-unsafe",
    ]);
    expect(p.errors[0].message).toContain("Administrator");
    expect(p.operations).toHaveLength(0);
  });

  it("needs the reaction-role message channel and a category", () => {
    const noChannel = fixture({ config: {} });
    expect(plan([pair(CAT_GAME)], { scanned: noChannel }).errors).toContain(
      "reactionroles-channel-missing",
    );
    const p = planAdoption(fixture(), {
      reactionRoles: [{ roleId: R_GAME, categoryId: PICKER, emoji: "🎮" }],
    });
    expect(p.errors.map((e) => e.code)).toContain("unknown-channel");
  });

  it("refuses something that isn't a detected pairing, and a role registered twice", () => {
    expect(plan([pair(CAT_PLAIN)]).errors).toContain("not-a-pairing");
    expect(plan([pair(PICKER)]).errors).toContain("not-a-pairing");
    const twice = planAdoption(fixture(), {
      reactionRoles: [
        { roleId: R_GAME, categoryId: CAT_GAME, emoji: "🎮" },
        { roleId: R_GAME, categoryId: CAT_TWO, emoji: "🎮" },
      ],
    });
    expect(twice.errors.map((e) => e.code)).toContain("duplicate-pairing");
  });

  it("already-registered roles produce a note and no step", () => {
    const scanned = fixture();
    const scan = scanOf(scanned, undefined, { [R_VIEW]: ["reactionroles"] });
    const r = plan([pair(CAT_DONE)], { scanned, scan });
    expect(r.plan.operations).toHaveLength(0);
    expect(r.warnings).toContain("pairing-already-registered");
  });

  it("warns, without blocking, that reaction roles are off", () => {
    expect(plan([pair(CAT_GAME)]).warnings).toEqual(
      expect.arrayContaining(["pairing-picker", "reactionroles-disabled"]),
    );
    const on = fixture({
      config: {
        "reactionroles.message_channel_id": PICKER,
        "reactionroles.enabled": true,
      },
    });
    expect(plan([pair(CAT_GAME)], { scanned: on }).warnings).not.toContain(
      "reactionroles-disabled",
    );
  });

  it("warns when a channel that isn't synced still shows through the gate", () => {
    const r = plan([pair(CAT_GAME)]);
    expect(r.warnings).toContain("gate-child-not-gated");
  });

  it("accept-all adds every proposed pair, never a refused or registered one, and merges", () => {
    const scan = scanOf(fixture());
    const all = acceptAllPairs(
      [{ channelId: CAT_GAME, action: "read-only" }],
      detectRolePairings(scan, groups),
      { [CAT_GAME]: "🎯" },
    );
    const ids = all.map((c) => c.channelId);
    // CAT_GAME keeps its own claim and gains the pairing; CAT_DONE is the only
    // other proposed pair (R_VIEW isn't a reaction role here).
    expect(all.find((c) => c.channelId === CAT_GAME)).toMatchObject({
      action: "read-only",
      registerPairing: true,
    });
    expect(ids).toContain(CAT_DONE);
    for (const refused of [
      CAT_DANGER,
      CAT_BOOST,
      CAT_GROUP,
      CAT_HIGH,
      CAT_TWO,
    ]) {
      expect(ids).not.toContain(refused);
    }
    expect(plan(all).errors).toEqual([]);
  });

  it("reads the pairing from the form, never a role id", () => {
    const parsed = claimsFromForm(
      {
        [`pair_${CAT_GAME}`]: "1",
        [`pairemoji_${CAT_GAME}`]: "🎯",
        [`roles_${CAT_GAME}`]: R_DANGER,
      },
      [{ id: CAT_GAME, kind: "category", parentId: null }],
    );
    expect(parsed.claims[0]).toMatchObject({
      channelId: CAT_GAME,
      registerPairing: true,
      pairEmoji: "🎯",
    });
    // The role comes from the scan: choosing another one changes nothing.
    const r = plan(parsed.claims);
    expect(r.built.desired.reactionRoles?.[0].roleId).toBe(R_GAME);
  });
});

describe("webhook and followed-channel feeds", () => {
  const feed = (channelId: string): ChannelClaim => ({
    channelId,
    action: "read-only",
    allowReactions: true,
    feed: true,
  });

  it("detects incoming webhooks and followed channels, not application webhooks", () => {
    const d = detectFeeds(scanOf(fixture()));
    expect(d.known).toBe(true);
    expect(d.feeds.map((f) => f.channelId).sort()).toEqual([FEED, FOLLOW]);
  });

  it("makes a feed read-only for everyone and touches no webhook or other bot's overwrite", () => {
    const r = plan([feed(FEED)]);
    expect(r.errors).toEqual([]);
    for (const op of r.plan.operations) {
      expect(op.type).toBe("overwrite.set");
    }
    const everyone = setFor(r.plan, FEED, GUILD)!;
    expect(BigInt(everyone.deny) & F.SendMessages).toBe(F.SendMessages);
    expect(BigInt(everyone.deny) & F.AddReactions).toBe(0n);
    // The other bot's overwrite on the channel is preserved.
    expect(setFor(r.plan, FEED, OTHER_BOT)).toBeUndefined();
    expect(r.warnings).toContain("feed-preserved");
  });

  it("a followed announcement channel is a feed too", () => {
    const r = plan([feed(FOLLOW)]);
    expect(r.errors).toEqual([]);
    expect(setFor(r.plan, FOLLOW, GUILD)).toBeDefined();
  });

  it("suggests nothing and refuses when the webhook data is unavailable", () => {
    const scanned = fixture();
    const scan = scanOf(scanned, {
      known: false,
      unavailable: "missing-permission",
      list: [],
    });
    const d = detectFeeds(scan);
    expect(d).toEqual({
      known: false,
      unavailable: "missing-permission",
      feeds: [],
    });
    const r = plan([feed(FEED)], { scanned, scan });
    expect(r.errors).toContain("feed-data-unavailable");
    expect(r.plan.operations).toHaveLength(0);
  });

  it("refuses a channel that is not fed, including one with only an application webhook", () => {
    expect(plan([feed(APP_ONLY)]).errors).toContain("not-a-feed");
    expect(plan([feed(PICKER)]).errors).toContain("not-a-feed");
  });

  it("flags a feed that is visible through its own overwrite in a gated category", () => {
    const scanned = fixture();
    scanned.channels
      .find((c) => c.id === FEED)!
      .overwrites.push(ow(GUILD, F.ViewChannel));
    expect(plan([feed(FEED)], { scanned }).warnings).toContain(
      "feed-not-gated",
    );
  });

  it("a feed keeps reactions open whether Read-only was chosen or left alone", () => {
    for (const action of ["read-only", "leave"]) {
      const parsed = claimsFromForm(
        { [`feed_${FEED}`]: "1", [`action_${FEED}`]: action },
        [{ id: FEED, kind: "other", parentId: CAT_GAME }],
      );
      expect(parsed.claims[0]).toMatchObject({
        action: "read-only",
        allowReactions: true,
      });
      const r = plan(parsed.claims);
      expect(BigInt(setFor(r.plan, FEED, GUILD)!.deny) & F.AddReactions).toBe(
        0n,
      );
    }
  });

  it("the form turns a feed tick on an untouched channel into read-only with reactions open", () => {
    const parsed = claimsFromForm({ [`feed_${FEED}`]: "1" }, [
      { id: FEED, kind: "other", parentId: CAT_GAME },
    ]);
    expect(parsed.claims[0]).toMatchObject({
      action: "read-only",
      allowReactions: true,
      feed: true,
    });
  });

  it("read-only on a feed never reveals a hidden channel or removes the admin's access", () => {
    const r = plan([feed(FEED)]);
    expect(r.errors).not.toContain("admin-access-lost");
    expect(BigInt(setFor(r.plan, FEED, GUILD)!.allow) & F.ViewChannel).toBe(0n);
  });
});

describe("stage speakers and unsynced children", () => {
  it("gates who can speak apart from who can see, and keeps the bot's access", () => {
    const r = plan(
      [
        {
          channelId: STAGE,
          action: "gate",
          roleIds: [R_GAME, R_ADMIN],
          speakerRoleIds: [R_ADMIN],
        },
      ],
      { synced: [[STAGE, false]] },
    );
    expect(r.errors).toEqual([]);
    expect(r.warnings).toContain("stage-moderators");
    const everyone = setFor(r.plan, STAGE, GUILD)!;
    expect(BigInt(everyone.deny) & F.RequestToSpeak).toBe(F.RequestToSpeak);
    expect(BigInt(everyone.deny) & F.ViewChannel).toBe(F.ViewChannel);
    const speaker = setFor(r.plan, STAGE, R_ADMIN)!;
    expect(BigInt(speaker.allow) & F.RequestToSpeak).toBe(F.RequestToSpeak);
    const viewer = setFor(r.plan, STAGE, R_GAME)!;
    expect(BigInt(viewer.allow) & F.ViewChannel).toBe(F.ViewChannel);
    expect(BigInt(viewer.deny) & F.RequestToSpeak).toBe(F.RequestToSpeak);
    const bot = setFor(r.plan, STAGE, BOT)!;
    expect(BigInt(bot.allow) & (F.ViewChannel | F.Connect)).toBe(
      F.ViewChannel | F.Connect,
    );
    // Another bot's overwrite on the stage is preserved.
    expect(setFor(r.plan, STAGE, OTHER_BOT)).toBeUndefined();
  });

  it("speakers are also let in, even when only chosen as speakers", () => {
    const r = plan([
      {
        channelId: STAGE,
        action: "gate",
        roleIds: [R_ADMIN],
        speakerRoleIds: [R_GAME],
      },
    ]);
    expect(
      BigInt(setFor(r.plan, STAGE, R_GAME)!.allow) &
        (F.ViewChannel | F.Connect),
    ).toBe(F.ViewChannel | F.Connect);
  });

  it("still refuses a stage gate that would lock the admin out", () => {
    const r = plan([
      {
        channelId: STAGE,
        action: "gate",
        roleIds: [R_GAME],
        speakerRoleIds: [R_GAME],
      },
    ]);
    expect(r.errors).toContain("admin-access-lost");
  });

  it("refuses a managed integration role as a speaker", () => {
    const r = plan([
      {
        channelId: STAGE,
        action: "gate",
        roleIds: [R_GAME],
        speakerRoleIds: [R_INTEG],
      },
    ]);
    expect(r.errors).toContain("other-bot-overwrite");
  });

  it("warns when a channel that isn't synced to a gated category lets @everyone in", () => {
    const r = plan(
      [{ channelId: CAT_PLAIN, action: "gate", roleIds: [R_ADMIN, R_GAME] }],
      { synced: [[STAGE, false]] },
    );
    expect(r.errors).toEqual([]);
    // The stage's own overwrites don't allow @everyone, so nothing to flag.
    expect(r.warnings).not.toContain("gate-child-not-gated");
    const scanned = fixture();
    scanned.channels
      .find((c) => c.id === STAGE)!
      .overwrites.push(ow(GUILD, F.Connect));
    const leaky = plan(
      [{ channelId: CAT_PLAIN, action: "gate", roleIds: [R_ADMIN, R_GAME] }],
      { scanned, synced: [[STAGE, false]] },
    );
    expect(leaky.warnings).toContain("gate-child-not-gated");
  });
});

describe("leave alone stays the default", () => {
  it("plans nothing without a pairing or feed claim, whatever the scan detects", () => {
    const r = plan([]);
    expect(r.plan.operations).toHaveLength(0);
    expect(r.built.desired.reactionRoles).toBeUndefined();
  });

  it("a pairing or feed claim is not dropped as a no-op by the form", () => {
    const channels = [
      { id: CAT_GAME, kind: "category", parentId: null },
      { id: FEED, kind: "other", parentId: CAT_GAME },
    ];
    expect(claimsFromForm({}, channels).claims).toEqual([]);
    expect(
      claimsFromForm({ [`pair_${CAT_GAME}`]: "1" }, channels).claims,
    ).toHaveLength(1);
  });
});

describe("review findings on feeds, stage speakers and register-all", () => {
  it("refuses a feed combined with a gate instead of silently applying only the gate", () => {
    const r = plan([
      { channelId: FEED, action: "gate", roleIds: [R_ADMIN], feed: true },
    ]);
    expect(r.errors).toContain("feed-needs-read-only");
    expect(r.plan.operations).toHaveLength(0);
    const parsed = claimsFromForm(
      { [`feed_${FEED}`]: "1", [`action_${FEED}`]: "gate" },
      [{ id: FEED, kind: "other", parentId: CAT_GAME }],
    );
    expect(parsed.claims[0]).toMatchObject({ action: "gate", feed: true });
    expect(plan(parsed.claims).errors).toContain("feed-needs-read-only");
    // Read-only plus feed (the supported combination) still works.
    expect(
      plan([{ channelId: FEED, action: "read-only", feed: true }]).errors,
    ).toEqual([]);
  });

  it("reports a preserved RequestToSpeak allow instead of promising exclusive speakers", () => {
    const scanned = fixture();
    scanned.channels
      .find((c) => c.id === STAGE)!
      .overwrites.push(ow(R_VIEW, F.RequestToSpeak));
    const r = plan(
      [
        {
          channelId: STAGE,
          action: "gate",
          roleIds: [R_GAME, R_ADMIN],
          speakerRoleIds: [R_ADMIN],
        },
      ],
      { scanned },
    );
    expect(r.errors).toEqual([]);
    expect(r.warnings).toContain("speak-not-exclusive");
    const warning = r.built.issues.find(
      (i) => i.code === "speak-not-exclusive",
    )!;
    expect(warning.message).toContain("can still request to speak");
    expect(warning.message).toContain("@role-10");
    // The exception is kept as it is, and the other bot's overwrite untouched.
    expect(setFor(r.plan, STAGE, R_VIEW)).toBeUndefined();
    expect(setFor(r.plan, STAGE, OTHER_BOT)).toBeUndefined();
  });

  it("no speaker warning when nothing else allows requesting to speak", () => {
    const r = plan([
      {
        channelId: STAGE,
        action: "gate",
        roleIds: [R_GAME, R_ADMIN],
        speakerRoleIds: [R_ADMIN],
      },
    ]);
    expect(r.warnings).not.toContain("speak-not-exclusive");
  });

  it("register-all merges the typed emoji into a claim that already has an action", () => {
    const pairings = detectRolePairings(scanOf(fixture()), groups);
    const typed = { [CAT_GAME]: "🎯" };
    const merged = acceptAllPairs(
      [{ channelId: CAT_GAME, action: "read-only" }],
      pairings,
      typed,
    ).find((c) => c.channelId === CAT_GAME)!;
    expect(merged).toMatchObject({
      action: "read-only",
      registerPairing: true,
      pairEmoji: "🎯",
    });
    expect(plan([merged]).built.desired.reactionRoles?.[0].emoji).toBe("🎯");
    // An emoji chosen with the row's own Register box is kept.
    const own = acceptAllPairs(
      [
        {
          channelId: CAT_GAME,
          action: "read-only",
          registerPairing: true,
          pairEmoji: "🧩",
        },
      ],
      pairings,
      typed,
    ).find((c) => c.channelId === CAT_GAME)!;
    expect(own.pairEmoji).toBe("🧩");
    // Nothing typed: the default.
    expect(
      acceptAllPairs([], pairings).find((c) => c.channelId === CAT_GAME)!
        .pairEmoji,
    ).toBe(DEFAULT_PAIR_EMOJI);
  });

  it("a picker channel rebound in the same plan is the destination, in the step and the warning", () => {
    const scanned = fixture({
      config: { "reactionroles.message_channel_id": FEED },
    });
    const r = plan(
      [
        {
          channelId: PICKER,
          action: "leave",
          bindKey: "reactionroles.message_channel_id",
        },
        pair(CAT_GAME),
      ],
      { scanned },
    );
    expect(r.errors).toEqual([]);
    const op = r.plan.operations.find(
      (o) => o.type === "reactionrole.register",
    ) as { pickerChannelId: string };
    expect(op.pickerChannelId).toBe(PICKER);
    const note = r.built.issues.find((i) => i.code === "pairing-picker")!;
    expect(note.message).toContain(`<#${PICKER}>`);
    // The setting runs first, so the registration sees the planned channel.
    const types = r.plan.operations.map((o) => o.type);
    expect(types.indexOf("config.set")).toBeLessThan(
      types.indexOf("reactionrole.register"),
    );
    // No channel set before: a binding in the plan is enough.
    const none = plan(
      [
        {
          channelId: PICKER,
          action: "leave",
          bindKey: "reactionroles.message_channel_id",
        },
        pair(CAT_GAME),
      ],
      { scanned: fixture({ config: {} }) },
    );
    expect(none.errors).toEqual([]);
  });

  it("the planner pins the picker channel in the step and refuses a non-text one", () => {
    const op = plan([pair(CAT_GAME)]).plan.operations[0] as {
      pickerChannelId: string;
    };
    expect(op.pickerChannelId).toBe(PICKER);
    const gone = fixture({
      config: { "reactionroles.message_channel_id": "999999999999999999" },
    });
    expect(plan([pair(CAT_GAME)], { scanned: gone }).errors).toContain(
      "reactionroles-channel-missing",
    );
    const category = fixture({
      config: { "reactionroles.message_channel_id": CAT_PLAIN },
    });
    expect(plan([pair(CAT_GAME)], { scanned: category }).errors).toContain(
      "reactionroles-channel-missing",
    );
  });
});

describe("review findings, round four", () => {
  it("accepts exactly one emoji sequence and refuses several or stray joiners", () => {
    for (const ok of [
      "🎮",
      "👍🏽",
      "👨‍👩‍👧",
      "🇳🇴",
      "1️⃣",
      "❤️",
      "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
      "<a:dance:123456789012345678>",
    ]) {
      expect(isValidPickerEmoji(ok)).toBe(true);
    }
    for (const bad of ["🎮🎯", "🎮 🎯", "‍", "️", "🎮‍", "🇳", "a🎮"]) {
      expect(isValidPickerEmoji(bad)).toBe(false);
    }
    expect(plan([pair(CAT_GAME, "🎮🎯")]).errors).toContain("invalid-emoji");
  });

  it("revalidation after the additive steps does not detect a pairing the plan itself changed", () => {
    const claims: ChannelClaim[] = [
      {
        channelId: CAT_GAME,
        action: "gate",
        roleIds: [R_ADMIN, R_GAME],
        registerPairing: true,
      },
    ];
    const registration = [
      { type: "reactionrole.register" } as unknown as PlanOperation,
    ];
    const destructive = [
      { type: "overwrite.remove" } as unknown as PlanOperation,
    ];
    // Before anything ran the registration is still checked.
    expect(claimsForRevalidation(claims, registration)[0].registerPairing).toBe(
      true,
    );
    // Once only destructive steps remain, it is not planned again.
    expect(claimsForRevalidation(claims, destructive)[0]).toMatchObject({
      action: "gate",
      registerPairing: false,
    });
    // What it would otherwise hit: the gate leaves two roles on the category,
    // so it is no longer a pairing.
    const gatedScan = fixture();
    gatedScan.channels.find((c) => c.id === CAT_GAME)!.overwrites = [
      ow(GUILD, 0n, F.ViewChannel),
      ow(R_GAME, F.ViewChannel),
      ow(R_ADMIN, F.ViewChannel),
    ];
    expect(plan(claims, { scanned: gatedScan }).errors).toContain(
      "not-a-pairing",
    );
    expect(
      plan(claimsForRevalidation(claims, destructive), { scanned: gatedScan })
        .errors,
    ).not.toContain("not-a-pairing");
  });

  it("refuses posting roles or a group on a feed, so nothing is granted", () => {
    const withRole = plan([
      { channelId: FEED, action: "read-only", roleIds: [R_GAME], feed: true },
    ]);
    expect(withRole.errors).toContain("feed-no-posters");
    expect(withRole.plan.operations).toHaveLength(0);
    const withGroup = plan([
      {
        channelId: FEED,
        action: "read-only",
        minGroupId: "g-staff",
        feed: true,
      },
    ]);
    expect(withGroup.errors).toContain("feed-no-posters");
    expect(
      plan([{ channelId: FEED, action: "read-only", feed: true }]).errors,
    ).toEqual([]);
  });

  it("reports a RequestToSpeak allow on an ordinary role KoolBot also holds", () => {
    const scanned = fixture({ botRoleIds: [R_KOOL, R_VIEW] });
    scanned.channels
      .find((c) => c.id === STAGE)!
      .overwrites.push(ow(R_VIEW, F.RequestToSpeak));
    const r = plan(
      [
        {
          channelId: STAGE,
          action: "gate",
          roleIds: [R_GAME, R_ADMIN],
          speakerRoleIds: [R_ADMIN],
        },
      ],
      { scanned },
    );
    expect(r.warnings).toContain("speak-not-exclusive");
  });

  it("blocks a picker channel the bot can't post and react in, as the plan leaves it", () => {
    const denied = fixture();
    denied.channels.find((c) => c.id === PICKER)!.overwrites = [
      ow(BOT, 0n, F.SendMessages | F.AddReactions, "member"),
    ];
    // The bot role has Administrator-like All in this fixture, which bypasses
    // overwrites; a plain bot role is what a real server has.
    denied.roles.find((r) => r.id === R_KOOL)!.permissions = bitsOf([
      "ViewChannel",
      "ManageRoles",
      "SendMessages",
      "EmbedLinks",
      "AddReactions",
      "ReadMessageHistory",
    ]);
    const blocked = plan([pair(CAT_GAME)], { scanned: denied });
    expect(blocked.errors).toContain("picker-channel-unusable");
    // The same server with the bot allowed there is fine.
    const allowed = fixture();
    allowed.roles.find((r) => r.id === R_KOOL)!.permissions = bitsOf([
      "ViewChannel",
      "ManageRoles",
      "SendMessages",
      "EmbedLinks",
      "AddReactions",
      "ReadMessageHistory",
    ]);
    expect(plan([pair(CAT_GAME)], { scanned: allowed }).errors).toEqual([]);
    // A plan that denies the bot there itself is caught from the after-state.
    const denies = planAdoption(allowed, {
      overwrites: [
        {
          channelId: PICKER,
          target: { id: BOT },
          targetType: "member",
          allow: "0",
          deny: F.SendMessages.toString(),
        },
      ],
      reactionRoles: [{ roleId: R_GAME, categoryId: CAT_GAME, emoji: "🎮" }],
    });
    expect(denies.errors.map((e) => e.code)).toContain(
      "picker-channel-unusable",
    );
  });
});
