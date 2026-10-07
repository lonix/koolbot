import { ChannelType, PermissionsBitField } from "discord.js";

/**
 * The single copy of the channel permission sets KoolBot expects (#1022).
 *
 * Each set is declared once, as permission *names*, and read in two forms:
 *
 * - `toOverwriteOptions` → the `{ ViewChannel: true, … }` object that
 *   discord.js `permissionOverwrites.edit()` takes (the notices channel
 *   manager, reaction-role categories and the voice manager use this);
 * - `toBitfields` → decimal `allow` / `deny` strings, the form the adoption
 *   planner (#1018) diffs and the snapshot stores.
 *
 * Both are derived from the same names, so a feature's expected permissions
 * cannot differ between "KoolBot created the channel" and "an admin adopted an
 * existing one". Pure: no Discord or database access.
 */

export type PermissionName = keyof typeof PermissionsBitField.Flags;

export interface PermissionSet {
  allow: readonly PermissionName[];
  deny: readonly PermissionName[];
}

/** discord.js `permissionOverwrites.edit()` options: true = allow, false = deny. */
export function toOverwriteOptions(
  set: PermissionSet,
): Partial<Record<PermissionName, boolean>> {
  const options: Partial<Record<PermissionName, boolean>> = {};
  for (const name of set.deny) options[name] = false;
  for (const name of set.allow) options[name] = true;
  return options;
}

/** Bitfield (decimal string) of the named permissions. */
export function bitsOf(names: readonly PermissionName[]): string {
  return names
    .reduce((acc, name) => acc | PermissionsBitField.Flags[name], 0n)
    .toString();
}

/** The planner's `allow` / `deny` strings for a set. */
export function toBitfields(set: PermissionSet): {
  allow: string;
  deny: string;
} {
  return { allow: bitsOf(set.allow), deny: bitsOf(set.deny) };
}

/**
 * Layer `set` over an existing overwrite without disturbing unrelated bits:
 * what `set` allows is removed from the old deny, what it denies is removed
 * from the old allow, and everything else is kept. This is what makes a claim
 * leave an admin's other settings on the same target alone.
 */
export function mergeOverwrite(
  existing: { allow: string; deny: string } | undefined,
  set: PermissionSet,
): { allow: string; deny: string } {
  const oldAllow = BigInt(existing?.allow ?? "0");
  const oldDeny = BigInt(existing?.deny ?? "0");
  const add = BigInt(bitsOf(set.allow));
  const remove = BigInt(bitsOf(set.deny));
  return {
    allow: ((oldAllow & ~remove) | add).toString(),
    deny: ((oldDeny & ~add) | remove).toString(),
  };
}

/** Channel families that differ in what "read-only" or "gated" means. */
export type ChannelFamily =
  "text" | "announcement" | "forum" | "stage" | "voice" | "category";

/** Derive the family from a Discord channel type (or, failing that, a kind). */
export function channelFamily(
  rawType: number | undefined,
  kind: "category" | "text" | "voice" | "other",
): ChannelFamily {
  switch (rawType) {
    case ChannelType.GuildCategory:
      return "category";
    case ChannelType.GuildAnnouncement:
      return "announcement";
    case ChannelType.GuildForum:
    case ChannelType.GuildMedia:
      return "forum";
    case ChannelType.GuildStageVoice:
      return "stage";
    case ChannelType.GuildVoice:
      return "voice";
    case ChannelType.GuildText:
      return "text";
    default:
      if (kind === "category") return "category";
      if (kind === "voice") return "voice";
      return "text";
  }
}

// ---------------------------------------------------------------------------
// Read-only (bot posts)
// ---------------------------------------------------------------------------

export interface ReadOnlyOptions {
  /** Members may still add reactions (the notices channel allows them). */
  allowReactions?: boolean;
  /** Forums only: also stop members replying inside existing posts. */
  lockReplies?: boolean;
}

/**
 * What `@everyone` (and any other group that should not post) is denied in a
 * read-only channel.
 *
 * - text / announcement: no messages, no thread replies, no new threads;
 * - forum: no new posts (`SendMessages`), but replies stay open unless
 *   `lockReplies`;
 * - stage: no requesting to speak;
 * - voice: no speaking.
 */
export function readOnlyEveryone(
  family: ChannelFamily,
  options: ReadOnlyOptions = {},
): PermissionSet {
  const allowReactions = options.allowReactions ?? true;
  const deny: PermissionName[] = [];
  switch (family) {
    case "forum":
      deny.push("SendMessages", "CreatePublicThreads", "CreatePrivateThreads");
      if (options.lockReplies) deny.push("SendMessagesInThreads");
      break;
    case "stage":
      deny.push("RequestToSpeak");
      break;
    case "voice":
      deny.push("Speak");
      break;
    case "category":
      // A category itself has no posting rules; its channels carry them.
      break;
    default:
      deny.push(
        "SendMessages",
        "SendMessagesInThreads",
        "CreatePublicThreads",
        "CreatePrivateThreads",
      );
  }
  const textual = family !== "stage" && family !== "voice";
  if (!allowReactions && textual && family !== "category") {
    deny.push("AddReactions");
  }
  // Never grants anything: a read-only claim must not undo a gate on the same
  // channel (allowing `ViewChannel` here would reveal a hidden channel).
  return { allow: [], deny };
}

/** What a group allowed to post in a read-only channel is given back. */
export function readOnlyPoster(family: ChannelFamily): PermissionSet {
  switch (family) {
    case "forum":
      return {
        allow: [
          "SendMessages",
          "SendMessagesInThreads",
          "CreatePublicThreads",
          "AddReactions",
        ],
        deny: [],
      };
    case "stage":
      return { allow: ["RequestToSpeak"], deny: [] };
    case "voice":
      return { allow: ["Speak"], deny: [] };
    case "category":
      return { allow: [], deny: [] };
    default:
      return {
        allow: [
          "SendMessages",
          "SendMessagesInThreads",
          "CreatePublicThreads",
          "AddReactions",
        ],
        deny: [],
      };
  }
}

/** What the bot needs to post in a channel it owns. */
export const BOT_POSTS: PermissionSet = {
  allow: [
    "ViewChannel",
    "ReadMessageHistory",
    "SendMessages",
    "SendMessagesInThreads",
    "EmbedLinks",
    "AddReactions",
  ],
  deny: [],
};

// ---------------------------------------------------------------------------
// The notices channel (notices-channel-manager.ts)
// ---------------------------------------------------------------------------

/** `@everyone` in the notices channel: read and react, never post. */
export const NOTICES_EVERYONE: PermissionSet = {
  allow: ["AddReactions", "ViewChannel", "ReadMessageHistory"],
  deny: readOnlyEveryone("text").deny,
};

/** The bot in the notices channel: posts, moderates and manages it. */
export const NOTICES_BOT: PermissionSet = {
  allow: [
    "SendMessages",
    "ManageMessages",
    "ManageChannels",
    "AddReactions",
    "ViewChannel",
    "ReadMessageHistory",
  ],
  deny: [],
};

// ---------------------------------------------------------------------------
// Group-gated (reaction-role categories, VIP lounges, staff channels)
// ---------------------------------------------------------------------------

/**
 * `@everyone` in a gated channel: cannot see it. Voice and stage channels also
 * lose `Connect`, so visibility and joining never disagree.
 */
export function gateEveryone(family: ChannelFamily): PermissionSet {
  return {
    allow: [],
    deny:
      family === "voice" || family === "stage"
        ? ["ViewChannel", "Connect"]
        : ["ViewChannel"],
  };
}

/** A role allowed into a gated channel. */
export function gateMember(family: ChannelFamily): PermissionSet {
  return {
    allow:
      family === "voice" || family === "stage"
        ? ["ViewChannel", "Connect"]
        : ["ViewChannel"],
    deny: [],
  };
}

/** The bot on a category it must keep managing, even when gated. */
export const BOT_CATEGORY: PermissionSet = {
  allow: ["ViewChannel", "ManageChannels", "ManageRoles"],
  deny: [],
};

/** The reaction-role category: `@everyone` out, role members in, bot managing. */
export const GATED_CATEGORY_EVERYONE: PermissionSet = gateEveryone("category");
export const GATED_CATEGORY_ROLE: PermissionSet = gateMember("category");

// ---------------------------------------------------------------------------
// Voice channels (voice-channel-manager.ts)
// ---------------------------------------------------------------------------

/** `@everyone` in a lobby or a freshly created voice room. */
export const VOICE_ROOM_EVERYONE: PermissionSet = {
  allow: ["Connect", "Speak", "ViewChannel"],
  deny: [],
};

/** The owner of a dynamic voice room. */
export const VOICE_ROOM_OWNER: PermissionSet = {
  allow: ["ManageChannels", "Connect", "Speak", "ViewChannel"],
  deny: [],
};

/** The voice category and lobby the bot must be able to use. */
export const BOT_VOICE_CATEGORY: PermissionSet = {
  allow: ["ViewChannel", "ManageChannels", "Connect"],
  deny: [],
};
export const BOT_VOICE_LOBBY: PermissionSet = {
  allow: ["ViewChannel", "Connect"],
  deny: [],
};
