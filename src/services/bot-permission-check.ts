/**
 * Which Discord permissions the bot is missing for the features that are in
 * use, and where (#1217). Read-only: nothing here writes to Discord or Mongo.
 *
 * What is checked is `FEATURE_REQUIREMENTS` (the table the acting services take
 * their permission bits from), against the bot's effective permissions:
 * `me.permissionsIn(channel)` for a category or channel, so an overwrite that
 * denies a permission the role has server-wide counts as missing, and
 * `me.permissions` only for the server-wide features.
 *
 * A feature is only reported as affected while it is in use: its `*.enabled`
 * setting is on and its category or channel is configured. A permission that
 * only a disabled feature would need is returned separately as a quiet note.
 *
 * Freshness: the bot member, the roles and the channels (with their
 * overwrites) are re-read from Discord through
 * `CommandManager.makeDiscordApiCall` (timeout and rate-limit backoff), at most
 * once per `SNAPSHOT_TTL_MS` per server, and concurrent requests share one
 * read. When Discord cannot be reached the gateway cache is used and the
 * report says so (`fresh: false`); when even that is missing a feature is
 * `unknown`, which the UI never shows as fine.
 */

import {
  ChannelType,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type Role,
} from "discord.js";
import { ConfigService } from "./config-service.js";
import { defaultConfig } from "./config-schema.js";
import { parseLeaderboardTiers } from "./leaderboard-tier-parse.js";
import {
  FEATURE_REQUIREMENTS,
  missingNeeds,
  ROLE_HIERARCHY_REQUIREMENTS,
  type FeatureRequirement,
  type RoleHierarchyRequirement,
} from "./bot-permission-registry.js";
import { setPermissionIssueCount } from "./bot-permission-status.js";
import logger from "../utils/logger.js";

/** A re-read of the server is reused for this long (a constant, not a setting: it only bounds Discord traffic). */
export const SNAPSHOT_TTL_MS = 30_000;

export const ROLE_ABOVE_BOT = "Bot role below this role";

export interface PermissionTarget {
  kind: "server" | "category" | "channel" | "role";
  id: string | null;
  name: string;
}

export interface FeatureRef {
  id: string;
  area: string;
  feature: string;
  effect: string;
  fix: string;
}

/** One missing permission in one place, with the features in use that it affects. */
export interface MissingPermission {
  permission: string;
  target: PermissionTarget;
  features: FeatureRef[];
}

export interface UnknownCheck {
  feature: FeatureRef;
  target: PermissionTarget;
  note: string;
}

/** A permission only a switched-off feature would need: not a problem today. */
export interface QuietNote {
  feature: FeatureRef;
  target: PermissionTarget;
  missing: string[];
}

/**
 * How one registry entry turned out, for the permission matrix. `ok`: the
 * bot has what it needs there; `missing`: `missing` names what it lacks;
 * `unknown`: it could not be checked; `unchecked`: nothing to check (no
 * category or channel configured, or a role-position entry whose feature is off).
 */
export type CheckOutcome = "ok" | "missing" | "unknown" | "unchecked";

export interface FeatureCheck {
  feature: FeatureRef;
  /** `permission` rows come from `FEATURE_REQUIREMENTS`, `role-position` from `ROLE_HIERARCHY_REQUIREMENTS`. */
  kind: "permission" | "role-position";
  /** Whether the feature is switched on. */
  enabled: boolean;
  outcome: CheckOutcome;
  /** Where it was checked; null when nothing was (an `unchecked` entry). */
  target: PermissionTarget | null;
  /** The permission names (or `ROLE_ABOVE_BOT`) that are missing there. */
  missing: string[];
}

export interface BotPermissionReport {
  /** False when the server or the bot's membership cannot be read at all. */
  available: boolean;
  reason: string | null;
  /** The numbers come from a re-read of Discord; false = from the gateway cache. */
  fresh: boolean;
  /** What is broken today: a missing permission and the enabled features it affects. */
  problems: MissingPermission[];
  /** Enabled features that could not be checked. Never shown as fine. */
  unknown: UnknownCheck[];
  /** Missing permissions that only disabled features need. */
  quiet: QuietNote[];
  /** Enabled features that were checked and are fine. */
  okFeatures: FeatureRef[];
  /** Things worth saying that are not a finding (a feature is on but has no channel set). */
  notes: string[];
  /**
   * Every registry entry and what the check found, switched on or not. The
   * permission matrix is built from this; `problems`, `unknown`, `quiet` and
   * `okFeatures` stay as they were (the navigation badge counts `problems`).
   */
  checks: FeatureCheck[];
  /**
   * The bot's managed role's own server-wide permission bits (not @everyone's
   * or another role's, no channel overwrites, not widened by Administrator), for the "All Discord permissions" list. Null
   * when they could not be read.
   */
  serverPermissions?: bigint | null;
}

type ApiCall = <T>(fn: () => Promise<T>, name: string) => Promise<T>;

export interface CheckDeps {
  call?: ApiCall;
  /** How many role groups the server has (a read that rejects when it fails). */
  roleGroupCount?: (guildId: string) => Promise<number>;
  now?: () => number;
}

/** The few things the check needs from a collection of channels or roles. */
interface Lookup<T> {
  get(id: string): T | null | undefined;
  values(): Iterable<T | null>;
}

interface Snapshot {
  guild: Guild;
  me: GuildMember | null;
  fresh: boolean;
  /**
   * The channels and roles Discord just returned. A bulk fetch does not evict
   * what the gateway cache still holds, so a deletion the gateway missed would
   * still resolve from the cache; targets are looked up here when the read was
   * fresh (the gateway cache is only the labelled fallback).
   */
  channels: Lookup<GuildBasedChannel>;
  roles: Lookup<Role>;
}

const snapshots = new Map<
  string,
  {
    /** When the read settled; null while it is still running. */
    settledAt: number | null;
    promise: Promise<Snapshot | null>;
  }
>();

/** Test hook: forget every cached read. */
export function resetBotPermissionCache(): void {
  snapshots.clear();
}

async function defaultCall<T>(
  client: Client,
  fn: () => Promise<T>,
  name: string,
): Promise<T> {
  const { CommandManager } = await import("./command-manager.js");
  // Reads are idempotent; a short timeout and one retry keep a page load quick.
  return CommandManager.getInstance(client).makeDiscordApiCall(
    fn,
    name,
    10000,
    2,
  );
}

async function loadSnapshot(
  client: Client,
  guildId: string,
  deps: CheckDeps,
): Promise<Snapshot | null> {
  const call: ApiCall =
    deps.call ??
    (<T>(fn: () => Promise<T>, name: string): Promise<T> =>
      defaultCall(client, fn, name));
  let guild: Guild | undefined = client.guilds?.cache?.get(guildId);
  if (!guild) {
    try {
      guild = await call(() => client.guilds.fetch(guildId), "perm-guild");
    } catch (err) {
      logger.warn("Bot permission check: the server could not be read:", err);
      return null;
    }
  }
  const server = guild;
  // Wait for all three reads to settle (not just the first failure), so the
  // snapshot, and with it the reuse TTL, is not settled while reads still run.
  const [roles, channels, member] = await Promise.allSettled([
    call(() => server.roles.fetch(), "perm-roles"),
    call(() => server.channels.fetch(), "perm-channels"),
    call(() => server.members.fetchMe({ force: true }), "perm-me"),
  ]);
  const failed = [roles, channels, member].find(
    (r): r is PromiseRejectedResult => r.status === "rejected",
  );
  if (failed) {
    logger.warn(
      "Bot permission check: Discord could not be reached, using the gateway cache:",
      failed.reason,
    );
    return {
      guild: server,
      me: server.members?.me ?? null,
      fresh: false,
      channels: server.channels?.cache as Lookup<GuildBasedChannel>,
      roles: server.roles?.cache as Lookup<Role>,
    };
  }
  return {
    guild: server,
    me:
      (member.status === "fulfilled" ? member.value : null) ??
      server.members?.me ??
      null,
    fresh: true,
    channels: (channels as PromiseFulfilledResult<unknown>)
      .value as Lookup<GuildBasedChannel>,
    roles: (roles as PromiseFulfilledResult<unknown>).value as Lookup<Role>,
  };
}

function getSnapshot(
  client: Client,
  guildId: string,
  deps: CheckDeps,
): Promise<Snapshot | null> {
  const now = (deps.now ?? Date.now)();
  const cached = snapshots.get(guildId);
  // A read that is still running is always shared (rate-limit backoff can
  // outlast the TTL); a settled one is reused for the TTL from when it settled.
  if (
    cached &&
    (cached.settledAt === null || now - cached.settledAt < SNAPSHOT_TTL_MS)
  ) {
    return cached.promise;
  }
  // A failed or cache-only result is kept for the TTL like any other, so an
  // outage cannot make every page load retry every read.
  const entry: {
    settledAt: number | null;
    promise: Promise<Snapshot | null>;
  } = {
    settledAt: null,
    promise: loadSnapshot(client, guildId, deps).then((s) => {
      entry.settledAt = (deps.now ?? Date.now)();
      return s;
    }),
  };
  snapshots.set(guildId, entry);
  return entry.promise;
}

function ref(r: {
  id: string;
  area: string;
  feature: string;
  effect: string;
  fix: string;
}): FeatureRef {
  return {
    id: r.id,
    area: r.area,
    feature: r.feature,
    effect: r.effect,
    fix: r.fix,
  };
}

const SERVER: PermissionTarget = {
  kind: "server",
  id: null,
  name: "the server",
};

/** The role ids a hierarchy requirement points at, from its configured value. */
export function configuredRoleIds(
  source: RoleHierarchyRequirement["roleSource"],
  raw: string,
): string[] {
  const value = raw.trim();
  if (!value) return [];
  if (source.kind === "id") return [value];
  // The tiers the leaderboard service acts on: malformed entries are ignored
  // and a repeated Top N keeps its last role.
  return [...new Set(parseLeaderboardTiers(value).map((t) => t.roleId))];
}

/**
 * Whether a feature is in use. Strict reads: a setting that cannot be read
 * rejects (the caller reports the check as unavailable) instead of looking
 * like "off".
 */
async function readFeatureState(
  config: ConfigService,
  r: Pick<FeatureRequirement, "enabledKey" | "alsoKey" | "usedWhen">,
  roleGroupsConfigured: () => Promise<boolean>,
): Promise<boolean> {
  if (r.usedWhen === "role-groups") return roleGroupsConfigured();
  // An absent setting reads as its schema default, as the services read it
  // (the room-status grant defaults to on).
  const on = (key: keyof typeof defaultConfig): Promise<boolean> =>
    config.getBooleanStrict(key, defaultConfig[key] === true);
  if (r.enabledKey && !(await on(r.enabledKey))) return false;
  if (r.alsoKey && !(await on(r.alsoKey))) return false;
  return true;
}

/**
 * The voice lobby the way the voice service finds it: the configured channel id
 * when it is a voice channel in the managed category, otherwise the voice
 * channel there with the lobby's (legacy-aware) name.
 */
async function resolveVoiceLobby(
  channels: Lookup<GuildBasedChannel>,
  config: ConfigService,
): Promise<{ categorySet: boolean; id: string }> {
  const categoryId = (
    await config.getStringStrict("voicechannels.category_id", "")
  ).trim();
  if (!categoryId) return { categorySet: false, id: "" };
  const lobbyId = (
    await config.getStringStrict("voicechannels.lobby.channel_id", "")
  ).trim();
  if (lobbyId) {
    const byId = channels?.get(lobbyId);
    if (
      byId &&
      byId.type === ChannelType.GuildVoice &&
      byId.parentId === categoryId
    ) {
      return { categorySet: true, id: lobbyId };
    }
  }
  const { resolveLobbyChannelName } =
    await import("./voice-channel-manager.js");
  const name = await resolveLobbyChannelName((key, d) =>
    config.getStringStrict(key, d),
  );
  for (const c of channels?.values() ?? []) {
    if (
      c &&
      c.type === ChannelType.GuildVoice &&
      c.parentId === categoryId &&
      c.name === name
    ) {
      return { categorySet: true, id: c.id };
    }
  }
  return { categorySet: true, id: "" };
}

async function defaultRoleGroupCount(guildId: string): Promise<number> {
  const { RoleGroupService } = await import("./role-group-service.js");
  return (await RoleGroupService.getInstance().list(guildId)).length;
}

/**
 * Check the bot's permissions for every feature in use. Never throws: an
 * unreadable server is `available: false`.
 */
export async function checkBotPermissions(
  client: Client,
  guildId: string,
  deps: CheckDeps = {},
): Promise<BotPermissionReport> {
  const empty = (reason: string, fresh: boolean): BotPermissionReport => ({
    available: false,
    reason,
    fresh,
    problems: [],
    unknown: [],
    quiet: [],
    okFeatures: [],
    notes: [],
    checks: [],
    serverPermissions: null,
  });
  const snapshot = await getSnapshot(client, guildId, deps);
  if (!snapshot) {
    return empty(
      "The bot could not read this server from Discord, so its permissions could not be checked.",
      false,
    );
  }
  const { me } = snapshot;
  const config = ConfigService.getInstance();
  // Read once per check, and only if a feature without a switch asks.
  let groupCount: Promise<number> | null = null;
  const roleGroupsConfigured = async (): Promise<boolean> => {
    groupCount ??= (deps.roleGroupCount ?? defaultRoleGroupCount)(guildId);
    return (await groupCount) > 0;
  };
  const dropOk = (id: string): void => {
    const at = okFeatures.findIndex((f) => f.id === id);
    if (at >= 0) okFeatures.splice(at, 1);
  };
  const problems = new Map<string, MissingPermission>();
  const unknown: UnknownCheck[] = [];
  const quiet: QuietNote[] = [];
  const okFeatures: FeatureRef[] = [];
  const notes: string[] = [];
  const checks: FeatureCheck[] = [];
  if (!snapshot.fresh) {
    notes.push(
      "Discord could not be reached, so this is read from the bot's cached view of the server and may be out of date.",
    );
  }
  if (!me) notes.push("The bot's own membership could not be read.");

  try {
    for (const r of FEATURE_REQUIREMENTS) {
      const inUse = await readFeatureState(config, r, roleGroupsConfigured);
      let targetId = "";
      let setting = String(r.targetKey);
      let lobbyMissing = false;
      if (r.targetResolver === "voice-lobby") {
        setting = "voicechannels.category_id";
        const lobby = await resolveVoiceLobby(snapshot.channels, config);
        targetId = lobby.id;
        lobbyMissing = lobby.categorySet && !lobby.id;
        if (!lobby.categorySet) targetId = "";
      } else if (r.targetKey) {
        targetId = (await config.getStringStrict(r.targetKey, "")).trim();
      }
      if (lobbyMissing) {
        checks.push({
          feature: ref(r),
          kind: "permission",
          enabled: inUse,
          outcome: "unknown",
          target: { kind: "channel", id: null, name: "the lobby" },
          missing: [],
        });
        if (inUse) {
          unknown.push({
            feature: ref(r),
            target: { kind: "channel", id: null, name: "the lobby" },
            note: "The lobby was not found in the managed voice category (by id or by name), so it could not be checked.",
          });
        }
        continue;
      }
      if (r.scope !== "guild" && !targetId) {
        checks.push({
          feature: ref(r),
          kind: "permission",
          enabled: inUse,
          outcome: "unchecked",
          target: null,
          missing: [],
        });
        const note = `${r.area}: ${setting} is not set, so ${r.feature.toLowerCase()} is not checked.`;
        if (inUse && !notes.includes(note)) notes.push(note);
        continue;
      }
      let target: PermissionTarget = SERVER;
      let channel: GuildBasedChannel | null = null;
      if (r.scope !== "guild") {
        channel = snapshot.channels?.get(targetId) ?? null;
        target = {
          kind: r.scope,
          id: targetId,
          name: channel?.name ?? targetId,
        };
      }
      const feature = ref(r);
      let missing: string[] | null = null;
      let why = "";
      if (!me) {
        why = "The bot's own membership could not be read.";
      } else if (r.scope !== "guild" && !channel) {
        why = `The configured ${r.scope} could not be found.`;
      } else if (
        r.scope === "category" &&
        channel?.type !== ChannelType.GuildCategory
      ) {
        // The services only accept a real category here (a text or voice
        // channel id is ignored), so it cannot be reported as in place.
        why = "The configured channel is not a category.";
      } else {
        try {
          const perms =
            r.scope === "guild" || !channel
              ? me.permissions
              : me.permissionsIn(channel);
          missing = missingNeeds(r, (bit) => perms.has(bit));
        } catch (err) {
          logger.warn("Bot permission check: permissions unreadable:", err);
          why = "The bot's permissions could not be read.";
        }
      }
      checks.push({
        feature,
        kind: "permission",
        enabled: inUse,
        outcome:
          missing === null
            ? "unknown"
            : missing.length === 0
              ? "ok"
              : "missing",
        target,
        missing: missing ?? [],
      });
      if (missing === null) {
        if (inUse) unknown.push({ feature, target, note: why });
        continue;
      }
      if (missing.length === 0) {
        if (inUse) okFeatures.push(feature);
        continue;
      }
      if (!inUse) {
        quiet.push({ feature, target, missing });
        continue;
      }
      for (const permission of missing) {
        const key = `${permission}|${target.kind}|${target.id ?? ""}`;
        const entry = problems.get(key) ?? { permission, target, features: [] };
        entry.features.push(feature);
        problems.set(key, entry);
      }
    }

    // Roles the bot must be able to hand out sit below its highest role.
    for (const r of ROLE_HIERARCHY_REQUIREMENTS) {
      const on = await config.getBooleanStrict(r.enabledKey, false);
      if (!on) {
        checks.push({
          feature: ref(r),
          kind: "role-position",
          enabled: false,
          outcome: "unchecked",
          target: null,
          missing: [],
        });
        continue;
      }
      const ids = configuredRoleIds(
        r.roleSource,
        await config.getStringStrict(r.roleSource.key, ""),
      );
      const feature = ref(r);
      for (const id of ids) {
        const role = snapshot.roles?.get(id);
        const target: PermissionTarget = {
          kind: "role",
          id,
          name: role?.name ?? id,
        };
        const botHighest = me?.roles?.highest?.position;
        const unreadable = !role || botHighest === undefined;
        const above = !unreadable && role.position >= botHighest;
        checks.push({
          feature,
          kind: "role-position",
          enabled: true,
          outcome: unreadable ? "unknown" : above ? "missing" : "ok",
          target,
          missing: above ? [ROLE_ABOVE_BOT] : [],
        });
        if (!role || botHighest === undefined || role.position >= botHighest) {
          // Not fine, so not "in place" either, whatever Manage Roles says.
          dropOk(r.forFeature);
        }
        if (!role || botHighest === undefined) {
          unknown.push({
            feature,
            target,
            note: !role
              ? "The configured role could not be found."
              : "The bot's own roles could not be read.",
          });
        } else if (role.position >= botHighest) {
          const key = `${ROLE_ABOVE_BOT}|role|${id}`;
          const entry = problems.get(key) ?? {
            permission: ROLE_ABOVE_BOT,
            target,
            features: [],
          };
          entry.features.push(feature);
          problems.set(key, entry);
        }
      }
    }
  } catch (err) {
    logger.warn("Bot permission check: settings could not be read:", err);
    return empty(
      "The settings could not be read, so the permissions could not be checked.",
      snapshot.fresh,
    );
  }

  const list = [...problems.values()];
  setPermissionIssueCount(guildId, list.length);
  return {
    available: true,
    reason: null,
    fresh: snapshot.fresh,
    problems: list,
    unknown,
    quiet,
    okFeatures,
    notes,
    checks,
    // The managed role's own bits: `me.permissions` also folds in @everyone
    // and any other role the bot was given.
    serverPermissions:
      typeof me?.roles?.botRole?.permissions?.bitfield === "bigint"
        ? me.roles.botRole.permissions.bitfield
        : null,
  };
}
