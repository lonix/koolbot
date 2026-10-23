/**
 * Every Discord permission flag, with what KoolBot does with it (#1366), for
 * the "All Discord permissions" list on the Bot permissions page.
 *
 * Three kinds of flag:
 * - `checked`: in `bot-permission-registry.ts`, so the page checks it per
 *   feature (names and bits come from `PERM`, not from here);
 * - `used`: the bot's code needs it but the page does not check it yet (moderation,
 *   the posting channels that are not covered yet, ...). Each entry says what for;
 * - `grant-only`: KoolBot's code does not use it itself. It may still be needed:
 *   Role groups can grant any Discord permission to a role, and the bot can only
 *   hand out permissions it holds (server-adoption-planner.ts, "bot-lacks-permission").
 *   So no flag is ever labelled plain "unused".
 *
 * A flag missing from `FLAG_USE` is `unclassified`: it is never presented as
 * safe to remove. `__tests__/services/bot-permission-flags.test.ts` fails when
 * discord.js gains a flag that is not classified here.
 */

import { PermissionFlagsBits } from "discord.js";
import { PERM } from "./bot-permission-registry.js";

export type FlagUse =
  | { kind: "used"; for: string }
  | { kind: "grant-only" }
  | { kind: "unclassified" };

const used = (what: string): FlagUse => ({ kind: "used", for: what });
const GRANT_ONLY: FlagUse = { kind: "grant-only" };

const CHANNEL_OVERWRITES =
  "Set in channel overwrites (read-only channels, tickets); Discord lets the bot only pass on permissions it holds.";

/** Classification by discord.js flag name (deprecated aliases of one bit are classified together). */
export const FLAG_USE: Readonly<Record<string, FlagUse>> = {
  AttachFiles: used("Ticket transcripts and quote exports."),
  ModerateMembers: used("Timeouts (/timeout and raid mode)."),
  KickMembers: used("Raid mode kicks."),
  BanMembers: used("/ban."),
  ViewAuditLog: used("Reading who changed a channel."),
  ManageWebhooks: used("Reading the server's webhooks during the scan."),
  CreatePublicThreads: used(CHANNEL_OVERWRITES),
  CreatePrivateThreads: used(CHANNEL_OVERWRITES),
  SendMessagesInThreads: used(CHANNEL_OVERWRITES),
  RequestToSpeak: used(CHANNEL_OVERWRITES),
  UseExternalEmojis: used(
    "Only when a reaction or message uses a custom emoji from another server.",
  ),
  MentionEveryone: used(
    "Scheduled announcements that mention @everyone, @here or a role, and pinging a role that members cannot mention themselves.",
  ),
  SendPolls: used("Scheduled polls are sent as native Discord polls."),
  ManageGuild: used(
    "Reading the server's onboarding settings during the scan.",
  ),
  Administrator: GRANT_ONLY,
  CreateInstantInvite: GRANT_ONLY,
  PrioritySpeaker: GRANT_ONLY,
  Stream: GRANT_ONLY,
  SendTTSMessages: GRANT_ONLY,
  ViewGuildInsights: GRANT_ONLY,
  MuteMembers: GRANT_ONLY,
  DeafenMembers: GRANT_ONLY,
  UseVAD: GRANT_ONLY,
  ChangeNickname: GRANT_ONLY,
  ManageEmojisAndStickers: GRANT_ONLY,
  ManageGuildExpressions: GRANT_ONLY,
  UseApplicationCommands: GRANT_ONLY,
  ManageThreads: GRANT_ONLY,
  UseExternalStickers: GRANT_ONLY,
  UseEmbeddedActivities: GRANT_ONLY,
  ViewCreatorMonetizationAnalytics: GRANT_ONLY,
  UseSoundboard: GRANT_ONLY,
  CreateGuildExpressions: GRANT_ONLY,
  UseExternalSounds: GRANT_ONLY,
  SendVoiceMessages: GRANT_ONLY,
  UseExternalApps: GRANT_ONLY,
  BypassSlowmode: GRANT_ONLY,
};

/** Names as Discord's role editor shows them, where they differ from the flag name. */
const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  CreateInstantInvite: "Create Invite",
  ManageGuild: "Manage Server",
  Stream: "Video",
  SendTTSMessages: "Send Text-to-Speech Messages",
  MentionEveryone: "Mention @everyone, @here and All Roles",
  UseExternalEmojis: "Use External Emoji",
  ViewGuildInsights: "View Server Insights",
  UseVAD: "Use Voice Activity",
  ManageEmojisAndStickers: "Manage Expressions",
  ManageGuildExpressions: "Manage Expressions",
  ModerateMembers: "Timeout Members",
};

function splitName(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, "$1 $2");
}

export interface FlagRow {
  /** The discord.js flag name. */
  key: string;
  /** Discord's name for it (unescaped). */
  name: string;
  bit: bigint;
  /** `checked`: the registry (and the matrix above) covers it. */
  use: FlagUse | { kind: "checked" };
}

const REGISTRY_NAMES = new Map<bigint, string>(
  Object.values(PERM).map((p) => [p.bit, p.name] as const),
);

/** One row per distinct permission bit (discord.js keeps deprecated aliases for some), in discord.js order. */
export function allFlagRows(
  flags: Readonly<Record<string, bigint>> = PermissionFlagsBits,
): FlagRow[] {
  const keysByBit = new Map<bigint, string[]>();
  for (const [key, bit] of Object.entries(flags)) {
    keysByBit.set(bit, [...(keysByBit.get(bit) ?? []), key]);
  }
  return [...keysByBit.entries()].map(([bit, keys]) => {
    const registryName = REGISTRY_NAMES.get(bit);
    const classified = keys
      .map((k) => FLAG_USE[k])
      .find((u) => u !== undefined);
    return {
      key: keys[0],
      bit,
      name:
        registryName ??
        keys.map((k) => DISPLAY_NAMES[k]).find((n) => n !== undefined) ??
        splitName(keys[0]),
      use: registryName
        ? { kind: "checked" as const }
        : (classified ?? { kind: "unclassified" as const }),
    };
  });
}
