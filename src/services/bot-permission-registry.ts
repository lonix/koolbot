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
 * overwrite set the channel claims grant (`BOT_POSTS`): those say
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
   * The channel setting may be left empty on purpose: the feature then posts
   * nowhere (or, for looking for group, in the channel the command ran in), so
   * the entry is reported as not in use, with no "channel is not set" note and no
   * "not checked" verdict. Without this an owner who never set the optional
   * event announcement channel could never see the page say everything is in place.
   */
  targetOptional?: boolean;
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
  attachFiles: {
    bit: PermissionFlagsBits.AttachFiles,
    name: "Attach Files",
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
  "attachFiles",
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

/**
 * The recorded warnings (above) the event host panel already shows for a
 * registry entry, and the permissions each one covers. The per-feature notice
 * (#1253) leaves a missing permission out when its recorded warning is on the
 * same page and names all of what is missing, so the host reads it once.
 */
export const RECORDED_WARNINGS: Readonly<
  Record<string, { texts: readonly string[]; covers: readonly string[] }>
> = {
  "event-channels": {
    texts: [MANAGE_CHANNELS_CREATE_WARNING, MANAGE_CHANNELS_ORDER_WARNING],
    covers: [PERM.manageChannels.name],
  },
  "event-host-access": {
    texts: [HOST_ACCESS_WARNING],
    covers: [PERM.manageRoles.name, PERM.moveMembers.name],
  },
  "event-leads-channel": {
    texts: [LEADS_MANAGE_ROLES_WARNING],
    covers: [PERM.manageRoles.name],
  },
  "event-tags": {
    texts: [MANAGE_NICKNAMES_WARNING, RESTORE_PERMISSION_WARNING],
    covers: [PERM.manageNicknames.name],
  },
};

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
 * A read-only channel the bot keeps by itself (quotes, notices): what its
 * manager actually calls there. Reading history is how it finds its header and
 * the messages it edits or deletes; Manage Messages only for deleting what
 * others posted (the cleanup job runs every few minutes) and for clearing the
 * channel on a quote sync. (The lock-down the managers apply at startup is not
 * checked here.)
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

/**
 * The weekly voice announcement posts four independent sections, each behind its
 * own switches (`voice-channel-announcer.ts`); a section whose switches are off
 * returns without sending, so each is its own requirement. All four send plain
 * text, so View Channel and Send Messages.
 */
const weeklyAnnouncementRequirements: FeatureRequirement[] = (
  [
    {
      id: "stats",
      what: "voice stats",
      include: "voicetracking.announcements.include_voice_stats",
      also: [],
    },
    {
      id: "accolades",
      what: "accolades",
      include: "voicetracking.announcements.include_accolades",
      also: ["achievements.enabled", "achievements.announcements.enabled"],
    },
    {
      id: "quote",
      what: "quote of the week",
      include: "voicetracking.announcements.include_quote_of_week",
      also: ["quotes.enabled"],
    },
    {
      id: "polls",
      what: "poll turnout",
      include: "voicetracking.announcements.include_poll_turnout",
      also: ["polls.participation.enabled"],
    },
  ] as const
).map((section) => ({
  id: `voice-weekly-${section.id}`,
  area: "Voice stats",
  feature: `Weekly announcement: ${section.what}`,
  scope: "channel",
  targetType: "guild-text",
  needs: [PERM.viewChannel, PERM.sendMessages],
  enabledKey: "voicetracking.announcements.enabled",
  alsoKeys: ["voicetracking.enabled", section.include, ...section.also],
  targetKey: "voicetracking.announcements.channel_id",
  effect: `The weekly ${section.what} post is not sent. It logs an error in the bot's log only.`,
  fix: "Give the bot's role View Channel and Send Messages, and make sure the announcement channel does not deny them.",
}));

/** Posting features that are not a managed channel (#1254): each sends plain messages to one configured channel. */
const postingRequirements: FeatureRequirement[] = [
  ...weeklyAnnouncementRequirements,
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

/**
 * The other features that post to one configured channel (#1254, second group),
 * each audited from the producing service. `guild-text` marks the services that
 * accept only a plain text channel (`instanceof TextChannel`); the rest accept any
 * text-based channel. Where a failed post has no Discord-side sign, the `effect`
 * says it is in the bot's log only.
 */
const morePostingRequirements: FeatureRequirement[] = [
  {
    id: "birthdays-post",
    area: "Birthdays",
    feature: "Birthday announcements",
    scope: "channel",
    targetType: "guild-text",
    needs: [PERM.viewChannel, PERM.sendMessages],
    enabledKey: "birthdays.enabled",
    targetKey: "birthdays.channel_id",
    effect:
      "Birthday messages are not posted, and the birthday role is not granted for that member either. Each failed post is counted in the run summary and logged in the bot's log; the next hourly run tries again.",
    fix: "Give the bot's role View Channel and Send Messages, and make sure the birthday channel does not deny them.",
  },
  {
    id: "celebrations-post",
    area: "Celebrations",
    feature: "Milestone celebrations",
    scope: "channel",
    targetType: "guild-text",
    needs: [PERM.viewChannel, PERM.sendMessages],
    enabledKey: "celebrations.enabled",
    // Accolades are only awarded while achievements and voice tracking are on.
    alsoKeys: ["achievements.enabled", "voicetracking.enabled"],
    targetKey: "celebrations.channel_id",
    targetOptional: true,
    effect:
      "Milestone celebrations are not posted (the accolade is still awarded). The failure is logged in the bot's log only and is not retried.",
    fix: "Give the bot's role View Channel and Send Messages, and make sure the celebrations channel does not deny them.",
  },
  {
    id: "welcome-post",
    area: "Welcome messages",
    feature: "Welcome messages",
    scope: "channel",
    targetType: "text",
    needs: [PERM.viewChannel, PERM.sendMessages],
    enabledKey: "welcome.enabled",
    targetKey: "welcome.channel_id",
    effect:
      "New members are not greeted. The failure is logged in the bot's log only.",
    fix: "Give the bot's role View Channel and Send Messages, and make sure the welcome channel does not deny them.",
  },
  {
    id: "lfg-post",
    area: "Looking for group",
    feature: "Looking-for-group posts",
    scope: "channel",
    targetType: "text",
    needs: [
      PERM.viewChannel,
      PERM.sendMessages,
      PERM.embedLinks,
      PERM.readHistory,
    ],
    enabledKey: "lfg.enabled",
    targetKey: "lfg.channel_id",
    targetOptional: true,
    effect:
      "/lfg tells the member it could not post, and no post is made. Without Read Message History a post is not updated or closed when its party fills or its time runs out, so its buttons stay (logged in the bot's log only).",
    fix: "Give the bot's role View Channel, Send Messages, Embed Links and Read Message History, and make sure the LFG channel does not deny them.",
  },
  {
    id: "events-announce",
    area: "Events",
    feature: "Event announcements and reminders",
    scope: "channel",
    targetType: "guild-text",
    needs: [PERM.viewChannel, PERM.sendMessages, PERM.readHistory],
    enabledKey: "events.enabled",
    targetKey: "events.announcement_channel_id",
    targetOptional: true,
    effect:
      "Event announcements and start reminders are not posted, and an announcement is not updated or removed when the event changes. Failures are logged in the bot's log only; the event scan tries again.",
    fix: "Give the bot's role View Channel, Send Messages and Read Message History, and make sure the announcement channel does not deny them.",
  },
  {
    id: "leaderboard-announce",
    area: "Leaderboard roles",
    feature: "Leaderboard role announcements",
    scope: "channel",
    targetType: "text",
    needs: [PERM.viewChannel, PERM.sendMessages, PERM.embedLinks],
    enabledKey: "leaderboard_roles.enabled",
    // The reconciliation is skipped while voice tracking is off.
    alsoKeys: ["voicetracking.enabled"],
    targetKey: "leaderboard_roles.announcement_channel_id",
    targetOptional: true,
    effect:
      "The summary of who gained or lost a leaderboard role is not posted; the roles still change. The failure is logged in the bot's log only.",
    fix: "Give the bot's role View Channel, Send Messages and Embed Links, and make sure the announcement channel does not deny them.",
  },
  {
    id: "rules-message",
    area: "Rules",
    feature: "The rules message",
    scope: "channel",
    targetType: "text",
    needs: [PERM.viewChannel, PERM.sendMessages, PERM.readHistory],
    enabledKey: "rules.enabled",
    targetKey: "rules.channel_id",
    effect:
      "Posting, updating or re-posting the rules message on the Rules page fails, and the page shows the error. A message already posted keeps working.",
    fix: "Give the bot's role View Channel, Send Messages and Read Message History, and make sure the rules channel does not deny them.",
  },
  {
    id: "reaction-picker-post",
    area: "Reaction roles",
    feature: "Posting the role pickers",
    scope: "channel",
    targetType: "text",
    needs: [
      PERM.viewChannel,
      PERM.sendMessages,
      PERM.embedLinks,
      PERM.readHistory,
    ],
    enabledKey: "reactionroles.enabled",
    targetKey: "reactionroles.message_channel_id",
    effect:
      "New role pickers cannot be posted or added to (the Reaction Roles page shows the error), and at startup the bot cannot find existing pickers to restore a reaction that went missing (logged in the bot's log only).",
    fix: "Give the bot's role View Channel, Send Messages, Embed Links and Read Message History, and make sure the picker channel does not deny them.",
  },
  {
    id: "reaction-picker-reactions",
    area: "Reaction roles",
    feature: "Reactions on the role pickers",
    scope: "channel",
    targetType: "text",
    needs: [PERM.addReactions, PERM.manageMessages],
    enabledKey: "reactionroles.enabled",
    targetKey: "reactionroles.message_channel_id",
    effect:
      "Reaction pickers get no emoji to click (Add Reactions). A member's other reaction is not removed when they pick another role in one-of-a-set mode, or when a pick is refused (Manage Messages), so the message shows a pick that has no role. Button and menu pickers need neither. Logged in the bot's log only, and not at all for a refused pick.",
    fix: "Give the bot's role Add Reactions and Manage Messages, and make sure the picker channel does not deny them. Skip this if you only use button or menu pickers.",
  },
];

/**
 * Support tickets (`ticket-channel-manager.ts`, #1475). Every ticket channel is
 * created with explicit overwrites, so it does not take the category's
 * permissions: only the creation happens in the category, and what the bot does
 * inside a ticket comes from its own member overwrite (View Channel, Send
 * Messages, Read Message History, Attach Files, Manage Channels) plus its role's
 * server-wide permissions. That is why creation is a category entry and the
 * others are server-wide. Creation also has a server-wide half: Discord's
 * Create Guild Channel accepts permission overwrites only for "permissions your
 * bot has in the guild", so every bit `createTicketChannel` puts in the initial
 * overwrites (View Channel, Send Messages, Read Message History, Attach Files,
 * Manage Messages for staff, Manage Channels for the bot) must be held
 * server-wide, whatever the category grants. Closing a ticket edits an
 * existing overwrite, where Discord also counts the parent category; that
 * prerequisite is deliberately not evaluated (#1464 dropped the evaluator).
 * A ticket failure is never silent: the member sees "Something went wrong
 * talking to Discord".
 */
const ticketRequirements: FeatureRequirement[] = [
  {
    id: "tickets-create",
    area: "Tickets",
    feature: "Opening ticket channels",
    scope: "category",
    needs: [PERM.manageChannels],
    enabledKey: "tickets.enabled",
    targetKey: "tickets.category_id",
    effect:
      "/ticket open creates no channel: the member is told something went wrong talking to Discord, and the error is logged.",
    fix: "Give the bot's role Manage Channels, and make sure the ticket category does not deny it.",
  },
  {
    id: "tickets-create-overwrites",
    area: "Tickets",
    feature: "Setting up a new ticket's permissions",
    scope: "guild",
    needs: [
      PERM.viewChannel,
      PERM.sendMessages,
      PERM.readHistory,
      PERM.attachFiles,
      PERM.manageMessages,
      PERM.manageChannels,
    ],
    enabledKey: "tickets.enabled",
    effect:
      "/ticket open creates no channel: Discord refuses a new channel whose permissions give anyone something the bot does not hold itself server-wide (the author and staff get View Channel, Send Messages, Read Message History and Attach Files, staff also Manage Messages, the bot Manage Channels). The member is told something went wrong talking to Discord, and the error is logged.",
    fix: "Give the bot's role View Channel, Send Messages, Read Message History, Attach Files, Manage Messages and Manage Channels in Server Settings, Roles. A category overwrite does not count: Discord checks these server-wide.",
  },
  {
    id: "tickets-lock",
    area: "Tickets",
    feature: "Closing and reopening tickets",
    scope: "guild",
    needs: [PERM.manageRoles],
    enabledKey: "tickets.enabled",
    effect:
      "A ticket cannot be closed or reopened: the lock on the author's Send Messages permission cannot be changed, so a close is refused and the member or staff member is told something went wrong.",
    fix: "Give the bot's role Manage Roles in Server Settings, Roles.",
  },
  {
    id: "tickets-greeting",
    area: "Tickets",
    feature: "The greeting in a new ticket",
    scope: "guild",
    needs: [PERM.embedLinks],
    enabledKey: "tickets.enabled",
    effect:
      "The greeting embed with the ticket's subject is not shown in the new ticket. The ticket still opens; a failed greeting is logged in the bot's log only.",
    fix: "Give the bot's role Embed Links in Server Settings, Roles.",
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
  ...morePostingRequirements,
  ...ticketRequirements,
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
