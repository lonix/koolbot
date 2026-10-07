import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type GuildBasedChannel,
} from "discord.js";
import logger from "../utils/logger.js";
import { ConfigService } from "./config-service.js";
import { AdoptionSnapshot } from "../models/adoption-snapshot.js";
import {
  planAdoption,
  type AdoptionPlan,
  type ChannelKind,
  type ChannelState,
  type DesiredState,
  type PlanIssue,
  type ScannedState,
} from "./server-adoption-planner.js";

/**
 * Glue between the rules / TOS acceptance role (#1024) and the adoption
 * engine (#1018). Nothing here writes to Discord: it builds a plan the Web UI
 * previews, and the engine applies it (snapshotted, batched, resumable).
 *
 * A plan can (a) create the acceptance role when none is configured, (b) grant
 * it to existing members so adopting the gate doesn't lock the community out,
 * and (c) gate chosen channels: deny `ViewChannel` for @everyone and allow it
 * for the acceptance role. Every part is opt-in; the default plan is empty.
 */

/** Name of the role created when the admin has none to reuse. */
export const DEFAULT_RULES_ROLE_NAME = "Rules accepted";

const VIEW = PermissionFlagsBits.ViewChannel;

export interface RulesPlanOptions {
  /** Create a role named {@link DEFAULT_RULES_ROLE_NAME} when none is configured. */
  createRole: boolean;
  /** Grant the role to every current non-bot member. */
  grantExisting: boolean;
  /** Channels to hide from everyone except holders of the role. */
  gateChannelIds: string[];
}

export interface RulesPreview {
  /** Non-bot members in the server (null when the list couldn't be read). */
  totalMembers: number | null;
  /** Members who already hold the acceptance role. */
  holders: number | null;
  /**
   * Members who would lose sight of the gated channels once applied: those
   * without the role who aren't being granted it. Server owner and members
   * with Administrator are excluded; they still see everything.
   */
  lockedOut: number | null;
}

export interface RulesPlan {
  plan: AdoptionPlan;
  extraErrors: PlanIssue[];
  preview: RulesPreview;
  roleId: string | null;
  roleName: string | null;
  /** Channels that can be gated, for the form. */
  channels: Array<{ id: string; name: string; kind: ChannelKind }>;
  options: RulesPlanOptions;
  membersUnavailable: boolean;
}

const kindOf = (c: GuildBasedChannel): ChannelKind => {
  if (c.type === ChannelType.GuildCategory) return "category";
  if (
    c.type === ChannelType.GuildVoice ||
    c.type === ChannelType.GuildStageVoice
  )
    return "voice";
  if (
    c.type === ChannelType.GuildText ||
    c.type === ChannelType.GuildAnnouncement ||
    c.type === ChannelType.GuildForum
  )
    return "text";
  return "other";
};

/** Pure: the overwrite bits that gate (or ungate) ViewChannel for a target. */
export function gateBits(
  existing: { allow: string; deny: string } | undefined,
  kind: "everyone" | "role",
): { allow: string; deny: string } {
  const allow = BigInt(existing?.allow ?? "0");
  const deny = BigInt(existing?.deny ?? "0");
  return kind === "everyone"
    ? { allow: (allow & ~VIEW).toString(), deny: (deny | VIEW).toString() }
    : { allow: (allow | VIEW).toString(), deny: (deny & ~VIEW).toString() };
}

export async function planRulesGate(
  guild: Guild,
  adminUserId: string,
  options: RulesPlanOptions,
): Promise<RulesPlan> {
  const config = ConfigService.getInstance();
  const roleId = (await config.getString("rules.role_id", "")).trim() || null;
  const rulesChannelId =
    (await config.getString("rules.channel_id", "")).trim() || null;

  const [roles, channelMap, me, admin] = await Promise.all([
    guild.roles.fetch(),
    guild.channels.fetch(),
    guild.members.me
      ? Promise.resolve(guild.members.me)
      : guild.members.fetchMe(),
    guild.members.fetch(adminUserId),
  ]);

  let membersUnavailable = false;
  const memberRoles: Record<string, string[]> = {};
  const otherBotIds: string[] = [];
  let adminLike = 0;
  let total: number | null = null;
  try {
    const members = await guild.members.fetch();
    total = 0;
    for (const m of members.values()) {
      if (m.user.bot) {
        if (m.id !== me.id) otherBotIds.push(m.id);
        continue;
      }
      total += 1;
      memberRoles[m.id] = [...m.roles.cache.keys()];
      if (
        m.id === guild.ownerId ||
        m.permissions.has(PermissionFlagsBits.Administrator)
      )
        adminLike += 1;
    }
  } catch (error) {
    membersUnavailable = true;
    logger.warn("rules: could not list members", error);
  }

  const channels: ChannelState[] = [];
  for (const c of channelMap.values()) {
    if (!c) continue;
    channels.push({
      id: c.id,
      name: c.name,
      kind: kindOf(c),
      rawType: c.type,
      parentId: c.parentId,
      position: "rawPosition" in c ? c.rawPosition : 0,
      topic: "topic" in c ? (c.topic ?? null) : null,
      overwrites:
        "permissionOverwrites" in c
          ? [...c.permissionOverwrites.cache.values()].map((o) => ({
              id: o.id,
              type: o.type === 1 ? ("member" as const) : ("role" as const),
              allow: o.allow.bitfield.toString(),
              deny: o.deny.bitfield.toString(),
            }))
          : [],
      voiceMemberCount:
        "members" in c && kindOf(c) === "voice"
          ? (c.members as { size: number }).size
          : 0,
    });
  }

  const scanned: ScannedState = {
    guildId: guild.id,
    ownerId: guild.ownerId,
    botUserId: me.id,
    botRoleIds: [...me.roles.cache.keys()],
    botHighestRolePosition: me.roles.highest.position,
    adminUserId,
    adminRoleIds: [...admin.roles.cache.keys()],
    otherBotIds,
    roles: [...roles.values()].map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      permissions: r.permissions.bitfield.toString(),
      position: r.position,
      managed: r.managed,
    })),
    channels,
    config: {},
    boundChannelIds: [],
    koolbotCreatedIds: [],
    memberRoles,
  };

  const extraErrors: PlanIssue[] = [];
  const existingRole = roleId
    ? scanned.roles.find((r) => r.id === roleId)
    : null;
  if (roleId && !existingRole) {
    extraErrors.push({
      code: "role-missing",
      message: "The configured acceptance role no longer exists.",
      targetId: roleId,
    });
  }
  const creating = !roleId && options.createRole;
  const needsRole = options.grantExisting || options.gateChannelIds.length > 0;
  if (needsRole && !roleId && !creating) {
    extraErrors.push({
      code: "no-role",
      message:
        'Choose an acceptance role in Settings, or tick "create the role", before granting it or gating channels.',
    });
  }
  if (options.grantExisting && membersUnavailable) {
    extraErrors.push({
      code: "members-unavailable",
      message:
        "The member list couldn't be read (the Server Members intent is off), so existing members can't be granted the role.",
    });
  }
  if (rulesChannelId && options.gateChannelIds.includes(rulesChannelId)) {
    extraErrors.push({
      code: "gate-rules-channel",
      message:
        "The rules channel must stay visible to everyone, or no one could accept the rules.",
      targetId: rulesChannelId,
    });
  }

  const roleRef = roleId
    ? { id: roleId }
    : { roleName: DEFAULT_RULES_ROLE_NAME };
  const desired: DesiredState = {};
  if (creating) {
    desired.roles = [{ name: DEFAULT_RULES_ROLE_NAME, permissions: "0" }];
  }
  if (options.grantExisting && !membersUnavailable && (roleId || creating)) {
    desired.memberGrants = [
      { role: roleRef, memberIds: Object.keys(memberRoles) },
    ];
  }
  if (options.gateChannelIds.length > 0 && (roleId || creating)) {
    desired.overwrites = [];
    for (const channelId of options.gateChannelIds) {
      const channel = scanned.channels.find((c) => c.id === channelId);
      if (!channel) {
        extraErrors.push({
          code: "unknown-channel",
          message: `Channel ${channelId} was not found.`,
          targetId: channelId,
        });
        continue;
      }
      const everyone = gateBits(
        channel.overwrites.find((o) => o.id === guild.id),
        "everyone",
      );
      const holder = gateBits(
        roleId ? channel.overwrites.find((o) => o.id === roleId) : undefined,
        "role",
      );
      desired.overwrites.push(
        { channelId, target: { id: guild.id }, ...everyone },
        { channelId, target: roleRef, ...holder },
      );
    }
  }

  const plan = planAdoption(scanned, desired, { approverId: adminUserId });

  const holders =
    roleId && total !== null
      ? Object.values(memberRoles).filter((r) => r.includes(roleId)).length
      : null;
  const lockedOut =
    total === null || options.gateChannelIds.length === 0
      ? null
      : options.grantExisting
        ? 0
        : Math.max(0, total - (holders ?? 0) - adminLike);

  return {
    plan,
    extraErrors,
    preview: { totalMembers: total, holders, lockedOut },
    roleId,
    roleName: existingRole?.name ?? null,
    channels: channels
      .filter(
        (c) => c.kind === "text" || c.kind === "voice" || c.kind === "other",
      )
      .map((c) => ({ id: c.id, name: c.name, kind: c.kind })),
    options,
    membersUnavailable,
  };
}

export function rulesPlanIsApplicable(p: RulesPlan): boolean {
  return (
    p.plan.errors.length === 0 &&
    p.extraErrors.length === 0 &&
    p.plan.operations.length > 0
  );
}

/**
 * If an applied plan created the acceptance role and `rules.role_id` is still
 * empty, store the new role's id. Idempotent and safe to call on every page
 * load; it also covers the admin closing the tab mid-apply.
 */
export async function linkCreatedRulesRole(guildId: string): Promise<boolean> {
  const config = ConfigService.getInstance();
  if ((await config.getString("rules.role_id", "")).trim()) return false;
  try {
    const snapshots = await AdoptionSnapshot.find({
      guildId,
      status: { $in: ["applied", "partial"] },
    })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
    const key = DEFAULT_RULES_ROLE_NAME.toLowerCase();
    for (const snap of snapshots) {
      const created = (
        snap.createdRoles as Array<{ roleId: string; name: string }>
      ).find((r) => r.name.trim().toLowerCase() === key);
      if (created) {
        await config.set(
          "rules.role_id",
          created.roleId,
          "Role granted when a member presses Accept.",
          "rules",
        );
        return true;
      }
    }
  } catch (error) {
    logger.warn("rules: linking the created role failed", error);
  }
  return false;
}
