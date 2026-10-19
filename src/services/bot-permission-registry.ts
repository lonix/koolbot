/**
 * The Discord permissions each KoolBot feature needs from the bot (#1217), in
 * one place. The services that act (group channels, nickname tags, native
 * event sync, member moves, voice rooms) import their permission bits and
 * recorded warning texts from here, and the Web UI check
 * (`bot-permission-check.ts`) reads the same table, so the "Bot permissions"
 * page and the behaviour cannot drift apart.
 *
 * Only requirements that code already checks or warns about are listed. The
 * channel-posting features (View Channel, Send Messages, Embed Links) are a
 * separate step (#1254).
 *
 * `scope` says where the permission is evaluated:
 * - `guild`: server-wide only. A channel overwrite cannot grant it (Manage
 *   Roles, Manage Nicknames, Create Events), so the UI says "server-wide".
 * - `category` / `channel`: in the configured category or channel (`targetKey`),
 *   so a channel overwrite that denies a permission the role has counts as
 *   missing.
 *
 * A feature counts as in use only while its `enabledKey` setting (and
 * `alsoKey`, when set) is on and, for a category or channel scope, its
 * `targetKey` is configured.
 */

import { PermissionFlagsBits } from "discord.js";
import { LEADS_REQUIRED_BOT_PERMISSIONS } from "./event-leads-access.js";
import type { ConfigSchema } from "./config-schema.js";

export interface PermissionNeed {
  bit: bigint;
  name: string;
}

export type RequirementScope = "guild" | "category" | "channel";

export interface FeatureRequirement {
  id: string;
  /** The area the admin knows it by (a settings page or feature name). */
  area: string;
  /** What exactly is affected. */
  feature: string;
  scope: RequirementScope;
  /** True: holding any one of `needs` is enough (Create Events or Manage Events). */
  anyOf?: boolean;
  needs: readonly PermissionNeed[];
  /** The feature's `*.enabled` setting. */
  enabledKey: keyof ConfigSchema;
  /** A second boolean setting that must also be on (an optional sub-feature). */
  alsoKey?: keyof ConfigSchema;
  /** The setting holding the category or channel id, for those scopes. */
  targetKey?: keyof ConfigSchema;
  /** What stops working while a permission is missing. */
  effect: string;
  /** How to put it right. */
  fix: string;
}

export const PERM = {
  viewChannel: { bit: PermissionFlagsBits.ViewChannel, name: "View Channel" },
  connect: { bit: PermissionFlagsBits.Connect, name: "Connect" },
  speak: { bit: PermissionFlagsBits.Speak, name: "Speak" },
  moveMembers: { bit: PermissionFlagsBits.MoveMembers, name: "Move Members" },
  manageRoles: { bit: PermissionFlagsBits.ManageRoles, name: "Manage Roles" },
  manageChannels: {
    bit: PermissionFlagsBits.ManageChannels,
    name: "Manage Channels",
  },
  manageNicknames: {
    bit: PermissionFlagsBits.ManageNicknames,
    name: "Manage Nicknames",
  },
  createEvents: {
    bit: PermissionFlagsBits.CreateEvents,
    name: "Create Events",
  },
  manageEvents: {
    bit: PermissionFlagsBits.ManageEvents,
    name: "Manage Events",
  },
  setVoiceStatus: {
    bit: PermissionFlagsBits.SetVoiceChannelStatus,
    name: "Set Voice Channel Status",
  },
} as const satisfies Record<string, PermissionNeed>;

/** The leaders-only channel needs View, Connect, Speak, Move Members and Manage Roles in the category. */
export const LEADS_NEEDS: readonly PermissionNeed[] = [
  PERM.viewChannel,
  PERM.connect,
  PERM.speak,
  PERM.moveMembers,
  PERM.manageRoles,
].filter((p) => (LEADS_REQUIRED_BOT_PERMISSIONS & p.bit) !== 0n);

/** Recorded warning texts (event host panel, #1190 and #1194); the services record them, this is their one source. */
export const MANAGE_CHANNELS_CREATE_WARNING =
  "The bot lacks Manage Channels in the events category, so no group channels were created and the event runs with its main channel only. Grant it to the bot's role.";
export const MANAGE_CHANNELS_ORDER_WARNING =
  "The bot lacks Manage Channels in the events category, so the group channels were not put in order. Grant it to the bot's role.";
export const HOST_ACCESS_WARNING =
  "The bot lacks Manage Roles or Move Members in the events category, so the host got no extra channel access. Grant both to the bot's role.";
export const LEADS_MANAGE_ROLES_WARNING =
  "The bot lacks Manage Roles on the leaders-only channel, so it cannot change who may join it. Grant it to the bot's role.";
export const RESTORE_PERMISSION_WARNING =
  "The bot does not have the Manage Nicknames permission, so nicknames could not be restored yet. Give the bot that permission; KoolBot keeps trying every minute.";
export const MANAGE_NICKNAMES_WARNING =
  "The bot does not have the Manage Nicknames permission, so clan tags are not applied. Give the bot that permission and they will be applied within a minute.";
export const NATIVE_EVENTS_WARNING =
  "Events are not being created in Discord's Events list because the bot lacks the Create Events / Manage Events permission, so announcements have no event card and members cannot mark Interested. Grant it to the bot's role.";

const ROLE_HIERARCHY_FIX =
  "Move the bot's role above the roles it hands out in Server Settings, Roles.";

export const FEATURE_REQUIREMENTS: readonly FeatureRequirement[] = [
  // ---- Voice channels ----
  {
    id: "voice-rooms",
    area: "Voice channels",
    feature: "Temporary voice rooms",
    scope: "category",
    needs: [PERM.manageChannels, PERM.moveMembers, PERM.connect],
    enabledKey: "voicechannels.enabled",
    targetKey: "voicechannels.category_id",
    effect:
      "Rooms are not created or cleaned up, and members who join the lobby are not moved into their room.",
    fix: "Give the bot's role Manage Channels, Move Members and Connect, and make sure the voice category does not deny them.",
  },
  {
    id: "voice-lobby",
    area: "Voice channels",
    feature: "Moving members out of the lobby",
    scope: "channel",
    needs: [PERM.moveMembers],
    enabledKey: "voicechannels.enabled",
    targetKey: "voicechannels.lobby.channel_id",
    effect: "Members who join the lobby stay in it.",
    fix: "Give the bot's role Move Members, and make sure the lobby channel does not deny it.",
  },
  {
    id: "voice-owner-status",
    area: "Voice channels",
    feature: "Room owners setting the room status",
    scope: "category",
    needs: [PERM.setVoiceStatus],
    enabledKey: "voicechannels.enabled",
    alsoKey: "voicechannels.owner.grant_status",
    targetKey: "voicechannels.category_id",
    effect:
      "Room owners are not given the permission to set their room's status.",
    fix: "Give the bot's role Set Voice Channel Status, and make sure the voice category does not deny it.",
  },
  // ---- Events ----
  {
    id: "event-native",
    area: "Events",
    feature: "Discord Events list card",
    scope: "guild",
    anyOf: true,
    needs: [PERM.createEvents, PERM.manageEvents],
    enabledKey: "events.enabled",
    effect:
      "Events get no card in Discord's Events list, so announcements have no event card and members cannot mark Interested.",
    fix: "Give the bot's role Create Events or Manage Events in Server Settings, Roles.",
  },
  {
    id: "event-channels",
    area: "Events",
    feature: "Event and group channels",
    scope: "category",
    needs: [PERM.manageChannels],
    enabledKey: "events.enabled",
    targetKey: "events.category_id",
    effect:
      "Event voice channels and group channels are not created, deleted or put in order, including when a running event's groups are edited.",
    fix: "Give the bot's role Manage Channels, and make sure the events category does not deny it.",
  },
  {
    id: "event-host-access",
    area: "Events",
    feature: "Host access to event channels",
    scope: "category",
    needs: [PERM.manageRoles, PERM.moveMembers],
    enabledKey: "events.enabled",
    targetKey: "events.category_id",
    effect:
      "The host gets no extra access to the event's channels (to see them and move people).",
    fix: "Give the bot's role Manage Roles and Move Members, and make sure the events category does not deny them.",
  },
  {
    id: "event-leads-channel",
    area: "Events",
    feature: "Leaders-only group channel",
    scope: "category",
    needs: LEADS_NEEDS,
    enabledKey: "events.enabled",
    targetKey: "events.category_id",
    effect:
      "A leaders-only channel is created without its restriction, so anyone who can see it can join.",
    fix: "Give the bot's role these permissions, and make sure the events category does not deny them.",
  },
  {
    id: "event-moves",
    area: "Events",
    feature: "Moving members between event channels",
    scope: "category",
    needs: [PERM.moveMembers, PERM.connect],
    enabledKey: "events.enabled",
    targetKey: "events.category_id",
    effect:
      "Members are not moved into their group channels or back to the main channel.",
    fix: "Give the bot's role Move Members and Connect, and make sure the events category does not deny them.",
  },
  {
    id: "event-tags",
    area: "Events",
    feature: "Clan tags on nicknames",
    scope: "guild",
    needs: [PERM.manageNicknames],
    enabledKey: "events.enabled",
    effect:
      "Clan tags are not applied to nicknames and old tags are not restored.",
    fix: "Give the bot's role Manage Nicknames, and keep the bot's role above the members it should tag.",
  },
  // ---- Roles ----
  {
    id: "reaction-roles",
    area: "Reaction roles",
    feature: "Handing out roles",
    scope: "guild",
    needs: [PERM.manageRoles],
    enabledKey: "reactionroles.enabled",
    effect: "Roles are not given or removed when members react.",
    fix: `Give the bot's role Manage Roles. ${ROLE_HIERARCHY_FIX}`,
  },
  {
    id: "leaderboard-roles",
    area: "Leaderboard roles",
    feature: "Handing out leaderboard roles",
    scope: "guild",
    needs: [PERM.manageRoles],
    enabledKey: "leaderboard_roles.enabled",
    effect: "Leaderboard roles are not given or removed.",
    fix: `Give the bot's role Manage Roles. ${ROLE_HIERARCHY_FIX}`,
  },
  {
    id: "role-groups",
    area: "Role groups",
    feature: "Managing role groups",
    scope: "guild",
    needs: [PERM.manageRoles],
    enabledKey: "core.role_groups.enabled",
    effect: "Roles in a group are not created, updated or assigned.",
    fix: `Give the bot's role Manage Roles. ${ROLE_HIERARCHY_FIX}`,
  },
  {
    id: "rules-role",
    area: "Rules",
    feature: "Granting the acceptance role",
    scope: "guild",
    needs: [PERM.manageRoles],
    enabledKey: "rules.enabled",
    effect: "Members who accept the rules do not get the acceptance role.",
    fix: `Give the bot's role Manage Roles. ${ROLE_HIERARCHY_FIX}`,
  },
];

/**
 * A configured role the bot must be able to hand out: it has to sit below the
 * bot's highest role (the rules and leaderboard code refuse such a role).
 */
export interface RoleHierarchyRequirement {
  id: string;
  area: string;
  feature: string;
  enabledKey: keyof ConfigSchema;
  /** Where the role ids come from. `tiers` is "topN:roleId" pairs, comma-separated. */
  roleSource:
    | { kind: "id"; key: keyof ConfigSchema }
    | {
        kind: "tiers";
        key: keyof ConfigSchema;
      };
  effect: string;
  fix: string;
}

export const ROLE_HIERARCHY_REQUIREMENTS: readonly RoleHierarchyRequirement[] =
  [
    {
      id: "rules-role-hierarchy",
      area: "Rules",
      feature: "Granting the acceptance role",
      enabledKey: "rules.enabled",
      roleSource: { kind: "id", key: "rules.role_id" },
      effect: "The bot cannot grant this role, so Accept does nothing for it.",
      fix: ROLE_HIERARCHY_FIX,
    },
    {
      id: "leaderboard-roles-hierarchy",
      area: "Leaderboard roles",
      feature: "Handing out leaderboard roles",
      enabledKey: "leaderboard_roles.enabled",
      roleSource: { kind: "tiers", key: "leaderboard_roles.tiers" },
      effect: "The bot cannot give or remove this role.",
      fix: ROLE_HIERARCHY_FIX,
    },
  ];

/**
 * The names of the needs the holder lacks. With `anyOf`, either all of the
 * alternatives are missing (reported as one "A or B" entry) or nothing is.
 */
export function missingNeeds(
  req: Pick<FeatureRequirement, "needs" | "anyOf">,
  has: (bit: bigint) => boolean,
): string[] {
  if (req.anyOf) {
    return req.needs.some((n) => has(n.bit))
      ? []
      : [req.needs.map((n) => n.name).join(" or ")];
  }
  return req.needs.filter((n) => !has(n.bit)).map((n) => n.name);
}
