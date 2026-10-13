/**
 * End-to-end server adoption on a simulated guild (#1025, epic #1017).
 *
 * Unlike the engine's unit tests, the gateway, snapshot store and config here
 * really mutate an in-memory server, so "apply", "re-plan gives an empty plan"
 * and "rollback restores the original" are checked against state, not against
 * a list of calls. The path under test is the production one: claims ->
 * `buildClaimsDesiredState` -> `planAdoption` -> `ServerAdoptionService`.
 *
 * The fixture follows the reference server's shape (issue #1025, first
 * comment): hoisted staff roles, role-gated game categories, a picker owned by
 * another bot, webhook-fed news channels, a staff-only Admin category with a
 * log channel, an integration bot's category, a music-bot channel, an AFK
 * channel, existing quotes / announcement / voice-stats channels, and a Voice
 * Channels category with a lobby.
 *
 * Not modelled: webhooks (the scan state has no webhook field), so "webhooks
 * are untouched" is only shown indirectly, as untouched channels.
 */

import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import { PermissionsBitField } from "discord.js";

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const { ServerAdoptionService } =
  await import("../../src/services/server-adoption-service.js");
type Deps =
  import("../../src/services/server-adoption-service.js").AdoptionDeps;
type SnapshotRecord =
  import("../../src/services/server-adoption-service.js").AdoptionSnapshotRecord;
const { planAdoption } =
  await import("../../src/services/server-adoption-planner.js");
type Scanned =
  import("../../src/services/server-adoption-planner.js").ScannedState;
type RoleState =
  import("../../src/services/server-adoption-planner.js").RoleState;
type ChannelState =
  import("../../src/services/server-adoption-planner.js").ChannelState;
type ConfigValue =
  import("../../src/services/server-adoption-planner.js").ConfigValue;
const { buildClaimsDesiredState, isBlocking } =
  await import("../../src/services/channel-claims.js");
type Claim = import("../../src/services/channel-claims.js").ChannelClaim;

const F = PermissionsBitField.Flags;
const VIEW = F.ViewChannel.toString();
const ADMIN = F.Administrator.toString();
const GUILD = "g1";
const OTHER_BOT_MEMBER = "bot-music";
const actor = {
  sessionId: "s",
  discordUserId: "admin",
  guildId: GUILD,
  role: "admin",
} as never;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

const role = (
  id: string,
  name: string,
  position: number,
  permissions = "0",
  managed = false,
): RoleState => ({ id, name, color: 0, permissions, position, managed });

let pos = 0;
const channel = (
  id: string,
  name: string,
  kind: "category" | "text" | "voice",
  parentId: string | null = null,
  overwrites: ChannelState["overwrites"] = [],
): ChannelState => ({
  id,
  name,
  kind,
  rawType: kind === "category" ? 4 : kind === "voice" ? 2 : 0,
  parentId,
  position: pos++,
  topic: null,
  overwrites,
  voiceMemberCount: 0,
});
const hiddenFromEveryone = (allowRole: string): ChannelState["overwrites"] => [
  { id: GUILD, type: "role", allow: "0", deny: VIEW },
  { id: allowRole, type: "role", allow: VIEW, deny: "0" },
];

interface World {
  roles: Map<string, RoleState>;
  channels: Map<string, ChannelState>;
  config: Map<string, ConfigValue>;
}

function referenceServer(): World {
  const roles = [
    role(GUILD, "@everyone", 0, VIEW),
    role("koolbot", "KoolBot", 20, ADMIN, true),
    role("admin-role", "Admin", 15, ADMIN),
    role("mod-role", "Moderator", 14),
    role("vip-role", "VIP", 13),
    role("bots-role", "Bots", 12),
    role("carl", "Music Bot", 11, "0", true),
    ...Array.from({ length: 10 }, (_, i) => role(`game-${i}`, `Game ${i}`, 2)),
  ];
  const channels: ChannelState[] = [
    channel(
      "cat-admin",
      "Admin",
      "category",
      null,
      hiddenFromEveryone("admin-role"),
    ),
    channel(
      "staff-log",
      "staff-log",
      "text",
      "cat-admin",
      hiddenFromEveryone("admin-role"),
    ),
    channel("cat-news", "News", "category"),
    channel("news", "news", "text", "cat-news"),
    channel("updates", "updates", "text", "cat-news"),
    channel("cat-info", "Info", "category"),
    channel("quotes", "quotes", "text", "cat-info"),
    channel("announcement", "announcement", "text", "cat-info"),
    channel("voice-stats", "voice-stats", "text", "cat-info"),
    channel("vip-lounge", "vip-lounge", "text", "cat-info"),
    channel("picker", "pick-your-game", "text", "cat-info", [
      { id: OTHER_BOT_MEMBER, type: "member", allow: VIEW, deny: "0" },
    ]),
    channel("cat-integration", "Integration", "category", null, [
      { id: OTHER_BOT_MEMBER, type: "member", allow: VIEW, deny: "0" },
    ]),
    channel("integration-feed", "feed", "text", "cat-integration"),
    channel("music", "music", "voice", "cat-info", [
      { id: OTHER_BOT_MEMBER, type: "member", allow: VIEW, deny: "0" },
    ]),
    channel("afk", "afk", "voice"),
    channel("cat-voice", "Voice Channels", "category"),
    channel("lobby", "Lobby", "voice", "cat-voice"),
    ...Array.from({ length: 10 }, (_, i) => [
      channel(
        `cat-game-${i}`,
        `Game ${i}`,
        "category",
        null,
        hiddenFromEveryone(`game-${i}`),
      ),
      channel(`game-chat-${i}`, `chat-${i}`, "text", `cat-game-${i}`),
    ]).flat(),
  ];
  return {
    roles: new Map(roles.map((r) => [r.id, r])),
    channels: new Map(channels.map((c) => [c.id, c])),
    config: new Map<string, ConfigValue>([
      ["adoption.snapshot.retention_days", 90],
    ]),
  };
}

/** What a fresh scan of the simulated server would report. */
function scan(w: World): Scanned {
  const bound = new Set<string>();
  for (const [k, v] of w.config) {
    if (/(\.channel_id|\.category_id)$/.test(k) && typeof v === "string") {
      bound.add(v);
    }
  }
  return {
    guildId: GUILD,
    ownerId: "owner",
    botUserId: "koolbot-user",
    botRoleIds: ["koolbot"],
    botHighestRolePosition: 20,
    adminUserId: "admin",
    adminRoleIds: ["admin-role"],
    otherBotIds: [OTHER_BOT_MEMBER],
    roles: clone([...w.roles.values()]),
    channels: clone([...w.channels.values()]),
    config: Object.fromEntries(w.config),
    memberRoles: {},
    boundChannelIds: [...bound],
    koolbotCreatedIds: [],
  };
}

const CLAIMS: Claim[] = [
  { channelId: "news", action: "read-only" },
  { channelId: "updates", action: "read-only" },
  { channelId: "vip-lounge", action: "gate", roleIds: ["vip-role"] },
  { channelId: "quotes", action: "leave", bindKey: "quotes.channel_id" },
  {
    channelId: "voice-stats",
    action: "leave",
    bindKey: "voicetracking.announcements.channel_id",
  },
  {
    channelId: "announcement",
    action: "leave",
    bindKey: "events.announcement_channel_id",
  },
  {
    channelId: "staff-log",
    action: "leave",
    bindKey: "core.errors.channel_id",
  },
  {
    channelId: "cat-voice",
    action: "leave",
    bindKey: "voicechannels.category_id",
    voiceManagedOnly: true,
  },
  {
    channelId: "lobby",
    action: "leave",
    bindKey: "voicechannels.lobby.channel_id",
  },
];

/** Roles the plan creates itself, to exercise created-role rollback. */
const EXTRA_ROLES = [{ name: "Adopted Staff", color: 5 }];

function plan(w: World, claims: Claim[] = CLAIMS) {
  const scanned = scan(w);
  const built = buildClaimsDesiredState(claims, {
    scanned,
    groups: [],
    integrationRoleIds: new Set(["carl"]),
    syncedToParent: new Map(),
    membersIntent: true,
    suggestedPrefix: null,
    voiceMigrationDone: true,
    approvedAt: "2026-10-01T10:00:00Z",
  });
  const desired = {
    ...built.desired,
    roles: [...(built.desired.roles ?? []), ...EXTRA_ROLES],
  };
  return {
    built,
    plan: planAdoption(scanned, desired, {
      approverId: "admin",
      gateTargetIds: built.gateTargetIds,
    }),
  };
}

/** A gateway, store and config that mutate `w`, like Discord would. */
function engine(w: World) {
  const writes: string[] = [];
  const records = new Map<string, SnapshotRecord>();
  let n = 0;
  const deps: Deps = {
    gateway: {
      createRole: async (i) => {
        const id = `new-role-${++n}`;
        w.roles.set(id, {
          id,
          name: i.name,
          color: i.color,
          permissions: i.permissions,
          position: i.position ?? 1,
          managed: false,
        });
        writes.push(`createRole:${i.name}`);
        return id;
      },
      editRole: async (id, c) => {
        w.roles.set(id, { ...w.roles.get(id)!, ...c });
        writes.push(`editRole:${id}`);
      },
      deleteRole: async (id) => {
        w.roles.delete(id);
        writes.push(`deleteRole:${id}`);
      },
      setOverwrite: async (ch, o) => {
        const c = w.channels.get(ch)!;
        c.overwrites = [...c.overwrites.filter((x) => x.id !== o.id), clone(o)];
        writes.push(`setOverwrite:${ch}:${o.id}`);
      },
      removeOverwrite: async (ch, t) => {
        const c = w.channels.get(ch)!;
        c.overwrites = c.overwrites.filter((x) => x.id !== t);
        writes.push(`removeOverwrite:${ch}:${t}`);
      },
      deleteChannel: async (id) => {
        w.channels.delete(id);
        writes.push(`deleteChannel:${id}`);
      },
      recreateChannel: async (c) => {
        w.channels.set(c.id, clone(c));
        return c.id;
      },
      addMemberRole: async () => true,
      removeMemberRole: async () => undefined,
      memberHasRole: async () => false,
      readRole: async (id) => clone(w.roles.get(id) ?? null),
      readChannel: async (id) => clone(w.channels.get(id) ?? null),
      setChannelParent: async (id, parent) => {
        w.channels.get(id)!.parentId = parent;
      },
      findChannel: async () => null,
      findRoleByName: async () => null,
    },
    store: {
      create: async (rec) => {
        const full = {
          ...rec,
          id: `snap-${records.size + 1}`,
          rolledBackBy: null,
        } as SnapshotRecord;
        records.set(full.id, full);
        return clone(full);
      },
      get: async (id) => (records.has(id) ? clone(records.get(id)!) : null),
      update: async (id, patch) => {
        Object.assign(records.get(id)!, clone(patch));
      },
      recoverStale: async () => 0,
      claim: async (id, from, to) => {
        const rec = records.get(id);
        if (!rec || !from.includes(rec.status)) return false;
        rec.status = to;
        return true;
      },
    },
    config: {
      set: async (k, v) => {
        w.config.set(k, v);
        writes.push(`config:${k}`);
      },
      delete: async (k) => {
        w.config.delete(k);
      },
      validate: async () => [],
      read: async (k) => w.config.get(k) ?? null,
      hasOverride: async (k) => w.config.has(k),
      reload: async () => undefined,
    },
    callApi: async (call) => call(),
    audit: async () => undefined,
    auditStrict: async () => undefined,
    sleep: async () => undefined,
  };
  return { service: new ServerAdoptionService(deps), writes, records };
}

const applyOpts = {
  actor,
  batchDelayMs: 0,
  revalidate: async (): Promise<string[]> => [],
};

describe("server adoption, end to end on the reference server", () => {
  let world: World;
  let before: World;
  beforeEach(() => {
    world = referenceServer();
    before = {
      roles: new Map(clone([...world.roles])),
      channels: new Map(clone([...world.channels])),
      config: new Map(world.config),
    };
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
    const configSets = Object.fromEntries(
      p.operations.flatMap((o) =>
        o.type === "config.set" ? [[o.key, o.value]] : [],
      ),
    );
    expect(configSets).toMatchObject({
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
    const touched = new Set(
      p.operations.flatMap((o) =>
        o.type === "overwrite.set" ? [o.channelId] : [],
      ),
    );
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

  it("applies, is idempotent, and rolls back to the exact original server", async () => {
    const { service, writes, records } = engine(world);
    const first = plan(world).plan;
    const result = await service.apply(first, applyOpts);
    expect(result.status).toBe("applied");
    expect(result.failed).toEqual([]);

    // Applied: channels are gated / read-only and settings are bound.
    expect(world.config.get("quotes.channel_id")).toBe("quotes");
    expect(
      world.channels.get("news")!.overwrites.some((o) => o.id === GUILD),
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
      expect(world.channels.get(id)).toEqual(before.channels.get(id));
    }
    expect(writes.some((w) => w.startsWith("deleteChannel"))).toBe(false);

    // Idempotent: planning the adopted server again gives an empty plan
    // (the extra role now exists by name, so it is not created twice).
    const again = plan(world);
    expect(again.plan.errors).toEqual([]);
    expect(again.plan.operations).toEqual([]);

    // Roll back: every touched channel, role and setting is back.
    const back = await service.rollback(result.snapshotId, {
      actor,
      deleteCreatedRoles: true,
    });
    expect(back.failed).toEqual([]);
    expect(records.get(result.snapshotId)!.status).toBe("rolled_back");
    expect([...world.channels.values()]).toEqual([...before.channels.values()]);
    expect([...world.roles.values()]).toEqual([...before.roles.values()]);
    expect([...world.config]).toEqual([...before.config]);

    // A restored server plans exactly like the original again.
    expect(plan(world).plan.operations).toHaveLength(first.operations.length);
  });

  it("leaves a role the plan created in place unless asked to delete it", async () => {
    const { service } = engine(world);
    const result = await service.apply(plan(world).plan, applyOpts);
    await service.rollback(result.snapshotId, { actor });
    expect(
      [...world.roles.values()].some((r) => r.name === "Adopted Staff"),
    ).toBe(true);
    expect([...world.channels.values()]).toEqual([...before.channels.values()]);
  });

  it("refuses to roll the same snapshot back twice", async () => {
    const { service } = engine(world);
    const result = await service.apply(plan(world).plan, applyOpts);
    await service.rollback(result.snapshotId, { actor });
    await expect(
      service.rollback(result.snapshotId, { actor }),
    ).rejects.toThrow(/already rolled back/);
  });
});
