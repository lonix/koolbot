/**
 * Every Discord permission flag, with what KoolBot does with it (#1366), for
 * the "All Discord permissions" list on the Bot permissions page.
 *
 * Three kinds of flag:
 * - `checked`: in `bot-permission-registry.ts`, so the page checks it per
 *   feature (names and bits come from `PERM`, not from here);
 * - `used`: the bot's code needs it but the page does not check it yet (posting,
 *   moderation, ...; the posting features are #1254). Each entry says what for;
 * - `unused`: nothing in KoolBot's code needs it from the bot.
 *
 * A flag missing from `FLAG_USE` is `unclassified`, never `unused`: telling an
 * admin "KoolBot does not use this" about a permission it does use would invite
 * them to remove it. `__tests__/services/bot-permission-flags.test.ts` fails when
 * discord.js gains a flag that is not classified here.
 */

import { PermissionFlagsBits } from "discord.js";
import { PERM } from "./bot-permission-registry.js";

export type FlagUse =
  { kind: "used"; for: string } | { kind: "unused" } | { kind: "unclassified" };

const used = (what: string): FlagUse => ({ kind: "used", for: what });
const UNUSED: FlagUse = { kind: "unused" };

const CHANNEL_OVERWRITES =
  "Set in channel overwrites (read-only channels, tickets); Discord lets the bot only pass on permissions it holds.";

/** Classification by discord.js flag name (deprecated aliases of one bit are classified together). */
export const FLAG_USE: Readonly<Record<string, FlagUse>> = {
  SendMessages: used("Posting in channels. " + CHANNEL_OVERWRITES),
  EmbedLinks: used("Embeds in posts (quotes, notices, digests, logs)."),
  ReadMessageHistory: used(
    "Reading earlier messages (quotes, ticket transcripts, reaction roles).",
  ),
  AttachFiles: used("Ticket transcripts and quote exports."),
  AddReactions: used("Poll and reaction-role reactions."),
  ManageMessages: used(
    "Clearing a channel and removing reactions. " + CHANNEL_OVERWRITES,
  ),
  PinMessages: used("Pinning the header post of a managed channel."),
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
  Administrator: UNUSED,
  CreateInstantInvite: UNUSED,
  PrioritySpeaker: UNUSED,
  Stream: UNUSED,
  SendTTSMessages: UNUSED,
  ViewGuildInsights: UNUSED,
  MuteMembers: UNUSED,
  DeafenMembers: UNUSED,
  UseVAD: UNUSED,
  ChangeNickname: UNUSED,
  ManageEmojisAndStickers: UNUSED,
  ManageGuildExpressions: UNUSED,
  UseApplicationCommands: UNUSED,
  ManageThreads: UNUSED,
  UseExternalStickers: UNUSED,
  UseEmbeddedActivities: UNUSED,
  ViewCreatorMonetizationAnalytics: UNUSED,
  UseSoundboard: UNUSED,
  CreateGuildExpressions: UNUSED,
  UseExternalSounds: UNUSED,
  SendVoiceMessages: UNUSED,
  UseExternalApps: UNUSED,
  BypassSlowmode: UNUSED,
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
