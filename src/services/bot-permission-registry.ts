/**
 * The Discord permissions each KoolBot feature needs from the bot (#1217), in
 * one place. The services that act (group channels, nickname tags, native
 * event sync, member moves, voice rooms) import their permission bits and
 * recorded warning texts from here, and the Web UI check
 * (`bot-permission-check.ts`) reads the same table, so the "Bot permissions"
 * page and the behaviour cannot drift apart.
 *
 * A permission is listed only where the code really needs it: it checks it, warns
 * about it, or calls a Discord API that Discord refuses without it. The channel-
 * posting features (#1254) are audited feature by feature: what each one sends,
 * reads, deletes or pins in its channel. A posting feature's bit set is not the
 * overwrite set the channel claims grant (`NOTICES_BOT`, `BOT_POSTS`): those say
 * what to leave the bot in a channel it owns, these say what the code calls.
 *
 * `scope` says where the permission is evaluated:
 * - `guild`: server-wide only. A channel overwrite cannot grant it (Manage
 *   Nicknames, Create Events), so the UI says "server-wide".
 * - `category` / `channel`: in the configured category or channel (`targetKey`),
 *   so a channel overwrite that denies a permission the role has counts as
 *   missing.
 *
 * Manage Roles is evaluated where the code uses it: server-wide to hand out a
 * role, and in a channel to change that channel's overwrites (Discord treats
 * editing channel permissions as Manage Roles, as the adoption planner notes).
 *
 * A feature counts as in use only while its `enabledKey` setting (or its
 * `usedWhen` condition, for a feature without a switch) and every
 * `alsoKeys` setting is on and, for a category or channel scope, its
 * `targetKey` is configured.
 */

import { PermissionFlagsBits } from "discord.js";
import { LEADS_REQUIRED_BOT_PERMISSIONS } from "./event-leads-access.js";
import type { ConfigSchema } from "./config-schema.js";
import {
  NOTICES_BOT,
  NOTICES_EVERYONE,
  type PermissionName,
} from "../utils/channel-permissions.js";

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
  /**
   * `needs` are what the code grants with `permissionOverwrites.edit`, not what
   * it holds in the channel: see `missingOverwriteGrant`.
   */
  overwriteGrant?: boolean;
  /** The feature's `*.enabled` setting. Absent when `usedWhen` decides. */
  enabledKey?: keyof ConfigSchema;
  /**
   * Some features have no switch: they are in use when something is configured.
   * `role-groups`: the server has at least one role group.
   */
  usedWhen?: "role-groups";
  /** More boolean settings that must also be on (an optional sub-feature, such as a pinned header). */
  alsoKeys?: readonly (keyof ConfigSchema)[];
  /** The setting holding the category or channel id, for those scopes. */
  targetKey?: keyof ConfigSchema;
  /**
   * The kind of channel the service accepts there, for a channel scope that
   * posts. `text`: a text, announcement, voice or stage channel (the services
   * accept any `isTextBased()` channel, whose text chat `send` works on);
   * `guild-text`: a plain text channel only (the weekly announcer refuses the
   * rest). A category, forum or thread is reported as "could not check", never
   * "ok" (a thread needs Send Messages in Threads and is not in Discord's
   * channel list, so this page does not check threads).
   */
  targetType?: "text" | "guild-text";
  /**
   * A channel that is not a plain setting. `voice-lobby`: the lobby by id, or
   * by name in the managed category, as the voice service finds it.
   */
  targetResolver?: "voice-lobby";
  /** What stops working while a permission is missing. */
  effect: string;
  /** How to put it right. */
  fix: string;
}

export const PERM = {
  viewChannel: { bit: PermissionFlagsBits.ViewChannel, name: "View Channel" },
  sendMessages: {
    bit: PermissionFlagsBits.SendMessages,
    name: "Send Messages",
  },
  embedLinks: { bit: PermissionFlagsBits.EmbedLinks, name: "Embed Links" },
  addReactions: {
    bit: PermissionFlagsBits.AddReactions,
    name: "Add Reactions",
  },
  manageMessages: {
    bit: PermissionFlagsBits.ManageMessages,
    name: "Manage Messages",
  },
  pinMessages: {
    bit: PermissionFlagsBits.PinMessages,
    name: "Pin Messages",
  },
  readHistory: {
    bit: PermissionFlagsBits.ReadMessageHistory,
    name: "Read Message History",
  },
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

/**
 * The order Discord's role editor lists these permissions in (General, then
 * Membership, then Text, then Voice, then Events), as keys of `PERM`. The permission
 * matrix sorts by it; a test keeps it covering every `PERM` entry exactly once.
 */
export const PERMISSION_ORDER: readonly (keyof typeof PERM)[] = [
  "viewChannel",
  "manageChannels",
  "manageRoles",
  "manageNicknames",
  "sendMessages",
  "embedLinks",
  "addReactions",
  "manageMessages",
  "pinMessages",
  "readHistory",
  "connect",
  "speak",
  "moveMembers",
  "setVoiceStatus",
  "createEvents",
  "manageEvents",
];

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

/**
 * The Discord log categories (`DiscordLogger`, `core.<type>.enabled` +
 * `core.<type>.channel_id`), with the name the admin knows each by. A test keeps
 * this equal to `DISCORD_LOG_TYPES`; it is a literal here because the logger
 * imports the config service, which this table must not.
 */
export const LOG_CHANNEL_TYPES: readonly {
  type: string;
  label: string;
  /**
   * The feature that produces these posts, when it has a switch of its own: the
   * category only posts while it is on (read from each producer's code).
   */
  alsoKeys?: readonly (keyof ConfigSchema)[];
}[] = [
  { type: "startup", label: "Startup" },
  { type: "errors", label: "Errors" },
  {
    type: "cleanup",
    label: "Cleanup",
    // Only the voice-session cleanup job reports to it.
    alsoKeys: ["voicetracking.cleanup.enabled"],
  },
  { type: "config", label: "Config changes" },
  { type: "cron", label: "Scheduled jobs" },
  {
    type: "moderation",
    label: "Moderation",
    alsoKeys: ["moderation.enabled"],
  },
  {
    type: "moderation_review",
    label: "Moderation case review",
    alsoKeys: ["moderation.enabled", "moderation.cases.enabled"],
  },
  {
    type: "updates",
    label: "Update available",
    alsoKeys: ["core.updatecheck.enabled"],
  },
  { type: "role_groups", label: "Role groups" },
];

/** `DiscordLogger.logToChannel` sends one embed with mentions suppressed: View Channel, Send Messages, Embed Links. */
const logChannelRequirements: FeatureRequirement[] = LOG_CHANNEL_TYPES.map(
  ({ type, label, alsoKeys }) => ({
    id: `log-${type.replace(/_/g, "-")}`,
    area: "Discord logging",
    feature: `${label} log channel`,
    scope: "channel",
    targetType: "text",
    needs: [PERM.viewChannel, PERM.sendMessages, PERM.embedLinks],
    enabledKey: `core.${type}.enabled` as keyof ConfigSchema,
    ...(alsoKeys ? { alsoKeys } : {}),
    targetKey: `core.${type}.channel_id` as keyof ConfigSchema,
    effect: `${label} log messages are not posted. The send fails with a line in the bot's log only; nothing appears in Discord.`,
    fix: "Give the bot's role View Channel, Send Messages and Embed Links, and make sure the log channel does not deny them.",
  }),
);

/**
 * What the quotes and notices lock-down sets. The managers apply
 * `NOTICES_EVERYONE` to @everyone and `NOTICES_BOT` to the bot with
 * `permissionOverwrites.edit`: Manage Roles first, then the permissions in both
 * the allow and the deny lists (Discord's rule for overwrites covers both),
 * evaluated by `missingOverwriteGrant`. Derived from the same constants the
 * managers use, so the two cannot drift. (The managers call nothing with
 * Manage Channels apart from this grant; see the audit in #1254.)
 */
const LOCK_DOWN_NEEDS: readonly PermissionNeed[] = ((): PermissionNeed[] => {
  const byBit = new Map<bigint, PermissionNeed>(
    Object.values(PERM).map((p) => [p.bit, p]),
  );
  const names: PermissionName[] = [
    ...new Set([
      ...NOTICES_BOT.allow,
      ...NOTICES_BOT.deny,
      ...NOTICES_EVERYONE.allow,
      ...NOTICES_EVERYONE.deny,
    ]),
  ];
  const granted = names.map((n) => {
    const bit = PermissionFlagsBits[n];
    return (
      byBit.get(bit) ?? {
        bit,
        name: n.replace(/([a-z])([A-Z])/g, "$1 $2").replace(" In ", " in "),
      }
    );
  });
  return [PERM.manageRoles, ...granted.filter((n) => n !== PERM.manageRoles)];
})();

/**
 * A read-only channel the bot keeps by itself (quotes, notices): what its
 * manager actually calls there. Reading history is how it finds its header and
 * the messages it edits or deletes; Manage Messages only for deleting what
 * others posted (the cleanup job runs every few minutes) and for clearing the
 * channel on a quote sync; `LOCK_DOWN_NEEDS` for the lock-down it applies to the
 * channel at startup (`permissionOverwrites.edit`).
 */
function managedChannelRequirements(o: {
  id: string;
  area: string;
  feature: string;
  enabledKey: keyof ConfigSchema;
  headerKey: keyof ConfigSchema;
  headerPinKey: keyof ConfigSchema;
  targetKey: keyof ConfigSchema;
  votes: boolean;
}): FeatureRequirement[] {
  const base = {
    area: o.area,
    scope: "channel",
    targetType: "text",
    enabledKey: o.enabledKey,
    targetKey: o.targetKey,
  } as const;
  const name = o.feature.toLowerCase();
  const list: FeatureRequirement[] = [
    {
      ...base,
      id: `${o.id}-post`,
      feature: `Posting to the ${name} channel`,
      needs: [
        PERM.viewChannel,
        PERM.sendMessages,
        PERM.embedLinks,
        PERM.readHistory,
      ],
      effect: `New ${name} entries and the channel header are not posted, and existing ones cannot be found to edit or delete. Failures are logged in the bot's log only.`,
      fix: `Give the bot's role View Channel, Send Messages, Embed Links and Read Message History, and make sure the ${name} channel does not deny them.`,
    },
  ];
  if (o.votes) {
    list.push({
      ...base,
      id: `${o.id}-votes`,
      feature: `Vote reactions on ${name}`,
      needs: [PERM.addReactions],
      effect: `The thumbs up and down are not added to new ${name}, so members cannot vote (logged in the bot's log only).`,
      fix: `Give the bot's role Add Reactions, and make sure the ${name} channel does not deny it.`,
    });
  }
  list.push(
    {
      ...base,
      id: `${o.id}-cleanup`,
      feature: `Keeping the ${name} channel clean`,
      needs: [PERM.manageMessages],
      effect: `Messages that members post in the channel are not removed (each failed delete is logged in the bot's log only).`,
      fix: `Give the bot's role Manage Messages, and make sure the ${name} channel does not deny it.`,
    },
    {
      ...base,
      id: `${o.id}-lock`,
      feature: `Making the ${name} channel read-only`,
      needs: LOCK_DOWN_NEEDS,
      overwriteGrant: true,
      effect: `The bot cannot set the channel's permissions at startup, so it does not lock the channel itself (logged in the bot's log only). Discord lets it allow or deny only permissions it holds server-wide or in the category, unless it has a Manage Roles override on the channel. It still works if you locked the channel by hand.`,
      fix: `Give the bot's role Manage Roles in the ${name} channel, and either give the bot's role the other listed permissions server-wide (or on the category), or give the bot a Manage Roles permission override on the channel. Or lock the channel yourself.`,
    },
    {
      ...base,
      id: `${o.id}-pin`,
      feature: `Pinning the ${name} header`,
      needs: [PERM.pinMessages],
      alsoKeys: [o.headerKey, o.headerPinKey],
      effect: `The header post is not pinned (logged in the bot's log only).`,
      fix: `Give the bot's role Pin Messages, and make sure the ${name} channel does not deny it.`,
    },
  );
  return list;
}

const quotesRequirements = managedChannelRequirements({
  id: "quotes",
  area: "Quotes",
  feature: "Quotes",
  enabledKey: "quotes.enabled",
  headerKey: "quotes.header_enabled",
  headerPinKey: "quotes.header_pin_enabled",
  targetKey: "quotes.channel_id",
  votes: true,
});

const noticesRequirements = managedChannelRequirements({
  id: "notices",
  area: "Notices",
  feature: "Notices",
  enabledKey: "notices.enabled",
  headerKey: "notices.header_enabled",
  headerPinKey: "notices.header_pin_enabled",
  targetKey: "notices.channel_id",
  votes: false,
});

/** Posting features that are not a managed channel (#1254): each sends plain messages to one configured channel. */
const postingRequirements: FeatureRequirement[] = [
  {
    id: "voice-weekly-announcements",
    area: "Voice stats",
    feature: "Weekly voice-activity announcement",
    scope: "channel",
    targetType: "guild-text",
    needs: [PERM.viewChannel, PERM.sendMessages],
    enabledKey: "voicetracking.announcements.enabled",
    alsoKeys: ["voicetracking.enabled"],
    targetKey: "voicetracking.announcements.channel_id",
    effect:
      "The weekly stats, accolades, quote and poll posts are not sent. Each part logs an error in the bot's log only.",
    fix: "Give the bot's role View Channel and Send Messages, and make sure the announcement channel does not deny them.",
  },
  {
    id: "raid-alerts",
    area: "Moderation",
    feature: "Anti-raid alerts",
    scope: "channel",
    targetType: "text",
    needs: [PERM.viewChannel, PERM.sendMessages],
    enabledKey: "moderation.raid.enabled",
    // Anti-raid stops when the moderation log is off (`getInactiveReason`).
    alsoKeys: ["moderation.enabled"],
    targetKey: "moderation.raid.alert_channel_id",
    effect:
      "Raid alerts are not posted. A failed send is logged in the bot's log; a channel that is not a text channel is skipped with no message at all.",
    fix: "Give the bot's role View Channel and Send Messages, and make sure the alert channel does not deny them.",
  },
];

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
    targetResolver: "voice-lobby",
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
    alsoKeys: ["voicechannels.owner.grant_status"],
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
    usedWhen: "role-groups",
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
  // ---- Channel-posting features (#1254) ----
  ...logChannelRequirements,
  ...quotesRequirements,
  ...noticesRequirements,
  ...postingRequirements,
];

/**
 * A configured role the bot must be able to hand out: it has to sit below the
 * bot's highest role (the rules and leaderboard code refuse such a role).
 */
export interface RoleHierarchyRequirement {
  id: string;
  /** The `FEATURE_REQUIREMENTS` entry this extends: it is not "in place" while this fails. */
  forFeature: string;
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
      forFeature: "rules-role",
      area: "Rules",
      feature: "Granting the acceptance role",
      enabledKey: "rules.enabled",
      roleSource: { kind: "id", key: "rules.role_id" },
      effect: "The bot cannot grant this role, so Accept does nothing for it.",
      fix: ROLE_HIERARCHY_FIX,
    },
    {
      id: "leaderboard-roles-hierarchy",
      forFeature: "leaderboard-roles",
      area: "Leaderboard roles",
      feature: "Handing out leaderboard roles",
      enabledKey: "leaderboard_roles.enabled",
      roleSource: { kind: "tiers", key: "leaderboard_roles.tiers" },
      effect: "The bot cannot give or remove this role.",
      fix: ROLE_HIERARCHY_FIX,
    },
  ];

/**
 * What the bot holds, for an overwrite grant (`overwriteGrant`): Discord lets a
 * bot with Manage Roles in the channel allow or deny only bits it holds in the
 * guild or in the channel's parent category, unless the bot has a Manage Roles
 * overwrite in that channel itself (the exemption). Both the allowed and the
 * denied bits count. Manage Roles (the first need) must be held in the channel.
 * Not verified against a live Discord server; see the PR for #1254.
 */
export interface OverwriteGrantHolder {
  /** The bot's effective permissions in the target channel. */
  inChannel: (bit: bigint) => boolean;
  /** Held server-wide (the bot's guild permissions). */
  inGuild: (bit: bigint) => boolean;
  /** Held in the channel's parent category; false when there is none. */
  inParent: (bit: bigint) => boolean;
  /** The bot (or one of its roles) has a Manage Roles overwrite in the channel. */
  exempt: boolean;
}

export function missingOverwriteGrant(
  needs: readonly PermissionNeed[],
  has: OverwriteGrantHolder,
): string[] {
  const [manageRoles, ...grants] = needs;
  if (!has.inChannel(manageRoles.bit)) {
    // Without Manage Roles nothing can be edited, so name only that.
    return [manageRoles.name];
  }
  if (has.exempt) return [];
  return grants
    .filter((n) => !has.inGuild(n.bit) && !has.inParent(n.bit))
    .map((n) => n.name);
}

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
