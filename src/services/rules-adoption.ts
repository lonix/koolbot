import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type GuildBasedChannel,
} from "discord.js";
import logger from "../utils/logger.js";
import { ConfigService } from "./config-service.js";
import {
  roleProblem,
  ROLE_PROBLEM_TEXT,
  RULES_ACCEPT_CUSTOM_ID,
} from "./rules-service.js";
import {
  mapFeatureBindings,
  readEffectiveConfig,
} from "./server-scan-service.js";
import {
  effectivePermissions,
  planAdoption,
  type AdoptionPlan,
  type ChannelKind,
  type ChannelState,
  type DesiredState,
  type OverwriteState,
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
   * Unique members who can see at least one gated channel now and could not
   * after the rollout (effective View Channel, allowed -> denied), counting
   * role permissions, other roles' allows and member overwrites. Owner and
   * Administrators never lose sight. Based on the overwrites as scanned.
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

/** Channel types the rules form offers as gate targets. */
const GATEABLE_TYPES: ReadonlySet<ChannelType> = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
]);

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

/** Pure: effective View Channel for a member in one channel. */
function canView(
  userId: string,
  roleIds: string[],
  ownerId: string,
  everyoneId: string,
  rolePermissions: Map<string, bigint>,
  overwrites: OverwriteState[],
): boolean {
  return (
    (effectivePermissions({
      userId,
      roleIds,
      ownerId,
      everyoneId,
      rolePermissions,
      overwrites,
    }) &
      VIEW) ===
    VIEW
  );
}

/**
 * Pure: unique members who see a gated channel today and would not after the
 * gate (and the optional grant) are applied.
 */
export function countLockedOut(input: {
  memberRoles: Record<string, string[]>;
  roles: Array<{ id: string; permissions: string }>;
  channels: Array<{ id: string; overwrites: OverwriteState[] }>;
  gateChannelIds: string[];
  everyoneId: string;
  ownerId: string;
  /** The acceptance role (a placeholder id when it is about to be created). */
  roleId: string;
  grantExisting: boolean;
}): number {
  const rolePermissions = new Map<string, bigint>(
    input.roles.map((r) => [r.id, BigInt(r.permissions)]),
  );
  if (!rolePermissions.has(input.roleId)) rolePermissions.set(input.roleId, 0n);
  const gated = input.channels.filter((c) =>
    input.gateChannelIds.includes(c.id),
  );
  let locked = 0;
  for (const [userId, roleIds] of Object.entries(input.memberRoles)) {
    const afterRoles =
      input.grantExisting && !roleIds.includes(input.roleId)
        ? [...roleIds, input.roleId]
        : roleIds;
    const lost = gated.some((c) => {
      const args = [input.ownerId, input.everyoneId, rolePermissions] as const;
      if (!canView(userId, roleIds, ...args, c.overwrites)) return false;
      const everyone = gateBits(
        c.overwrites.find((o) => o.id === input.everyoneId),
        "everyone",
      );
      const holder = gateBits(
        c.overwrites.find((o) => o.id === input.roleId),
        "role",
      );
      const next = c.overwrites.filter(
        (o) => o.id !== input.everyoneId && o.id !== input.roleId,
      );
      next.push(
        { id: input.everyoneId, type: "role", ...everyone },
        { id: input.roleId, type: "role", ...holder },
      );
      return !canView(userId, afterRoles, ...args, next);
    });
    if (lost) locked += 1;
  }
  return locked;
}

/** Discord error codes for a deleted channel / message. */
const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_MESSAGE = 10008;

/**
 * Whether the configured acceptance flow works right now: rules acceptance is
 * on and the configured channel and message exist, the message is the bot's
 * own and carries the Accept button. Returns a blocking issue, or null. A
 * transient read failure blocks too (with a retry message) rather than
 * letting an unverified gate through.
 */
async function verifyAcceptanceMessage(input: {
  enabled: boolean;
  channel: GuildBasedChannel | null | undefined;
  messageId: string | null;
  botUserId: string;
}): Promise<PlanIssue | null> {
  const inactive = (detail: string): PlanIssue => ({
    code: "acceptance-inactive",
    message: `Gating needs a working acceptance flow first: ${detail} Nothing is hidden until then.`,
  });
  if (!input.enabled || !input.messageId) {
    return inactive(
      "turn on Rules acceptance, choose an existing rules channel and post the rules message.",
    );
  }
  const channel = input.channel;
  if (!channel || !channel.isTextBased() || !("messages" in channel)) {
    return inactive(
      "the rules channel doesn't exist or can't hold messages. Choose a text channel and post the rules message.",
    );
  }
  try {
    const message = await channel.messages.fetch(input.messageId);
    if (message.author.id !== input.botUserId) {
      return inactive(
        "the configured rules message wasn't posted by the bot. Post the rules message again from the Rules page.",
      );
    }
    const hasButton = message.components.some((row) =>
      (
        (
          row as unknown as {
            components?: Array<{ customId?: string | null }>;
          }
        ).components ?? []
      ).some((c) => c.customId === RULES_ACCEPT_CUSTOM_ID),
    );
    if (!hasButton) {
      return inactive(
        "the rules message has no Accept button. Post the rules message again from the Rules page.",
      );
    }
    return null;
  } catch (error) {
    const code = (error as { code?: number } | null)?.code;
    if (code === UNKNOWN_MESSAGE || code === UNKNOWN_CHANNEL) {
      return inactive(
        "the configured rules message no longer exists. Post the rules message again from the Rules page.",
      );
    }
    logger.warn("rules: could not verify the rules message", error);
    return {
      code: "acceptance-unverified",
      message:
        "Couldn't check the rules message with Discord just now. Nothing is hidden. Try again in a moment.",
    };
  }
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
  const rulesEnabled = await config.getBoolean("rules.enabled", false);
  const rulesMessageId =
    (await config.getString("rules.message_id", "")).trim() || null;

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

  // The same binding inventory the server scan uses, so the planner blocks a
  // gate that would hide a channel KoolBot features (notices, quotes,
  // moderation, ...) from the bot itself. A failed read throws: gating
  // without the inventory would silently disable the protection.
  const boundChannelIds = [
    ...mapFeatureBindings(await readEffectiveConfig()).channels.keys(),
  ];

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
    // The effective value ("" when unset), so the baseline matches what the
    // engine reads at apply time and a rollback restores it exactly; whether
    // an override row exists is recorded by the engine in the snapshot.
    config: { "rules.role_id": roleId ?? "" },
    boundChannelIds,
    koolbotCreatedIds: [],
    memberRoles,
  };

  const extraErrors: PlanIssue[] = [];
  const existingRole = roleId
    ? scanned.roles.find((r) => r.id === roleId)
    : null;
  if (roleId) {
    // The same rules the Accept handler applies, so a plan that can never
    // work (managed role, at/above the bot) is refused up front.
    const problem = roleProblem(
      existingRole,
      guild.id,
      scanned.botHighestRolePosition,
      me.permissions.has(PermissionFlagsBits.ManageRoles),
    );
    if (problem) {
      extraErrors.push({
        code: problem,
        message: ROLE_PROBLEM_TEXT[problem],
        targetId: roleId,
      });
    }
  }
  const nameTaken =
    !roleId &&
    options.createRole &&
    scanned.roles.some(
      (r) =>
        r.id !== guild.id &&
        r.name.trim().toLowerCase() === DEFAULT_RULES_ROLE_NAME.toLowerCase(),
    );
  if (nameTaken) {
    extraErrors.push({
      code: "role-name-taken",
      message: `A role named "${DEFAULT_RULES_ROLE_NAME}" already exists. Select it as the acceptance role in Settings instead of creating a new one.`,
    });
  }
  const creating = !roleId && options.createRole && !nameTaken;
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
  if (options.gateChannelIds.length > 0) {
    // A gate with no way through hides channels from newcomers for good, so
    // the acceptance flow must be live before anything is hidden.
    const acceptance = await verifyAcceptanceMessage({
      enabled: rulesEnabled,
      channel: rulesChannelId ? channelMap.get(rulesChannelId) : undefined,
      messageId: rulesMessageId,
      botUserId: me.id,
    });
    if (acceptance) extraErrors.push(acceptance);
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
  if (creating) {
    // Part of the plan (and so of the snapshot): a failed link is a failed
    // step that keeps the gate unapplied, and a rollback restores the previous
    // `rules.role_id` before the created role is deleted.
    desired.config = { "rules.role_id": RULES_ROLE_REF };
  }
  const allows: NonNullable<DesiredState["overwrites"]> = [];
  const denies: NonNullable<DesiredState["overwrites"]> = [];
  if (options.gateChannelIds.length > 0 && (roleId || creating)) {
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
      // Categories (and any type the form doesn't offer) are never targets:
      // Discord propagates a category's overwrites to synced children, which
      // could hide the rules channel itself. Children are chosen one by one.
      if (
        channel.rawType === undefined ||
        !GATEABLE_TYPES.has(channel.rawType)
      ) {
        extraErrors.push({
          code: "gate-unsupported-channel",
          message:
            channel.kind === "category"
              ? `"${channel.name}" is a category. Select its channels individually instead; gating a category would also change channels synced to it, such as the rules channel.`
              : `"${channel.name}" is not a text, voice, announcement or forum channel and can't be gated.`,
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
      allows.push({ channelId, target: roleRef, ...holder });
      denies.push({ channelId, target: { id: guild.id }, ...everyone });
    }
    // Every role allow precedes every @everyone deny.
    desired.overwrites = [...allows, ...denies];
  }

  const plan = planAdoption(scanned, desired, {
    approverId: adminUserId,
    grantsBeforeOverwrites: true,
  });

  const holders =
    roleId && total !== null
      ? Object.values(memberRoles).filter((r) => r.includes(roleId)).length
      : null;
  const lockedOut =
    total === null || options.gateChannelIds.length === 0
      ? null
      : countLockedOut({
          memberRoles,
          roles: scanned.roles,
          channels,
          gateChannelIds: options.gateChannelIds,
          everyoneId: guild.id,
          ownerId: guild.ownerId,
          roleId: roleId ?? "new:rules",
          grantExisting: options.grantExisting && !membersUnavailable,
        });

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

/** The ref the planner gives the role it creates (`new:<lowercase name>`). */
export const RULES_ROLE_REF = `new:${DEFAULT_RULES_ROLE_NAME.toLowerCase()}`;
