/**
 * Shared simulated Discord server for the server-adoption end-to-end tests
 * (#1025, #1180, epic #1017).
 *
 * One `World` holds a server as plain data (roles, channels, config, members,
 * webhooks). Two pipelines read it, so the fixtures are written once:
 *
 * - the legacy hand-built scan (`scanHand` / `planHand`), used by the
 *   reference-server test, which keeps readable ids;
 * - the production path (`guildFromWorld` -> `ServerScanService.scanGuild` ->
 *   `planChannelClaims`, `planRulesGate`, `planRoleGroups`, `planRoleDeletion`),
 *   which reads the server through discord.js-shaped objects and so needs
 *   snowflake ids (`sf`).
 *
 * `engine(world)` is a gateway, snapshot store and config writer that really
 * mutate the world, so "apply", "an empty re-plan" and "rollback restores the
 * original" are checked against state. Its gateway is wrapped so every method
 * the engine touches is recorded: the webhook assertions check the exact
 * webhook set and that no webhook-shaped call was ever made. (`AdoptionGateway`
 * has no webhook method at all, so a webhook can only change through a channel
 * delete, which takes the channel's webhooks with it, as in Discord.)
 *
 * This module must be imported dynamically from a test, after the test file's
 * own imports, because it registers module mocks before loading the services.
 */

import { jest } from "@jest/globals";
import { ChannelType, PermissionsBitField } from "discord.js";

jest.unstable_mockModule("../../src/utils/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

/** Per-test switches the mocked models read. */
export const harness = {
  /** Has the first managed-only voice cleanup run for this server? */
  voiceMigrationDone: true,
  /** Role groups the mocked `RoleGroupService` lists. */
  groups: [] as unknown[],
  /** Features the mocked `RoleGroupService` says use a role. */
  roleUses: [] as string[],
};

jest.unstable_mockModule("../../src/models/reaction-role-config.js", () => ({
  ReactionRoleConfig: { distinct: async () => [] },
}));
jest.unstable_mockModule("../../src/models/managed-voice-channel.js", () => ({
  ManagedVoiceMigration: {
    findOne: () => ({
      lean: async () => (harness.voiceMigrationDone ? { guildId: "x" } : null),
    }),
  },
}));

const { ConfigService } = await import("../../src/services/config-service.js");
const { RoleGroupService } =
  await import("../../src/services/role-group-service.js");
const { defaultConfig } = await import("../../src/services/config-schema.js");
const { ServerAdoptionService, DiscordAdoptionGateway } =
  await import("../../src/services/server-adoption-service.js");
const { planAdoption } =
  await import("../../src/services/server-adoption-planner.js");
const { ServerScanService, detectNamingConvention } =
  await import("../../src/services/server-scan-service.js");
const { buildClaimsDesiredState, staleDestructiveSteps } =
  await import("../../src/services/channel-claims.js");
const { planChannelClaims, claimsRevalidator, claimsPlanIsApplicable } =
  await import("../../src/services/channel-claims-adoption.js");
const {
  planRoleGroups,
  planRoleDeletion,
  roleDeletionRevalidator,
  planIsApplicable,
} = await import("../../src/services/role-group-adoption.js");
const { planRulesGate, rulesPlanIsApplicable } =
  await import("../../src/services/rules-adoption.js");
const { detectFeeds } =
  await import("../../src/services/channel-claims-suggestions.js");

export {
  planAdoption,
  detectNamingConvention,
  buildClaimsDesiredState,
  staleDestructiveSteps,
  planChannelClaims,
  claimsRevalidator,
  claimsPlanIsApplicable,
  planRoleGroups,
  planRoleDeletion,
  roleDeletionRevalidator,
  planIsApplicable,
  planRulesGate,
  rulesPlanIsApplicable,
  ServerAdoptionService,
};

export type Deps =
  import("../../src/services/server-adoption-service.js").AdoptionDeps;
export type SnapshotRecord =
  import("../../src/services/server-adoption-service.js").AdoptionSnapshotRecord;
export type Scanned =
  import("../../src/services/server-adoption-planner.js").ScannedState;
export type RoleState =
  import("../../src/services/server-adoption-planner.js").RoleState;
export type ChannelState =
  import("../../src/services/server-adoption-planner.js").ChannelState;
export type ConfigValue =
  import("../../src/services/server-adoption-planner.js").ConfigValue;
export type AdoptionPlan =
  import("../../src/services/server-adoption-planner.js").AdoptionPlan;
export type PlanOperation =
  import("../../src/services/server-adoption-planner.js").PlanOperation;
export type Claim = import("../../src/services/channel-claims.js").ChannelClaim;
export type RoleGroupView =
  import("../../src/services/role-group-service.js").RoleGroupView;

export const F = PermissionsBitField.Flags;
export const VIEW = F.ViewChannel.toString();
export const ADMIN = F.Administrator.toString();

export const KOOLBOT_USER = "koolbot-user";

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

const registry = new Map<string, string>();
/**
 * A stable snowflake-shaped id for a readable key. The production scan only
 * recognises snowflakes in config bindings, so fixtures that run through it
 * name things by key and get numeric ids. The id comes from a hash of the key,
 * not from call order, so it is the same on every run and under `-t`.
 */
export const sf = (key: string): string => {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < key.length; i++) {
    h1 = Math.imul(h1 ^ key.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + key.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  const num = (BigInt(h1) << 32n) | BigInt(h2);
  const id = String(100000000000000000n + (num % 800000000000000000n));
  const owner = [...registry].find(([, v]) => v === id)?.[0];
  if (owner !== undefined && owner !== key) {
    throw new Error(`sf(): "${key}" collides with "${owner}"`);
  }
  registry.set(key, id);
  return id;
};

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

export interface WebhookState {
  id: string;
  name: string;
  channelId: string;
  kind: "incoming" | "channel-follower" | "application";
}
export interface MemberState {
  bot: boolean;
  roleIds: string[];
}

export interface World {
  guildId: string;
  ownerId: string;
  /** The admin who runs the adoption. */
  adminId: string;
  roles: Map<string, RoleState>;
  channels: Map<string, ChannelState>;
  config: Map<string, ConfigValue>;
  webhooks: Map<string, WebhookState>;
  members: Map<string, MemberState>;
  /** Managed integration roles: role id -> the bot that owns them. */
  botRoles: Map<string, string>;
  /** Channels whose permissions are synced to their category. */
  synced: Set<string>;
  features: string[];
  rulesChannelId: string | null;
  afkChannelId: string | null;
  /** Roles an Onboarding prompt hands out (fixture metadata, never written). */
  onboardingRoleIds: string[];
}

export const role = (
  id: string,
  name: string,
  position: number,
  permissions = "0",
  managed = false,
): RoleState => ({ id, name, color: 0, permissions, position, managed });

/** Discord channel types the fixtures use. */
export const T = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  category: ChannelType.GuildCategory,
  announcement: ChannelType.GuildAnnouncement,
  forum: ChannelType.GuildForum,
  stage: ChannelType.GuildStageVoice,
} as const;

/** The kind the server scan reports for a channel type (forums are "other"). */
const kindOfType = (type: number): ChannelState["kind"] =>
  type === T.category
    ? "category"
    : type === T.text || type === T.announcement
      ? "text"
      : type === T.voice || type === T.stage
        ? "voice"
        : "other";

/** Positions come from the order a fixture lists channels in (see `worldOf`). */
export const channel = (
  id: string,
  name: string,
  type: number,
  parentId: string | null = null,
  overwrites: ChannelState["overwrites"] = [],
  extra: { voiceMemberCount?: number; topic?: string } = {},
): ChannelState => ({
  id,
  name,
  kind: kindOfType(type),
  rawType: type,
  parentId,
  position: 0,
  topic: extra.topic ?? null,
  overwrites,
  voiceMemberCount: extra.voiceMemberCount ?? 0,
});

export const hiddenFrom = (
  guildId: string,
  allowRole: string,
): ChannelState["overwrites"] => [
  { id: guildId, type: "role", allow: "0", deny: VIEW },
  { id: allowRole, type: "role", allow: VIEW, deny: "0" },
];

export const webhook = (
  id: string,
  channelId: string,
  kind: WebhookState["kind"] = "incoming",
  name = id,
): WebhookState => ({ id, name, channelId, kind });

export function worldOf(input: {
  guildId: string;
  ownerId: string;
  adminId: string;
  roles: RoleState[];
  channels: ChannelState[];
  members: Array<[string, MemberState]>;
  botRoles?: Array<[string, string]>;
  webhooks?: WebhookState[];
  config?: Array<[string, ConfigValue]>;
  synced?: string[];
  features?: string[];
  rulesChannelId?: string | null;
  afkChannelId?: string | null;
  onboardingRoleIds?: string[];
}): World {
  return {
    guildId: input.guildId,
    ownerId: input.ownerId,
    adminId: input.adminId,
    roles: new Map(input.roles.map((r) => [r.id, r])),
    channels: new Map(
      input.channels.map((c, i) => [c.id, { ...c, position: i }]),
    ),
    config: new Map<string, ConfigValue>([
      ["adoption.snapshot.retention_days", 90],
      ...(input.config ?? []),
    ]),
    webhooks: new Map((input.webhooks ?? []).map((h) => [h.id, h])),
    members: new Map(input.members),
    botRoles: new Map(input.botRoles ?? []),
    synced: new Set(input.synced ?? []),
    features: input.features ?? [],
    rulesChannelId: input.rulesChannelId ?? null,
    afkChannelId: input.afkChannelId ?? null,
    onboardingRoleIds: input.onboardingRoleIds ?? [],
  };
}

/** A deep, comparable copy of everything an adoption may touch (or must not). */
export function snapshotOf(w: World): {
  roles: RoleState[];
  channels: ChannelState[];
  config: Array<[string, ConfigValue]>;
  webhooks: WebhookState[];
  members: Array<[string, MemberState]>;
} {
  return clone({
    roles: [...w.roles.values()],
    channels: [...w.channels.values()],
    config: [...w.config],
    webhooks: [...w.webhooks.values()],
    members: [...w.members],
  });
}

const botOf = (w: World): MemberState => w.members.get(KOOLBOT_USER)!;
const botRoleIds = (w: World): string[] => botOf(w).roleIds;
const otherBots = (w: World): string[] =>
  [...w.members].flatMap(([id, m]) =>
    m.bot && id !== KOOLBOT_USER ? [id] : [],
  );

// ---------------------------------------------------------------------------
// Pipeline 1: the hand-built scan (reference server)
// ---------------------------------------------------------------------------

/** Stored values over the schema defaults, as `readEffectiveConfig` reports them. */
function effectiveConfig(w: World): Record<string, ConfigValue> {
  const out: Record<string, ConfigValue> = {};
  for (const [k, v] of Object.entries(
    defaultConfig as unknown as Record<string, unknown>,
  )) {
    if (
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean"
    ) {
      out[k] = v;
    }
  }
  for (const [k, v] of w.config) out[k] = v;
  return out;
}

/** What a fresh scan of the simulated server would report. */
export function scanHand(w: World): Scanned {
  const bound = new Set<string>();
  for (const [k, v] of w.config) {
    if (/(\.channel_id|\.category_id)$/.test(k) && typeof v === "string") {
      bound.add(v);
    }
  }
  const botPositions = botRoleIds(w).map((id) => w.roles.get(id)!.position);
  return {
    guildId: w.guildId,
    ownerId: w.ownerId,
    botUserId: KOOLBOT_USER,
    botRoleIds: botRoleIds(w),
    botHighestRolePosition: Math.max(0, ...botPositions),
    adminUserId: w.adminId,
    adminRoleIds: w.members.get(w.adminId)?.roleIds ?? [],
    otherBotIds: otherBots(w),
    roles: clone([...w.roles.values()]),
    channels: clone([...w.channels.values()]),
    config: effectiveConfig(w),
    memberRoles: {},
    boundChannelIds: [...bound],
    koolbotCreatedIds: [],
  };
}

/** Webhooks as the scan reports them, and the feeds production detects in them. */
export function feedsOf(w: World): ReturnType<typeof detectFeeds> {
  return detectFeeds({
    channels: [...w.channels.values()].map((c) => ({
      id: c.id,
      kind: c.kind,
      flags: {
        forum: c.rawType === T.forum,
      },
    })),
    webhooks: {
      known: true,
      list: [...w.webhooks.values()],
      unavailable: null,
    },
  } as never);
}

export const APPROVED_AT = "2026-10-01T10:00:00Z";

/** Roles a hand-planned test wants created on top of the claims. */
export function planHand(
  w: World,
  claims: Claim[],
  opts: { extraRoles?: Array<{ name: string; color: number }> } = {},
) {
  const scanned = scanHand(w);
  const built = buildClaimsDesiredState(claims, {
    scanned,
    groups: [],
    integrationRoleIds: new Set(w.botRoles.keys()),
    syncedToParent: new Map(),
    membersIntent: true,
    suggestedPrefix: null,
    voiceMigrationDone: true,
    feeds: feedsOf(w),
    approvedAt: APPROVED_AT,
  });
  const desired = {
    ...built.desired,
    roles: [...(built.desired.roles ?? []), ...(opts.extraRoles ?? [])],
  };
  return {
    built,
    plan: planAdoption(scanned, desired, {
      approverId: w.adminId,
      gateTargetIds: built.gateTargetIds,
    }),
  };
}

// ---------------------------------------------------------------------------
// Pipeline 2: discord.js-shaped objects the production code reads
// ---------------------------------------------------------------------------

/** How many times each Discord read was made (a scale check, not a timer). */
export type Reads = Record<string, number>;

export function guildFromWorld(w: World, reads: Reads = {}): any {
  const hit = (name: string): void => {
    reads[name] = (reads[name] ?? 0) + 1;
  };
  const roleObject = (r: RoleState): any => ({
    id: r.id,
    name: r.name,
    position: r.position,
    color: r.color,
    managed: r.managed,
    tags: w.botRoles.has(r.id) ? { botId: w.botRoles.get(r.id) } : undefined,
    // Only walked by the scan, which asks for the holders of every role once.
    get members() {
      return new Map(
        [...w.members].flatMap(([id, m]) =>
          m.roleIds.includes(r.id) ? [[id, {}] as const] : [],
        ),
      );
    },
    permissions: { bitfield: BigInt(r.permissions) },
  });
  const roleObjects = (): Map<string, any> =>
    new Map([...w.roles.values()].map((r) => [r.id, roleObject(r)]));
  const memberObject = (id: string, m: MemberState): any => {
    const held = m.roleIds.flatMap((r) =>
      w.roles.has(r) ? [roleObject(w.roles.get(r)!)] : [],
    );
    const highest = held.reduce(
      (a, b) => (b.position > a.position ? b : a),
      roleObject(w.roles.get(w.guildId)!),
    );
    const bits = [w.guildId, ...m.roleIds].reduce(
      (acc, r) => acc | BigInt(w.roles.get(r)?.permissions ?? "0"),
      0n,
    );
    return {
      id,
      displayName: id,
      user: { bot: m.bot, tag: `${id}#0`, flags: null },
      permissions: {
        bitfield: bits,
        has: (flag: bigint) =>
          (bits & F.Administrator) === F.Administrator ||
          (bits & flag) === flag,
      },
      roles: {
        cache: new Map(held.map((r) => [r.id, r])),
        highest,
      },
    };
  };
  const members = (): Map<string, any> =>
    new Map([...w.members].map(([id, m]) => [id, memberObject(id, m)]));
  /** discord.js collections map to arrays; the gateway reads overwrites that way. */
  class Collection<V> extends Map<string, V> {
    map<R>(fn: (v: V) => R): R[] {
      return [...this.values()].map(fn);
    }
  }
  const channelObject = (c: ChannelState): any => ({
    id: c.id,
    name: c.name,
    type: c.rawType,
    parentId: c.parentId,
    rawPosition: c.position,
    position: c.position,
    topic: c.topic,
    permissionsLocked: c.parentId ? w.synced.has(c.id) : undefined,
    members: c.kind === "voice" ? { size: c.voiceMemberCount } : undefined,
    permissionOverwrites: {
      cache: new Collection(
        c.overwrites.map((o) => [
          o.id,
          {
            id: o.id,
            type: o.type === "role" ? 0 : 1,
            allow: { bitfield: BigInt(o.allow) },
            deny: { bitfield: BigInt(o.deny) },
          },
        ]),
      ),
    },
    isThread: () => false,
    isVoiceBased: () => c.rawType === T.voice || c.rawType === T.stage,
    isTextBased: () => c.kind !== "category",
    messages: {
      fetch: async (id: string) => {
        if (
          c.id === w.rulesChannelId &&
          id === w.config.get("rules.message_id")
        ) {
          return {
            author: { id: KOOLBOT_USER },
            components: [{ components: [{ customId: "rules:accept" }] }],
          };
        }
        throw Object.assign(new Error("Unknown Message"), { code: 10008 });
      },
    },
  });
  const channelObjects = (): Map<string, any> =>
    new Map([...w.channels.values()].map((c) => [c.id, channelObject(c)]));
  const webhookType = { incoming: 1, "channel-follower": 2, application: 3 };
  return {
    id: w.guildId,
    name: "Fixture",
    ownerId: w.ownerId,
    memberCount: w.members.size,
    afkChannelId: w.afkChannelId,
    rulesChannelId: w.rulesChannelId,
    systemChannelId: null,
    publicUpdatesChannelId: null,
    features: w.features,
    client: {
      user: { id: KOOLBOT_USER },
      options: { intents: { has: () => true } },
    },
    roles: {
      get cache() {
        return roleObjects();
      },
      get everyone() {
        return roleObjects().get(w.guildId);
      },
      fetch: async (id?: string) => {
        if (id) {
          hit("roles.fetchOne");
          const r = w.roles.get(id);
          return r ? roleObject(r) : null;
        }
        hit("roles.fetch");
        return roleObjects();
      },
      fetchMemberCounts: async () => {
        hit("roles.fetchMemberCounts");
        return new Map(
          [...roleObjects()].map(([id, r]) => [id, r.members.size]),
        );
      },
    },
    channels: {
      get cache() {
        return channelObjects();
      },
      fetch: async (id?: string) => {
        if (id) {
          hit("channels.fetchOne");
          const c = w.channels.get(id);
          return c ? channelObject(c) : null;
        }
        hit("channels.fetch");
        return channelObjects();
      },
    },
    members: {
      get cache() {
        return members();
      },
      get me() {
        return memberObject(KOOLBOT_USER, w.members.get(KOOLBOT_USER)!);
      },
      fetchMe: async () =>
        memberObject(KOOLBOT_USER, w.members.get(KOOLBOT_USER)!),
      fetch: async (id?: string) => {
        hit(id ? "members.fetchOne" : "members.fetchAll");
        if (!id) return members();
        const m = w.members.get(id);
        if (!m) {
          throw Object.assign(new Error("Unknown Member"), { code: 10007 });
        }
        return memberObject(id, m);
      },
    },
    fetchWebhooks: async () => {
      hit("fetchWebhooks");
      return new Map(
        [...w.webhooks.values()].map((h) => [
          h.id,
          {
            id: h.id,
            name: h.name,
            channelId: h.channelId,
            type: webhookType[h.kind],
          },
        ]),
      );
    },
    fetchOnboarding: async () => {
      hit("fetchOnboarding");
      return {
        enabled: w.onboardingRoleIds.length > 0,
        defaultChannels: new Map(),
        prompts: new Map(
          w.onboardingRoleIds.length > 0
            ? [
                [
                  "prompt",
                  {
                    title: "Pick your region",
                    options: new Map(
                      w.onboardingRoleIds.map((r) => [
                        r,
                        { roles: new Map([[r, {}]]), channels: new Map() },
                      ]),
                    ),
                  },
                ],
              ]
            : [],
        ),
      };
    },
    scheduledEvents: { fetch: async () => new Map() },
  };
}

/** Point the mocked services at this world. Call before planning. */
export function useWorld(w: World): void {
  const effective = (key: string): unknown =>
    w.config.has(key)
      ? w.config.get(key)
      : (defaultConfig as unknown as Record<string, unknown>)[key];
  jest.spyOn(ConfigService, "getInstance").mockReturnValue({
    getAll: async () => [...w.config].map(([key, value]) => ({ key, value })),
    getString: async (key: string, def = "") => {
      const v = effective(key);
      return typeof v === "string" ? v : def;
    },
    getBoolean: async (key: string, def = false) => {
      const v = effective(key);
      return typeof v === "boolean" ? v : def;
    },
  } as never);
  jest.spyOn(RoleGroupService, "getInstance").mockReturnValue({
    list: async () => clone(harness.groups),
    trackRoleNames: async () => undefined,
    featureUsesOfRole: async () => [...harness.roleUses],
  } as never);
  ServerScanService.reset();
}

/** The production claims planner, scan included, on this world. */
export async function planClaims(w: World, claims: Claim[], reads: Reads = {}) {
  useWorld(w);
  return planChannelClaims(
    guildFromWorld(w, reads) as never,
    w.adminId,
    claims,
    APPROVED_AT,
  );
}

/** The production live-state check for a claims plan, read from this world. */
export function revalidatorFor(
  w: World,
  claims: Claim[],
): (pending: PlanOperation[]) => Promise<string[]> {
  useWorld(w);
  return claimsRevalidator(
    guildFromWorld(w) as never,
    w.adminId,
    claims,
    APPROVED_AT,
  );
}

// ---------------------------------------------------------------------------
// The engine: a gateway, store and config that mutate the world
// ---------------------------------------------------------------------------

export const actorFor = (w: World): never =>
  ({
    sessionId: "s",
    discordUserId: w.adminId,
    guildId: w.guildId,
    role: "admin",
  }) as never;

/** Every gateway method. Anything else the engine reached for is a surprise. */
export const GATEWAY_METHODS = [
  "createRole",
  "editRole",
  "deleteRole",
  "setOverwrite",
  "removeOverwrite",
  "deleteChannel",
  "recreateChannel",
  "addMemberRole",
  "removeMemberRole",
  "memberHasRole",
  "readRole",
  "readChannel",
  "setChannelParent",
  "findChannel",
  "findRoleByName",
] as const;

const WRITE_METHODS = new Set<string>([
  "createRole",
  "editRole",
  "deleteRole",
  "setOverwrite",
  "removeOverwrite",
  "deleteChannel",
  "recreateChannel",
  "addMemberRole",
  "removeMemberRole",
  "setChannelParent",
]);

export function engine(
  w: World,
  opts: {
    /** Test hook: report another `kind` for a live channel (see #1244). */
    liveKind?: (
      rawType: number | undefined,
    ) => ChannelState["kind"] | undefined;
  } = {},
) {
  const writes: string[] = [];
  const calls: string[] = [];
  const audits: string[] = [];
  const accessed = new Set<string>();
  const records = new Map<string, SnapshotRecord>();
  let n = 0;
  const realReads = new DiscordAdoptionGateway(guildFromWorld(w) as never);
  const member = (id: string): MemberState => {
    const m = w.members.get(id);
    if (!m) throw new Error(`Unknown member ${id}`);
    return m;
  };
  const impl = {
    createRole: async (i: {
      name: string;
      color: number;
      permissions: string;
      position: number | null;
    }) => {
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
    editRole: async (id: string, c: Partial<RoleState>) => {
      w.roles.set(id, { ...w.roles.get(id)!, ...c });
      writes.push(`editRole:${id}`);
    },
    deleteRole: async (id: string) => {
      w.roles.delete(id);
      // Discord drops the role from every member and every overwrite.
      for (const m of w.members.values()) {
        m.roleIds = m.roleIds.filter((r) => r !== id);
      }
      for (const c of w.channels.values()) {
        c.overwrites = c.overwrites.filter((o) => o.id !== id);
      }
      writes.push(`deleteRole:${id}`);
    },
    setOverwrite: async (ch: string, o: ChannelState["overwrites"][number]) => {
      const c = w.channels.get(ch)!;
      c.overwrites = [...c.overwrites.filter((x) => x.id !== o.id), clone(o)];
      writes.push(`setOverwrite:${ch}:${o.id}`);
    },
    removeOverwrite: async (ch: string, t: string) => {
      const c = w.channels.get(ch)!;
      c.overwrites = c.overwrites.filter((x) => x.id !== t);
      writes.push(`removeOverwrite:${ch}:${t}`);
    },
    deleteChannel: async (id: string) => {
      w.channels.delete(id);
      // Discord deletes a channel's webhooks with it.
      for (const [hid, h] of w.webhooks) {
        if (h.channelId === id) w.webhooks.delete(hid);
      }
      writes.push(`deleteChannel:${id}`);
    },
    recreateChannel: async (c: ChannelState) => {
      // A recreated channel comes back without its webhooks.
      w.channels.set(c.id, clone(c));
      writes.push(`recreateChannel:${c.id}`);
      return c.id;
    },
    addMemberRole: async (memberId: string, roleId: string) => {
      const m = member(memberId);
      if (m.roleIds.includes(roleId)) return false;
      m.roleIds.push(roleId);
      writes.push(`addMemberRole:${memberId}:${roleId}`);
      return true;
    },
    removeMemberRole: async (memberId: string, roleId: string) => {
      const m = member(memberId);
      m.roleIds = m.roleIds.filter((r) => r !== roleId);
      writes.push(`removeMemberRole:${memberId}:${roleId}`);
    },
    // Reads go through the production gateway, over discord.js-shaped objects
    // of this world, so how it classifies a role or a channel is what the
    // plan's baseline is compared with.
    memberHasRole: (memberId: string, roleId: string) =>
      realReads.memberHasRole(memberId, roleId),
    readRole: (id: string) => realReads.readRole(id),
    readChannel: async (id: string) => {
      const live = await realReads.readChannel(id);
      const kind = live ? opts.liveKind?.(live.rawType) : undefined;
      return live && kind ? { ...live, kind } : live;
    },
    setChannelParent: async (id: string, parent: string) => {
      w.channels.get(id)!.parentId = parent;
      writes.push(`setChannelParent:${id}`);
    },
    findChannel: async () => null,
    findRoleByName: async () => null,
  };
  const gateway = new Proxy(impl, {
    get(target, prop) {
      const name = String(prop);
      accessed.add(name);
      const fn = (target as Record<string, unknown>)[name];
      if (typeof fn !== "function") {
        throw new Error(
          `The engine reached for gateway.${name}, which is not modelled`,
        );
      }
      return (...args: unknown[]) => {
        calls.push(name);
        return (fn as (...a: unknown[]) => unknown)(...args);
      };
    },
  }) as unknown as Deps["gateway"];

  const effective = (k: string): ConfigValue | null => {
    if (w.config.has(k)) return w.config.get(k)!;
    const d = (defaultConfig as unknown as Record<string, unknown>)[k];
    return typeof d === "string" ||
      typeof d === "number" ||
      typeof d === "boolean"
      ? d
      : null;
  };
  const deps: Deps = {
    gateway,
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
      read: async (k) => effective(k),
      hasOverride: async (k) => w.config.has(k),
      reload: async () => undefined,
    },
    callApi: async (call) => call(),
    audit: async (_session, entry) => {
      audits.push(`${entry.action}:${entry.result}`);
    },
    auditStrict: async (_session, entry) => {
      audits.push(`${entry.action}:${entry.result}`);
    },
    sleep: async () => undefined,
  };
  return {
    service: new ServerAdoptionService(deps),
    writes,
    calls,
    audits,
    accessed,
    records,
    /** Gateway writes only, by method name. */
    writeCalls: (): string[] => calls.filter((c) => WRITE_METHODS.has(c)),
  };
}

export const applyOpts = (
  w: World,
  revalidate: (pending: PlanOperation[]) => Promise<string[]> = async () => [],
) => ({ actor: actorFor(w), batchDelayMs: 0, revalidate });
