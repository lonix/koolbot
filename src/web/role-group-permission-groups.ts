/**
 * The Discord permissions of the Role groups form, in the groups of Discord's
 * own role editor (#1615). discord.js has the flags but not the groups, so the
 * mapping lives here, in one table.
 *
 * The names come from `allFlagRows()` (the Bot permissions page's names), so one
 * permission has one name everywhere. A flag this table does not know, such as
 * one a later discord.js adds, lands in the last group, "Other", and is never
 * dropped from the form. `__tests__/web/role-group-permission-groups.test.ts`
 * checks that every flag appears exactly once.
 */

import { PermissionFlagsBits } from "discord.js";
import { allFlagRows, type FlagRow } from "../services/bot-permission-flags.js";

export interface PermissionGroup {
  key: string;
  /** Sentence case, as the group summary shows it. */
  title: string;
  /** discord.js flag names, in the order the group lists them. Aliases of one bit may both be named. */
  flags: readonly string[];
}

/** The groups in the order the form draws them. */
export const PERMISSION_GROUPS: readonly PermissionGroup[] = [
  {
    key: "general",
    title: "General server permissions",
    flags: [
      "ViewChannel",
      "ManageChannels",
      "ManageRoles",
      "CreateGuildExpressions",
      "ManageGuildExpressions",
      "ManageEmojisAndStickers",
      "ViewAuditLog",
      "ViewGuildInsights",
      "ManageWebhooks",
      "ManageGuild",
      "ViewCreatorMonetizationAnalytics",
    ],
  },
  {
    key: "membership",
    title: "Membership",
    flags: [
      "CreateInstantInvite",
      "ChangeNickname",
      "ManageNicknames",
      "KickMembers",
      "BanMembers",
      "ModerateMembers",
    ],
  },
  {
    key: "text",
    title: "Text channels",
    flags: [
      "SendMessages",
      "SendMessagesInThreads",
      "CreatePublicThreads",
      "CreatePrivateThreads",
      "EmbedLinks",
      "AttachFiles",
      "AddReactions",
      "UseExternalEmojis",
      "UseExternalStickers",
      "MentionEveryone",
      "ManageMessages",
      "PinMessages",
      "BypassSlowmode",
      "ManageThreads",
      "ReadMessageHistory",
      "SendTTSMessages",
      "SendVoiceMessages",
      "SendPolls",
    ],
  },
  {
    key: "voice",
    title: "Voice channels",
    flags: [
      "Connect",
      "Speak",
      "Stream",
      "UseSoundboard",
      "UseExternalSounds",
      "UseVAD",
      "PrioritySpeaker",
      "MuteMembers",
      "DeafenMembers",
      "MoveMembers",
      "SetVoiceChannelStatus",
    ],
  },
  { key: "stage", title: "Stage channels", flags: ["RequestToSpeak"] },
  {
    key: "apps",
    title: "Apps",
    flags: [
      "UseApplicationCommands",
      "UseEmbeddedActivities",
      "UseExternalApps",
    ],
  },
  { key: "events", title: "Events", flags: ["CreateEvents", "ManageEvents"] },
  { key: "advanced", title: "Advanced", flags: ["Administrator"] },
];

export const OTHER_GROUP_KEY = "other";
const OTHER_TITLE = "Other";

/** The Advanced group, whose last (only) row is Administrator. */
export const ADMINISTRATOR_FLAG = "Administrator";

export interface PermissionGroupRows {
  key: string;
  title: string;
  rows: FlagRow[];
}

/**
 * Every permission, once, in its group. `flags` is injectable so a test can
 * add a flag; groups with no rows are left out.
 */
export function groupPermissionRows(
  flags: Readonly<Record<string, bigint>> = PermissionFlagsBits,
): PermissionGroupRows[] {
  const rows = allFlagRows(flags);
  const placed = new Set<bigint>();
  const groups: PermissionGroupRows[] = PERMISSION_GROUPS.map((g) => {
    const inGroup: FlagRow[] = [];
    for (const flag of g.flags) {
      const bit = flags[flag];
      if (bit === undefined || placed.has(bit)) continue;
      const row = rows.find((r) => r.bit === bit);
      // An alias of a placed bit finds `placed` set, so one bit is one row.
      if (!row) continue;
      placed.add(bit);
      inGroup.push(row);
    }
    return { key: g.key, title: g.title, rows: inGroup };
  });
  const other = rows.filter((r) => !placed.has(r.bit));
  if (other.length > 0) {
    groups.push({ key: OTHER_GROUP_KEY, title: OTHER_TITLE, rows: other });
  }
  return groups.filter((g) => g.rows.length > 0);
}
