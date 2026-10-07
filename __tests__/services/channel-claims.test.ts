import { describe, it, expect } from "@jest/globals";
import { ChannelType, PermissionsBitField } from "discord.js";
import {
  FEATURE_TARGETS,
  buildClaimsDesiredState,
  featureTarget,
  splitIssues,
  staleDestructiveSteps,
  type ChannelClaim,
  type ClaimContext,
} from "../../src/services/channel-claims.js";
import {
  claimsFromForm,
  claimsFromPayload,
} from "../../src/services/channel-claims-form.js";
import {
  planAdoption,
  type AdoptionPlan,
  type ChannelState,
  type OverwriteState,
  type ScannedState,
} from "../../src/services/server-adoption-planner.js";
import { defaultConfig } from "../../src/services/config-schema.js";
import { bitsOf } from "../../src/utils/channel-permissions.js";
import type { GroupSpec } from "../../src/services/role-group-plan.js";

const F = PermissionsBitField.Flags;

const GUILD = "100000000000000000";
const BOT = "100000000000000001";
const ADMIN = "100000000000000002";
const OTHER_BOT = "100000000000000003";
const R_ADMIN = "200000000000000001";
const R_MOD = "200000000000000002";
const R_VIP = "200000000000000003";
const R_BOOST = "200000000000000004";
const R_BOTINT = "200000000000000005";
const R_KOOL = "200000000000000006";
const C_CAT = "300000000000000001";
const C_TEXT = "300000000000000002";
const C_FORUM = "300000000000000003";
const C_VOICE = "300000000000000004";
const C_STAGE = "300000000000000005";
const C_LOOSE = "300000000000000006";
const C_VCAT = "300000000000000007";
const C_LOBBY = "300000000000000008";
const C_TEMP = "300000000000000009";
const C_UNSYNCED = "300000000000000010";

const role = (id: string, position: number, over = {}) => ({
  id,
  name: `role-${id.slice(-1)}`,
  color: 0,
  permissions: "0",
  position,
  managed: false,
  ...over,
});

const ow = (
  id: string,
  allow: bigint | string = 0n,
  deny: bigint | string = 0n,
  type: "role" | "member" = "role",
): OverwriteState => ({
  id,
  type,
  allow: allow.toString(),
  deny: deny.toString(),
});

const chan = (
  id: string,
  over: Partial<ChannelState> & { name?: string } = {},
): ChannelState => ({
  id,
  name: over.name ?? `chan-${id.slice(-2)}`,
  kind: "text",
  rawType: ChannelType.GuildText,
  parentId: null,
  position: 0,
  topic: null,
  overwrites: [],
  voiceMemberCount: 0,
  ...over,
});

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
      role(GUILD, 0, {
        permissions: bitsOf(["ViewChannel", "SendMessages"]),
      }),
      role(R_ADMIN, 30, { permissions: bitsOf(["ManageGuild"]) }),
      role(R_MOD, 20),
      role(R_VIP, 10),
      role(R_BOOST, 5, { managed: true }),
      role(R_BOTINT, 6, { managed: true }),
      role(R_KOOL, 50, { permissions: PermissionsBitField.All.toString() }),
    ],
    channels: [
      chan(C_CAT, { kind: "category", rawType: ChannelType.GuildCategory }),
      chan(C_TEXT, {
        parentId: C_CAT,
        overwrites: [ow(OTHER_BOT, F.ViewChannel, 0n, "member")],
      }),
      chan(C_FORUM, { parentId: C_CAT, rawType: ChannelType.GuildForum }),
      chan(C_VOICE, {
        parentId: C_CAT,
        kind: "voice",
        rawType: ChannelType.GuildVoice,
      }),
      chan(C_STAGE, {
        kind: "voice",
        rawType: ChannelType.GuildStageVoice,
      }),
      chan(C_LOOSE),
      chan(C_VCAT, { kind: "category", rawType: ChannelType.GuildCategory }),
      chan(C_LOBBY, {
        parentId: C_VCAT,
        kind: "voice",
        rawType: ChannelType.GuildVoice,
        name: "Lobby",
      }),
      chan(C_TEMP, {
        parentId: C_VCAT,
        kind: "voice",
        rawType: ChannelType.GuildVoice,
        name: "TempVoice room",
      }),
      chan(C_UNSYNCED, { parentId: C_CAT }),
    ],
    config: {},
    boundChannelIds: [],
    koolbotCreatedIds: [],
    ...over,
  };
}

const groups: GroupSpec[] = [
  g("staff", R_ADMIN, 30),
  g("mods", R_MOD, 20),
  g("vips", R_VIP, 10),
];
function g(id: string, roleId: string, rank: number): GroupSpec {
  return {
    id,
    name: id,
    roleId,
    rank,
    permissions: null,
    capabilities: [],
    colour: null,
    createdByKoolbot: false,
    gateOnly: false,
  };
}

const ctxFor = (scanned: ScannedState, over: Partial<ClaimContext> = {}) =>
  ({
    scanned,
    groups,
    integrationRoleIds: new Set([R_BOTINT]),
    syncedToParent: new Map<string, boolean | null>([
      [C_TEXT, true],
      [C_FORUM, true],
      [C_VOICE, true],
      [C_UNSYNCED, false],
    ]),
    membersIntent: true,
    suggestedPrefix: "🔊 | ",
    approvedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  }) satisfies ClaimContext;

function plan(
  claims: ChannelClaim[],
  scanned = fixture(),
  ctxOver: Partial<ClaimContext> = {},
): {
  plan: AdoptionPlan;
  errors: string[];
  warnings: string[];
  built: ReturnType<typeof buildClaimsDesiredState>;
} {
  const built = buildClaimsDesiredState(claims, ctxFor(scanned, ctxOver));
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

/** Apply a plan's operations to the scanned state, for idempotency checks. */
function applied(scanned: ScannedState, p: AdoptionPlan): ScannedState {
  const next = JSON.parse(JSON.stringify(scanned)) as ScannedState;
  for (const op of p.operations) {
    if (op.type === "overwrite.set") {
      const c = next.channels.find((x) => x.id === op.channelId)!;
      const i = c.overwrites.findIndex((o) => o.id === op.overwriteTargetId);
      const v = {
        id: op.overwriteTargetId,
        type: op.overwriteTargetType,
        allow: op.allow,
        deny: op.deny,
      };
      if (i >= 0) c.overwrites[i] = v;
      else c.overwrites.push(v);
    } else if (op.type === "overwrite.remove") {
      const c = next.channels.find((x) => x.id === op.channelId)!;
      c.overwrites = c.overwrites.filter((o) => o.id !== op.overwriteTargetId);
    } else if (op.type === "config.set") {
      next.config[op.key] = op.value;
    }
  }
  return next;
}

const sets = (p: AdoptionPlan) =>
  p.operations.flatMap((o) => (o.type === "overwrite.set" ? [o] : []));
const setFor = (p: AdoptionPlan, channelId: string, target: string) =>
  sets(p).find(
    (o) => o.channelId === channelId && o.overwriteTargetId === target,
  );

describe("leave alone is the default", () => {
  it("plans nothing for no claims and for explicit leave", () => {
    expect(plan([]).plan.operations).toHaveLength(0);
    expect(
      plan([{ channelId: C_TEXT, action: "leave" }]).plan.operations,
    ).toHaveLength(0);
  });

  it("never plans a role operation, a deletion or a removal without approval", () => {
    const p = plan([
      { channelId: C_TEXT, action: "read-only" },
      { channelId: C_LOOSE, action: "gate", roleIds: [R_VIP] },
      {
        channelId: C_LOBBY,
        action: "leave",
        bindKey: "voicechannels.lobby.channel_id",
      },
    ]).plan;
    for (const op of p.operations) {
      expect(["overwrite.set", "config.set"]).toContain(op.type);
      expect(op.class).toBe("additive");
    }
  });

  it("rejects an unknown channel, a duplicate claim and an unknown feature key", () => {
    const r = plan([
      { channelId: "999999999999999999", action: "read-only" },
      { channelId: C_TEXT, action: "read-only" },
      { channelId: C_TEXT, action: "gate", roleIds: [R_VIP] },
      { channelId: C_LOOSE, action: "leave", bindKey: "core.owner.token" },
    ]);
    expect(r.errors).toEqual(
      expect.arrayContaining([
        "unknown-channel",
        "duplicate-claim",
        "unknown-config-key",
      ]),
    );
  });
});

describe("read-only", () => {
  it("denies @everyone, allows the bot, and preserves another bot's overwrite", () => {
    const r = plan([{ channelId: C_TEXT, action: "read-only" }]);
    expect(r.errors).toEqual([]);
    const everyone = setFor(r.plan, C_TEXT, GUILD)!;
    const deny = BigInt(everyone.deny);
    for (const f of [
      F.SendMessages,
      F.SendMessagesInThreads,
      F.CreatePublicThreads,
      F.AddReactions,
    ]) {
      expect(deny & f).toBe(f);
    }
    expect(everyone.allow).toBe("0");
    const bot = setFor(r.plan, C_TEXT, BOT)!;
    expect(bot.overwriteTargetType).toBe("member");
    expect(BigInt(bot.allow) & F.SendMessages).toBe(F.SendMessages);
    // The other bot's overwrite is neither written nor removed.
    expect(setFor(r.plan, C_TEXT, OTHER_BOT)).toBeUndefined();
    expect(
      r.plan.operations.filter((o) => o.type === "overwrite.remove"),
    ).toHaveLength(0);
  });

  it("lets reactions stay when asked, and keeps unrelated bits on @everyone", () => {
    const s = fixture();
    s.channels.find((c) => c.id === C_LOOSE)!.overwrites = [
      ow(GUILD, F.AttachFiles, F.EmbedLinks),
    ];
    const r = plan(
      [{ channelId: C_LOOSE, action: "read-only", allowReactions: true }],
      s,
    );
    const everyone = setFor(r.plan, C_LOOSE, GUILD)!;
    expect(BigInt(everyone.allow) & F.AttachFiles).toBe(F.AttachFiles);
    expect(BigInt(everyone.deny) & F.EmbedLinks).toBe(F.EmbedLinks);
    expect(BigInt(everyone.deny) & F.AddReactions).toBe(0n);
  });

  it("lets chosen groups post and closes an existing group allow", () => {
    const s = fixture();
    s.channels.find((c) => c.id === C_LOOSE)!.overwrites = [
      ow(R_VIP, F.SendMessages),
    ];
    const r = plan(
      [{ channelId: C_LOOSE, action: "read-only", roleIds: [R_MOD] }],
      s,
    );
    expect(BigInt(setFor(r.plan, C_LOOSE, R_MOD)!.allow) & F.SendMessages).toBe(
      F.SendMessages,
    );
    // VIP had an allow that would let it keep posting: closed.
    expect(BigInt(setFor(r.plan, C_LOOSE, R_VIP)!.deny) & F.SendMessages).toBe(
      F.SendMessages,
    );
  });

  it("forum: members can't start posts but can still reply, unless locked", () => {
    const open = plan([{ channelId: C_FORUM, action: "read-only" }]);
    const d = BigInt(setFor(open.plan, C_FORUM, GUILD)!.deny);
    expect(d & F.SendMessages).toBe(F.SendMessages);
    expect(d & F.SendMessagesInThreads).toBe(0n);
    const locked = plan([
      { channelId: C_FORUM, action: "read-only", lockReplies: true },
    ]);
    expect(
      BigInt(setFor(locked.plan, C_FORUM, GUILD)!.deny) &
        F.SendMessagesInThreads,
    ).toBe(F.SendMessagesInThreads);
  });

  it("stage: gates requesting to speak, not posting", () => {
    const r = plan([{ channelId: C_STAGE, action: "read-only" }]);
    const d = BigInt(setFor(r.plan, C_STAGE, GUILD)!.deny);
    expect(d).toBe(F.RequestToSpeak);
  });

  it("a category claim reaches the channels synced to it, identically, and never an unsynced one", () => {
    const r = plan([{ channelId: C_CAT, action: "read-only" }]);
    const own = setFor(r.plan, C_CAT, GUILD)!;
    for (const id of [C_TEXT, C_FORUM, C_VOICE]) {
      const child = setFor(r.plan, id, GUILD)!;
      // Mirrors the category exactly, so the child still reads as synced.
      expect([child.allow, child.deny]).toEqual([own.allow, own.deny]);
    }
    expect(setFor(r.plan, C_UNSYNCED, GUILD)).toBeUndefined();
  });

  it("a category read-only claim also denies Speak and RequestToSpeak, and the bot keeps them", () => {
    const r = plan([{ channelId: C_CAT, action: "read-only" }]);
    const own = setFor(r.plan, C_CAT, GUILD)!;
    expect(BigInt(own.deny) & F.Speak).toBe(F.Speak);
    expect(BigInt(own.deny) & F.RequestToSpeak).toBe(F.RequestToSpeak);
    const child = setFor(r.plan, C_VOICE, GUILD)!;
    expect([child.allow, child.deny]).toEqual([own.allow, own.deny]);
    const bot = BigInt(setFor(r.plan, C_VOICE, BOT)!.allow);
    expect(bot & F.Speak).toBe(F.Speak);
    expect(bot & F.RequestToSpeak).toBe(F.RequestToSpeak);
  });

  it("a direct voice or stage read-only claim keeps the bot able to speak", () => {
    const voice = plan([{ channelId: C_VOICE, action: "read-only" }]);
    expect(BigInt(setFor(voice.plan, C_VOICE, BOT)!.allow) & F.Speak).toBe(
      F.Speak,
    );
    const stage = plan([{ channelId: C_STAGE, action: "read-only" }]);
    expect(
      BigInt(setFor(stage.plan, C_STAGE, BOT)!.allow) & F.RequestToSpeak,
    ).toBe(F.RequestToSpeak);
  });

  it("bulk: every channel in a category via the form", () => {
    const parsed = claimsFromForm(
      { [`bulk_${C_CAT}`]: "read-only" },
      fixture().channels.map((c) => ({
        id: c.id,
        kind: c.kind,
        parentId: c.parentId,
      })),
    );
    const claimedIds = parsed.claims.map((c) => c.channelId).sort();
    expect(claimedIds).toEqual([C_TEXT, C_FORUM, C_VOICE, C_UNSYNCED].sort());
    const r = plan(parsed.claims);
    expect(r.errors).toEqual([]);
    expect(setFor(r.plan, C_UNSYNCED, GUILD)).toBeDefined();
  });

  it("bulk never carries a sync approval to the channels it reaches", () => {
    const parsed = claimsFromForm(
      {
        [`bulk_${C_CAT}`]: "sync",
        [`replace_${C_CAT}`]: "1",
      },
      fixture().channels.map((c) => ({
        id: c.id,
        kind: c.kind,
        parentId: c.parentId,
      })),
    );
    expect(parsed.claims.length).toBeGreaterThan(0);
    for (const c of parsed.claims) expect(c.approveReplace).toBeFalsy();
  });

  it("is idempotent: planning again after applying gives an empty plan", () => {
    const claims: ChannelClaim[] = [
      { channelId: C_CAT, action: "read-only", roleIds: [R_MOD] },
    ];
    const first = plan(claims);
    expect(first.plan.operations.length).toBeGreaterThan(0);
    const second = plan(claims, applied(fixture(), first.plan));
    expect(second.plan.operations).toHaveLength(0);
  });
});

describe("group-gated", () => {
  it("hides the channel from @everyone and shows it to the chosen roles and the bot", () => {
    const r = plan([
      { channelId: C_LOOSE, action: "gate", roleIds: [R_ADMIN, R_VIP] },
    ]);
    expect(r.errors).toEqual([]);
    expect(BigInt(setFor(r.plan, C_LOOSE, GUILD)!.deny) & F.ViewChannel).toBe(
      F.ViewChannel,
    );
    expect(BigInt(setFor(r.plan, C_LOOSE, R_VIP)!.allow) & F.ViewChannel).toBe(
      F.ViewChannel,
    );
    expect(BigInt(setFor(r.plan, C_LOOSE, BOT)!.allow) & F.ViewChannel).toBe(
      F.ViewChannel,
    );
  });

  it("expands 'group X and above' by rank", () => {
    const r = plan([
      { channelId: C_LOOSE, action: "gate", minGroupId: "mods" },
    ]);
    expect(setFor(r.plan, C_LOOSE, R_ADMIN)).toBeDefined();
    expect(setFor(r.plan, C_LOOSE, R_MOD)).toBeDefined();
    expect(setFor(r.plan, C_LOOSE, R_VIP)).toBeUndefined();
  });

  it("errors when no group or role is chosen, or the group is gone", () => {
    expect(plan([{ channelId: C_LOOSE, action: "gate" }]).errors).toContain(
      "gate-needs-target",
    );
    expect(
      plan([{ channelId: C_LOOSE, action: "gate", minGroupId: "nope" }]).errors,
    ).toContain("unknown-group");
  });

  it("accepts a managed (Server Booster) role as a target, but not a bot integration role", () => {
    const ok = plan([
      { channelId: C_LOOSE, action: "gate", roleIds: [R_BOOST, R_ADMIN] },
    ]);
    expect(ok.errors).toEqual([]);
    expect(setFor(ok.plan, C_LOOSE, R_BOOST)).toBeDefined();
    // The role itself is never edited.
    expect(ok.plan.operations.some((o) => o.type.startsWith("role."))).toBe(
      false,
    );
    const bad = plan([
      { channelId: C_LOOSE, action: "gate", roleIds: [R_BOTINT, R_ADMIN] },
    ]);
    expect(bad.errors).toContain("other-bot-overwrite");
    expect(bad.plan.operations).toHaveLength(0);
  });

  it("without the gate-target exemption the planner refuses a managed target", () => {
    const scanned = fixture();
    const built = buildClaimsDesiredState(
      [{ channelId: C_LOOSE, action: "gate", roleIds: [R_BOOST, R_ADMIN] }],
      ctxFor(scanned),
    );
    const refused = planAdoption(scanned, built.desired, { approverId: ADMIN });
    expect(refused.errors.map((e) => e.code)).toContain("other-bot-overwrite");
  });

  it("blocks a gate that would lock the invoking admin out", () => {
    const r = plan([{ channelId: C_LOOSE, action: "gate", roleIds: [R_VIP] }]);
    expect(r.errors).toContain("admin-access-lost");
  });

  it("voice and stage gates keep Connect consistent with ViewChannel", () => {
    const r = plan([
      { channelId: C_VOICE, action: "gate", roleIds: [R_ADMIN] },
    ]);
    const deny = BigInt(setFor(r.plan, C_VOICE, GUILD)!.deny);
    expect(deny & F.Connect).toBe(F.Connect);
    expect(deny & F.ViewChannel).toBe(F.ViewChannel);
    expect(BigInt(setFor(r.plan, C_VOICE, R_ADMIN)!.allow) & F.Connect).toBe(
      F.Connect,
    );
  });

  it("a category gate carries Connect too, identically on synced voice children", () => {
    const r = plan([{ channelId: C_CAT, action: "gate", roleIds: [R_ADMIN] }]);
    const own = setFor(r.plan, C_CAT, GUILD)!;
    expect(BigInt(own.deny) & F.Connect).toBe(F.Connect);
    expect(BigInt(own.deny) & F.ViewChannel).toBe(F.ViewChannel);
    const child = setFor(r.plan, C_VOICE, GUILD)!;
    expect([child.allow, child.deny]).toEqual([own.allow, own.deny]);
    const role = setFor(r.plan, C_VOICE, R_ADMIN)!;
    expect(BigInt(role.allow) & F.Connect).toBe(F.Connect);
  });

  it("gating a category also gates its synced children, never an unsynced one", () => {
    const r = plan([{ channelId: C_CAT, action: "gate", roleIds: [R_ADMIN] }]);
    expect(setFor(r.plan, C_TEXT, GUILD)).toBeDefined();
    expect(setFor(r.plan, C_VOICE, GUILD)).toBeDefined();
    expect(setFor(r.plan, C_UNSYNCED, GUILD)).toBeUndefined();
    // another bot's overwrite on a child survives
    expect(setFor(r.plan, C_TEXT, OTHER_BOT)).toBeUndefined();
  });

  it("is idempotent", () => {
    const claims: ChannelClaim[] = [
      { channelId: C_CAT, action: "gate", roleIds: [R_ADMIN, R_VIP] },
    ];
    const first = plan(claims);
    expect(first.errors).toEqual([]);
    const second = plan(claims, applied(fixture(), first.plan));
    expect(second.plan.operations).toHaveLength(0);
  });
});

describe("sync to category", () => {
  const withOwn = (): ScannedState => {
    const s = fixture();
    s.channels.find((c) => c.id === C_CAT)!.overwrites = [
      ow(GUILD, 0n, F.ViewChannel),
      ow(R_MOD, F.ViewChannel),
      ow(R_ADMIN, F.ViewChannel),
    ];
    s.channels.find((c) => c.id === C_UNSYNCED)!.overwrites = [
      ow(R_VIP, F.ViewChannel),
      ow(OTHER_BOT, F.ViewChannel, 0n, "member"),
    ];
    return s;
  };

  it("needs a per-channel approval to replace a channel's own overwrites", () => {
    const r = plan([{ channelId: C_UNSYNCED, action: "sync" }], withOwn());
    expect(r.errors).toContain("approval-required");
    expect(r.plan.operations.some((o) => o.type === "overwrite.remove")).toBe(
      false,
    );
  });

  it("with approval: adds the category's overwrites and removes the channel's own, last", () => {
    const r = plan(
      [{ channelId: C_UNSYNCED, action: "sync", approveReplace: true }],
      withOwn(),
    );
    expect(r.errors).toEqual([]);
    expect(setFor(r.plan, C_UNSYNCED, GUILD)).toBeDefined();
    expect(setFor(r.plan, C_UNSYNCED, R_MOD)).toBeDefined();
    const removed = r.plan.operations.filter(
      (o) => o.type === "overwrite.remove",
    );
    expect(removed).toHaveLength(1);
    expect(removed[0].class).toBe("destructive");
    expect(r.plan.operations.at(-1)).toBe(removed[0]);
  });

  it("keeps another bot's overwrite and says the channel won't read as fully synced", () => {
    const r = plan(
      [{ channelId: C_UNSYNCED, action: "sync", approveReplace: true }],
      withOwn(),
    );
    expect(r.warnings).toContain("sync-partial");
    const removedTargets = r.plan.operations.flatMap((o) =>
      o.type === "overwrite.remove" ? [o.overwriteTargetId] : [],
    );
    expect(removedTargets).not.toContain(OTHER_BOT);
  });

  it("copies a Server Booster overwrite from the category without tripping the planner", () => {
    const s = withOwn();
    s.channels
      .find((c) => c.id === C_CAT)!
      .overwrites.push(ow(R_BOOST, F.ViewChannel));
    const r = plan(
      [{ channelId: C_UNSYNCED, action: "sync", approveReplace: true }],
      s,
    );
    expect(r.errors).toEqual([]);
    expect(setFor(r.plan, C_UNSYNCED, R_BOOST)).toBeDefined();
  });

  it("warns when another bot's category overwrite can't be matched on the channel", () => {
    const s = withOwn();
    s.channels
      .find((c) => c.id === C_CAT)!
      .overwrites.push(ow(OTHER_BOT, F.ViewChannel, 0n, "member"));
    s.channels.find((c) => c.id === C_UNSYNCED)!.overwrites = [];
    const r = plan([{ channelId: C_UNSYNCED, action: "sync" }], s);
    expect(r.warnings).toContain("sync-partial");
    expect(setFor(r.plan, C_UNSYNCED, OTHER_BOT)).toBeUndefined();
  });

  it("leaves member overwrites alone when the members intent is off", () => {
    const s = withOwn();
    s.channels
      .find((c) => c.id === C_UNSYNCED)!
      .overwrites.push(ow("100000000000000099", F.ViewChannel, 0n, "member"));
    const r = plan(
      [{ channelId: C_UNSYNCED, action: "sync", approveReplace: true }],
      s,
      { membersIntent: false },
    );
    const removedTargets = r.plan.operations.flatMap((o) =>
      o.type === "overwrite.remove" ? [o.overwriteTargetId] : [],
    );
    expect(removedTargets).not.toContain("100000000000000099");
    expect(r.warnings).toContain("sync-partial");
  });

  it("a channel with nothing of its own to replace needs no approval", () => {
    const s = withOwn();
    s.channels.find((c) => c.id === C_UNSYNCED)!.overwrites = [];
    const r = plan([{ channelId: C_UNSYNCED, action: "sync" }], s);
    expect(r.errors).toEqual([]);
    expect(r.plan.operations.every((o) => o.class === "additive")).toBe(true);
  });

  it("errors for a channel with no category", () => {
    expect(
      plan([{ channelId: C_LOOSE, action: "sync", approveReplace: true }])
        .errors,
    ).toContain("no-parent");
  });

  it("an approval only counts for the admin applying the plan", () => {
    const s = withOwn();
    const built = buildClaimsDesiredState(
      [{ channelId: C_UNSYNCED, action: "sync", approveReplace: true }],
      ctxFor(s),
    );
    const other = planAdoption(s, built.desired, {
      approverId: "someone-else",
    });
    expect(other.errors.map((e) => e.code)).toContain("approval-required");
  });

  it("is idempotent once applied", () => {
    const claims: ChannelClaim[] = [
      { channelId: C_UNSYNCED, action: "sync", approveReplace: true },
    ];
    const first = plan(claims, withOwn());
    const second = plan(claims, applied(withOwn(), first.plan));
    // Only the other bot's overwrite remains, which is preserved: no ops.
    expect(second.plan.operations).toHaveLength(0);
  });
});

describe("bind to a feature", () => {
  it("writes the key and gives the bot what the feature needs", () => {
    const r = plan([
      { channelId: C_LOOSE, action: "leave", bindKey: "quotes.channel_id" },
    ]);
    expect(r.errors).toEqual([]);
    const cfg = r.plan.operations.find((o) => o.type === "config.set")!;
    expect(cfg).toMatchObject({
      key: "quotes.channel_id",
      value: C_LOOSE,
    });
    const bot = setFor(r.plan, C_LOOSE, BOT)!;
    expect(BigInt(bot.allow) & F.SendMessages).toBe(F.SendMessages);
  });

  it("notices: the same read-only permissions the channel manager sets", () => {
    const r = plan([
      { channelId: C_LOOSE, action: "leave", bindKey: "notices.channel_id" },
    ]);
    const everyone = setFor(r.plan, C_LOOSE, GUILD)!;
    expect(BigInt(everyone.deny) & F.SendMessages).toBe(F.SendMessages);
    expect(BigInt(everyone.allow) & F.AddReactions).toBe(F.AddReactions);
    expect(BigInt(setFor(r.plan, C_LOOSE, BOT)!.allow) & F.ManageMessages).toBe(
      F.ManageMessages,
    );
  });

  it("refuses a channel of the wrong kind for the feature", () => {
    expect(
      plan([
        { channelId: C_VOICE, action: "leave", bindKey: "quotes.channel_id" },
        {
          channelId: C_LOOSE,
          action: "leave",
          bindKey: "voicechannels.category_id",
        },
      ]).errors,
    ).toContain("feature-channel-mismatch");
  });

  it("refuses two channels for one feature in the same plan", () => {
    expect(
      plan([
        { channelId: C_LOOSE, action: "leave", bindKey: "quotes.channel_id" },
        { channelId: C_TEXT, action: "leave", bindKey: "quotes.channel_id" },
      ]).errors,
    ).toContain("duplicate-binding");
  });

  it("warns when it re-binds a feature, and is idempotent", () => {
    const s = fixture({ config: { "quotes.channel_id": C_TEXT } });
    const claims: ChannelClaim[] = [
      { channelId: C_LOOSE, action: "leave", bindKey: "quotes.channel_id" },
    ];
    const first = plan(claims, s);
    expect(first.warnings).toContain("rebind");
    const second = plan(claims, applied(s, first.plan));
    expect(second.plan.operations).toHaveLength(0);
  });

  it("a bound read-only channel keeps the bot able to post", () => {
    const r = plan([
      {
        channelId: C_LOOSE,
        action: "read-only",
        bindKey: "birthdays.channel_id",
      },
    ]);
    expect(r.errors).toEqual([]);
    expect(BigInt(setFor(r.plan, C_LOOSE, BOT)!.allow) & F.SendMessages).toBe(
      F.SendMessages,
    );
  });

  it("every registry key is a real, string-typed setting", () => {
    for (const f of FEATURE_TARGETS) {
      expect(f.key in defaultConfig).toBe(true);
      expect(typeof (defaultConfig as Record<string, unknown>)[f.key]).toBe(
        "string",
      );
      expect(featureTarget(f.key)).toBe(f);
    }
  });
});

describe("voice category claims (#1032)", () => {
  const voiceCat = (over: Partial<ChannelClaim> = {}): ChannelClaim => ({
    channelId: C_VCAT,
    action: "leave",
    bindKey: "voicechannels.category_id",
    ...over,
  });

  it("blocks a shared category while cleanup could delete other bots' channels", () => {
    const r = plan([voiceCat()]);
    expect(r.errors).toContain("voice-cleanup-risk");
    const issue = buildClaimsDesiredState(
      [voiceCat()],
      ctxFor(fixture()),
    ).issues.find((i) => i.code === "voice-cleanup-risk")!;
    expect(issue.message).toContain("TempVoice room");
    expect(issue.message).not.toContain('"Lobby"');
  });

  it("allows it with managed-only on, ordering that key before the category", () => {
    const r = plan([voiceCat({ voiceManagedOnly: true })]);
    expect(r.errors).toEqual([]);
    const keys = r.plan.operations.flatMap((o) =>
      o.type === "config.set" ? [o.key] : [],
    );
    expect(
      keys.indexOf("voicechannels.cleanup.managed_only"),
    ).toBeGreaterThanOrEqual(0);
    expect(keys.indexOf("voicechannels.cleanup.managed_only")).toBeLessThan(
      keys.indexOf("voicechannels.category_id"),
    );
    expect(r.warnings).toEqual(
      expect.arrayContaining(["voice-managed-only", "voice-handover"]),
    );
  });

  it("allows it when managed-only is already on", () => {
    const s = fixture({
      config: { "voicechannels.cleanup.managed_only": true },
    });
    expect(plan([voiceCat()], s).errors).toEqual([]);
  });

  it("a dedicated category (only the lobby) needs nothing special", () => {
    const s = fixture();
    s.channels = s.channels.filter((c) => c.id !== C_TEMP);
    expect(plan([voiceCat()], s).errors).toEqual([]);
  });

  it("an occupied channel still counts: it is deleted once it empties", () => {
    const s = fixture();
    s.channels.find((c) => c.id === C_TEMP)!.voiceMemberCount = 2;
    expect(plan([voiceCat()], s).errors).toContain("voice-cleanup-risk");
  });

  it("the lobby, by name or by bound id, is never at risk", () => {
    const s = fixture();
    s.channels = s.channels.filter((c) => c.id !== C_TEMP);
    expect(plan([voiceCat()], s).errors).toEqual([]);
  });

  it("binds an existing lobby by id and the naming prefix when asked", () => {
    const r = plan([
      voiceCat({ voiceManagedOnly: true, usePrefix: true }),
      {
        channelId: C_LOBBY,
        action: "leave",
        bindKey: "voicechannels.lobby.channel_id",
      },
    ]);
    expect(r.errors).toEqual([]);
    const values = Object.fromEntries(
      r.plan.operations.flatMap((o) =>
        o.type === "config.set" ? [[o.key, o.value]] : [],
      ),
    );
    expect(values["voicechannels.lobby.channel_id"]).toBe(C_LOBBY);
    expect(values["voicechannels.channel.prefix"]).toBe("🔊 |");
  });
});

describe("safety rules the planner enforces for claims", () => {
  it("never removes the bot's access to a channel a feature is bound to", () => {
    const s = fixture({
      boundChannelIds: [C_LOOSE],
      config: { "quotes.channel_id": C_LOOSE },
    });
    // Only the bot's role is Administrator-free here: strip it.
    s.roles = s.roles.map((r) =>
      r.id === R_KOOL
        ? {
            ...r,
            permissions: bitsOf([
              "ViewChannel",
              "ManageRoles",
              "ManageChannels",
              "SendMessages",
              "EmbedLinks",
              "AddReactions",
              "ReadMessageHistory",
              "SendMessagesInThreads",
            ]),
          }
        : r,
    );
    // Gating to a role the bot lacks still grants the bot an explicit overwrite.
    const r = plan(
      [{ channelId: C_LOOSE, action: "gate", roleIds: [R_ADMIN] }],
      s,
    );
    expect(r.errors).not.toContain("bot-lockout");
    expect(BigInt(setFor(r.plan, C_LOOSE, BOT)!.allow) & F.ViewChannel).toBe(
      F.ViewChannel,
    );
  });

  it("errors, not warns, when the bot lacks Manage Roles", () => {
    const s = fixture();
    s.roles = s.roles.map((r) =>
      r.id === R_KOOL ? { ...r, permissions: bitsOf(["ViewChannel"]) } : r,
    );
    expect(
      plan([{ channelId: C_LOOSE, action: "read-only" }], s).errors,
    ).toContain("bot-lacks-permission");
  });
});

describe("form parsing", () => {
  const channels = fixture().channels.map((c) => ({
    id: c.id,
    kind: c.kind,
    parentId: c.parentId,
  }));

  it("reads flat fields, drops no-ops and unknown features", () => {
    const parsed = claimsFromForm(
      {
        [`action_${C_LOOSE}`]: "gate",
        [`roles_${C_LOOSE}`]: [R_VIP, "not-an-id"],
        [`min_${C_LOOSE}`]: "mods",
        [`action_${C_TEXT}`]: "leave",
        [`bind_${C_STAGE}`]: "not.a.key",
        [`action_${C_VOICE}`]: "explode",
      },
      channels,
    );
    expect(parsed.claims).toHaveLength(1);
    expect(parsed.claims[0]).toMatchObject({
      channelId: C_LOOSE,
      action: "gate",
      roleIds: [R_VIP],
      minGroupId: "mods",
    });
    expect(parsed.problems.length).toBeGreaterThanOrEqual(2);
  });

  it("the row's own choice wins over its category's bulk action", () => {
    const parsed = claimsFromForm(
      {
        [`bulk_${C_CAT}`]: "read-only",
        [`action_${C_TEXT}`]: "gate",
        [`roles_${C_TEXT}`]: R_ADMIN,
      },
      channels,
    );
    expect(parsed.claims.find((c) => c.channelId === C_TEXT)!.action).toBe(
      "gate",
    );
    expect(parsed.claims.find((c) => c.channelId === C_FORUM)!.action).toBe(
      "read-only",
    );
  });

  it("round-trips through the payload, validating ids and keys", () => {
    const ids = new Set(channels.map((c) => c.id));
    const claims: ChannelClaim[] = [
      {
        channelId: C_LOOSE,
        action: "read-only",
        bindKey: "quotes.channel_id",
        roleIds: [R_MOD],
        allowReactions: true,
      },
    ];
    const back = claimsFromPayload(JSON.stringify(claims), ids)!;
    expect(back.claims[0]).toMatchObject(claims[0]);
    expect(claimsFromPayload("not json", ids)).toBeNull();
    expect(
      claimsFromPayload(
        JSON.stringify([{ channelId: "1".repeat(18), action: "gate" }]),
        ids,
      ),
    ).toBeNull();
    expect(
      claimsFromPayload(
        JSON.stringify([
          { channelId: C_LOOSE, action: "leave", bindKey: "core.owner" },
        ]),
        ids,
      ),
    ).toBeNull();
    expect(
      claimsFromPayload(
        JSON.stringify([{ channelId: C_LOOSE, action: "wipe" }]),
        ids,
      ),
    ).toBeNull();
  });
});

describe("the live check before a destructive step", () => {
  const syncPlan = (allow: bigint) => {
    const s = fixture();
    s.channels.find((c) => c.id === C_CAT)!.overwrites = [
      ow(GUILD, 0n, F.ViewChannel),
      ow(R_ADMIN, F.ViewChannel),
    ];
    s.channels.find((c) => c.id === C_UNSYNCED)!.overwrites = [
      ow(R_VIP, allow),
    ];
    return plan(
      [{ channelId: C_UNSYNCED, action: "sync", approveReplace: true }],
      s,
    ).plan.operations;
  };

  it("passes when the overwrite is still what was previewed", () => {
    expect(
      staleDestructiveSteps(syncPlan(F.ViewChannel), syncPlan(F.ViewChannel)),
    ).toEqual([]);
  });

  it("refuses when someone changed the overwrite's bits in the meantime", () => {
    const stale = staleDestructiveSteps(
      syncPlan(F.ViewChannel),
      syncPlan(F.ViewChannel | F.SendMessages),
    );
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatch(/no longer matches/);
  });

  it("refuses when the removal is gone altogether", () => {
    expect(staleDestructiveSteps(syncPlan(F.ViewChannel), [])).toHaveLength(1);
  });
});

describe("bypass detection and message deletion", () => {
  const MEMBER = "100000000000000077";

  it("a gate names roles and members that can still see the channel", () => {
    const s = fixture();
    s.channels.find((c) => c.id === C_LOOSE)!.overwrites = [
      ow(R_VIP, F.ViewChannel),
      ow(MEMBER, F.ViewChannel, 0n, "member"),
      ow(OTHER_BOT, F.ViewChannel, 0n, "member"),
    ];
    const r = buildClaimsDesiredState(
      [{ channelId: C_LOOSE, action: "gate", roleIds: [R_ADMIN] }],
      ctxFor(s),
    );
    const issue = r.issues.find((i) => i.code === "gate-not-exclusive")!;
    expect(issue.message).toContain("role-3");
    expect(issue.message).toContain(MEMBER);
    // another bot's overwrite is expected to stay and isn't reported
    expect(issue.message).not.toContain(OTHER_BOT);
    expect(splitIssues(r.issues).errors).toEqual([]);
  });

  it("a gate is exclusive when the allowed roles are the only ones", () => {
    const s = fixture();
    s.channels.find((c) => c.id === C_LOOSE)!.overwrites = [
      ow(R_VIP, F.ViewChannel),
    ];
    const r = buildClaimsDesiredState(
      [{ channelId: C_LOOSE, action: "gate", roleIds: [R_ADMIN, R_VIP] }],
      ctxFor(s),
    );
    expect(r.issues.map((i) => i.code)).not.toContain("gate-not-exclusive");
  });

  it("a voice gate also checks Connect", () => {
    const s = fixture();
    s.channels.find((c) => c.id === C_VOICE)!.overwrites = [
      ow(MEMBER, F.Connect, 0n, "member"),
    ];
    const r = buildClaimsDesiredState(
      [{ channelId: C_VOICE, action: "gate", roleIds: [R_ADMIN] }],
      ctxFor(s),
    );
    expect(r.issues.map((i) => i.code)).toContain("gate-not-exclusive");
  });

  it("a read-only claim names overwrites that still allow posting", () => {
    const s = fixture();
    s.channels.find((c) => c.id === C_LOOSE)!.overwrites = [
      ow(MEMBER, F.SendMessages, 0n, "member"),
      ow(R_BOOST, F.CreatePublicThreads),
    ];
    const r = buildClaimsDesiredState(
      [{ channelId: C_LOOSE, action: "read-only" }],
      ctxFor(s),
    );
    const issue = r.issues.find((i) => i.code === "read-only-not-exclusive")!;
    expect(issue.message).toContain(MEMBER);
    expect(issue.message).toContain("@role-4");
    expect(splitIssues(r.issues).errors).toEqual([]);
  });

  it("a chosen poster is not reported", () => {
    const s = fixture();
    s.channels.find((c) => c.id === C_LOOSE)!.overwrites = [
      ow(R_MOD, F.SendMessages),
    ];
    const r = buildClaimsDesiredState(
      [{ channelId: C_LOOSE, action: "read-only", roleIds: [R_MOD] }],
      ctxFor(s),
    );
    expect(r.issues.map((i) => i.code)).not.toContain(
      "read-only-not-exclusive",
    );
  });

  it("binding quotes or notices is blocked while the feature would delete the channel's messages", () => {
    for (const [key, enabled] of [
      ["quotes.channel_id", "quotes.enabled"],
      ["notices.channel_id", "notices.enabled"],
    ]) {
      const on = plan(
        [{ channelId: C_LOOSE, action: "leave", bindKey: key }],
        fixture({ config: { [enabled]: true } }),
      );
      expect(on.errors).toContain("feature-deletes-messages");
      expect(on.plan.operations.some((o) => o.type === "config.set")).toBe(
        true,
      ); // the builder still plans; apply is blocked by the error
    }
  });

  it("when the feature is off it binds, with a warning that says what enabling will do", () => {
    const r = plan([
      { channelId: C_LOOSE, action: "leave", bindKey: "quotes.channel_id" },
    ]);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toContain("feature-deletes-messages-later");
  });

  it("an already-bound channel is not flagged again", () => {
    const r = plan(
      [{ channelId: C_LOOSE, action: "leave", bindKey: "quotes.channel_id" }],
      fixture({
        config: { "quotes.enabled": true, "quotes.channel_id": C_LOOSE },
      }),
    );
    expect(r.errors).toEqual([]);
    expect(r.warnings).not.toContain("feature-deletes-messages-later");
  });
});

describe("one composed result per channel (third review round)", () => {
  const MEMBER = "100000000000000077";

  it("checks seeing and joining independently: an admin who could not join still keeps visibility", () => {
    const s = fixture();
    // Admin can see C_VOICE but never could connect (everyone lacks Connect).
    s.channels.find((c) => c.id === C_VOICE)!.overwrites = [
      ow(R_ADMIN, F.ViewChannel),
    ];
    const p = planAdoption(
      s,
      {
        overwrites: [
          {
            channelId: C_VOICE,
            target: { id: R_ADMIN },
            allow: "0",
            deny: F.ViewChannel.toString(),
          },
        ],
      },
      { approverId: ADMIN },
    );
    expect(p.errors.map((e) => e.code)).toContain("admin-access-lost");
  });

  it("binding notices or quotes with a gate or a sync still applies the read-only @everyone set", () => {
    for (const bindKey of ["notices.channel_id", "quotes.channel_id"]) {
      const gated = plan([
        {
          channelId: C_LOOSE,
          action: "gate",
          roleIds: [R_ADMIN],
          bindKey,
        },
      ]);
      const everyone = setFor(gated.plan, C_LOOSE, GUILD)!;
      expect(BigInt(everyone.deny) & F.SendMessages).toBe(F.SendMessages);
      // ...without re-opening the gate.
      expect(BigInt(everyone.deny) & F.ViewChannel).toBe(F.ViewChannel);
      expect(BigInt(everyone.allow) & F.ViewChannel).toBe(0n);
    }
    const synced = plan([
      {
        channelId: C_UNSYNCED,
        action: "sync",
        bindKey: "notices.channel_id",
      },
    ]);
    expect(
      BigInt(setFor(synced.plan, C_UNSYNCED, GUILD)!.deny) & F.SendMessages,
    ).toBe(F.SendMessages);
  });

  it("chosen posters get every posting permission back, including private threads", () => {
    const r = plan([
      { channelId: C_LOOSE, action: "read-only", roleIds: [R_MOD] },
    ]);
    const deny = BigInt(setFor(r.plan, C_LOOSE, GUILD)!.deny);
    const poster = BigInt(setFor(r.plan, C_LOOSE, R_MOD)!.allow);
    const bot = BigInt(setFor(r.plan, C_LOOSE, BOT)!.allow);
    expect(deny & F.CreatePrivateThreads).toBe(F.CreatePrivateThreads);
    expect(poster & deny & ~F.AddReactions).toBe(deny & ~F.AddReactions);
    expect(bot & deny).toBe(deny);
    const cat = plan([
      { channelId: C_CAT, action: "read-only", roleIds: [R_MOD] },
    ]);
    const catDeny = BigInt(setFor(cat.plan, C_CAT, GUILD)!.deny);
    expect(BigInt(setFor(cat.plan, C_CAT, R_MOD)!.allow) & catDeny).toBe(
      catDeny,
    );
  });

  it("blocks a plan that leaves the admin able to see a voice channel but not join it", () => {
    const s = fixture();
    s.roles = s.roles.map((r) =>
      r.id === GUILD
        ? { ...r, permissions: bitsOf(["ViewChannel", "Connect"]) }
        : r,
    );
    // The admin's role overwrite restores visibility after the @everyone deny.
    s.channels.find((c) => c.id === C_VOICE)!.overwrites = [
      ow(R_ADMIN, F.ViewChannel),
    ];
    const built = {
      overwrites: [
        {
          channelId: C_VOICE,
          target: { id: GUILD },
          allow: "0",
          deny: (F.Connect | F.ViewChannel).toString(),
        },
      ],
    };
    const p = planAdoption(s, built, { approverId: ADMIN });
    expect(p.errors.map((e) => e.code)).toContain("admin-access-lost");
  });

  it("a voice gate that keeps the admin's Connect is accepted", () => {
    const r = plan([
      { channelId: C_VOICE, action: "gate", roleIds: [R_ADMIN] },
    ]);
    expect(r.errors).toEqual([]);
  });

  it("quotes gets the same read-only shape the quote channel manager sets", () => {
    const r = plan([
      { channelId: C_LOOSE, action: "leave", bindKey: "quotes.channel_id" },
    ]);
    const everyone = setFor(r.plan, C_LOOSE, GUILD)!;
    expect(BigInt(everyone.deny) & F.SendMessages).toBe(F.SendMessages);
    expect(BigInt(everyone.allow) & F.AddReactions).toBe(F.AddReactions);
    expect(BigInt(setFor(r.plan, C_LOOSE, BOT)!.allow) & F.ManageMessages).toBe(
      F.ManageMessages,
    );
  });

  it("a feature binding and an action both contribute to the bot's permissions", () => {
    const r = plan([
      {
        channelId: C_LOBBY,
        action: "read-only",
        bindKey: "voicechannels.lobby.channel_id",
      },
    ]);
    const bot = BigInt(setFor(r.plan, C_LOBBY, BOT)!.allow);
    expect(bot & F.Speak).toBe(F.Speak); // from the read-only claim
    expect(bot & F.Connect).toBe(F.Connect); // from the lobby feature
  });

  it("the bot can still create threads in a read-only channel", () => {
    const r = plan([{ channelId: C_LOOSE, action: "read-only" }]);
    const bot = BigInt(setFor(r.plan, C_LOOSE, BOT)!.allow);
    expect(bot & F.CreatePublicThreads).toBe(F.CreatePublicThreads);
    expect(bot & F.CreatePrivateThreads).toBe(F.CreatePrivateThreads);
  });

  it("with reactions disabled, a preserved AddReactions allow is closed for groups and reported otherwise", () => {
    const s = fixture();
    s.channels.find((c) => c.id === C_LOOSE)!.overwrites = [
      ow(R_VIP, F.AddReactions),
      ow(MEMBER, F.AddReactions, 0n, "member"),
    ];
    const r = buildClaimsDesiredState(
      [{ channelId: C_LOOSE, action: "read-only" }],
      ctxFor(s),
    );
    expect(
      BigInt(
        r.desired.overwrites!.find(
          (o) => "id" in o.target && o.target.id === R_VIP,
        )!.deny,
      ) & F.AddReactions,
    ).toBe(F.AddReactions);
    expect(r.issues.map((i) => i.code)).toContain("read-only-not-exclusive");
    const allowed = buildClaimsDesiredState(
      [{ channelId: C_LOOSE, action: "read-only", allowReactions: true }],
      ctxFor(s),
    );
    expect(allowed.issues.map((i) => i.code)).not.toContain(
      "read-only-not-exclusive",
    );
  });

  it("a stage channel is not a legacy-cleanup risk for a voice category", () => {
    const s = fixture();
    s.channels = s.channels.filter((c) => c.id !== C_TEMP);
    s.channels.push(
      chan("300000000000000050", {
        parentId: C_VCAT,
        kind: "voice",
        rawType: ChannelType.GuildStageVoice,
        name: "Town hall",
      }),
    );
    expect(
      plan(
        [
          {
            channelId: C_VCAT,
            action: "leave",
            bindKey: "voicechannels.category_id",
          },
        ],
        s,
      ).errors,
    ).toEqual([]);
  });

  it("a synced child with its own claim is composed on top of its category's plan", () => {
    const r = plan([
      { channelId: C_CAT, action: "gate", roleIds: [R_ADMIN] },
      { channelId: C_TEXT, action: "read-only" },
    ]);
    const child = setFor(r.plan, C_TEXT, GUILD)!;
    expect(BigInt(child.deny) & F.ViewChannel).toBe(F.ViewChannel); // category's gate
    expect(BigInt(child.deny) & F.SendMessages).toBe(F.SendMessages); // its own claim
    expect(setFor(r.plan, C_TEXT, R_ADMIN)).toBeDefined();
  });

  it("a bind-only claim on a synced child does not drop it from its category's gate", () => {
    const r = plan([
      { channelId: C_CAT, action: "gate", roleIds: [R_ADMIN] },
      { channelId: C_TEXT, action: "leave", bindKey: "quotes.channel_id" },
    ]);
    expect(BigInt(setFor(r.plan, C_TEXT, GUILD)!.deny) & F.ViewChannel).toBe(
      F.ViewChannel,
    );
  });

  it("syncing a channel copies its category's planned state, not the pre-plan one", () => {
    const r = plan([
      { channelId: C_CAT, action: "gate", roleIds: [R_ADMIN] },
      { channelId: C_UNSYNCED, action: "sync", approveReplace: true },
    ]);
    expect(
      BigInt(setFor(r.plan, C_UNSYNCED, GUILD)!.deny) & F.ViewChannel,
    ).toBe(F.ViewChannel);
    expect(setFor(r.plan, C_UNSYNCED, R_ADMIN)).toBeDefined();
  });

  it("sync with a feature binding, or with the bot's own overwrite, reports a partial sync", () => {
    const bound = plan([
      {
        channelId: C_UNSYNCED,
        action: "sync",
        bindKey: "quotes.channel_id",
        approveReplace: true,
      },
    ]);
    expect(bound.warnings).toContain("sync-partial");
    const s = fixture();
    s.channels.find((c) => c.id === C_UNSYNCED)!.overwrites = [
      ow(BOT, F.ViewChannel, 0n, "member"),
    ];
    expect(
      plan([{ channelId: C_UNSYNCED, action: "sync" }], s).warnings,
    ).toContain("sync-partial");
  });
});
