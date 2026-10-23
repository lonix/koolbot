/**
 * The bot's own reaction-role messages, for the picker that chooses what the
 * welcome message's `{roles}` links to (#1433).
 *
 * Everything here comes from the `ReactionRoleConfig` rows the bot stored, plus
 * channel names the page already holds. There is no Discord call per message:
 * a message or channel that was deleted later still has its rows (until the
 * mapping is archived), and shows up labelled by what is stored.
 *
 * Two reads, deliberately separate:
 * - {@link loadReactionRoleMessageIds} is the set the server checks a posted id
 *   against. It is complete (never capped) and throws when the database cannot
 *   be read, so a save is refused rather than accepted unchecked.
 * - {@link loadReactionRoleMessageOptions} is the display list: newest first,
 *   capped, and `null` when it cannot be read (the page still renders and keeps
 *   the stored value).
 */

import { ReactionRoleConfig } from "../models/reaction-role-config.js";
import { channelText, missingText } from "./discord-labels.js";
import type { ChannelType } from "discord.js";

/** How many messages the picker lists. Newer messages win; older ones are not listed. */
export const REACTION_ROLE_MESSAGE_LIST_CAP = 50;

/** The most roles named in one label before "+N". */
const LABEL_ROLES = 3;
/** A label is cut here so a long role list never widens the select. */
const LABEL_MAX_CHARS = 100;

export interface ReactionRoleMessageOption {
  /** The stored value: the message id. */
  messageId: string;
  /** What the operator sees: where it is and which roles it hands out. */
  label: string;
}

export interface ReactionRoleMessageOptions {
  options: ReactionRoleMessageOption[];
  /** True when more messages exist than the cap lists. */
  truncated: boolean;
}

/** What the picker needs to know about the page's channel lookup. */
export interface MessageChannelLookup {
  names: ReadonlyMap<string, string>;
  types: ReadonlyMap<string, ChannelType>;
  /**
   * False when the guild's channel list could not be read, so a channel that is
   * not in `names` is not known to be deleted.
   */
  known: boolean;
  /** `reactionroles.message_channel_id`, for a legacy row with no channel of its own. */
  configuredChannelId: string;
}

/** One stored message, grouped from its mapping rows. */
export interface ReactionRoleMessageGroup {
  messageId: string;
  messageChannelId: string | null;
  roles: Array<{ emoji: string; roleName: string }>;
}

/**
 * Ids of the guild's reaction-role messages that are still in use (not
 * archived). Rejects when the read fails; callers refuse the save then.
 */
export async function loadReactionRoleMessageIds(
  guildId: string,
): Promise<Set<string>> {
  const ids = (await ReactionRoleConfig.distinct("messageId", {
    guildId,
    isArchived: false,
  })) as unknown[];
  return new Set(
    ids.filter((id): id is string => typeof id === "string" && id !== ""),
  );
}

function roleLabel(r: { emoji: string; roleName: string }): string {
  // A custom server emoji is stored as markup, which a native option cannot show.
  const emoji = r.emoji && !r.emoji.startsWith("<") ? `${r.emoji} ` : "";
  return `${emoji}${r.roleName}`;
}

/** Cut to `max` code points, ending in an ellipsis when something was removed. */
function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/**
 * The label of one message: `# roles · 🎮 Gamer, 🎨 Artist +3`. The channel part
 * is the stored channel (or the configured one for a legacy row); a channel the
 * page could not find is shown as unavailable, and with no channel on record
 * the part is left out. Plain text: it goes inside a native `<option>`.
 */
export function reactionRoleMessageLabel(
  group: ReactionRoleMessageGroup,
  lookup: MessageChannelLookup,
): string {
  const channelId = group.messageChannelId || lookup.configuredChannelId;
  let where = "";
  if (channelId) {
    const name = lookup.names.get(channelId);
    if (name !== undefined) {
      where = channelText({ name, type: lookup.types.get(channelId) });
    } else {
      where = lookup.known ? missingText(channelId) : `# ${channelId}`;
    }
  }
  const named = group.roles.slice(0, LABEL_ROLES).map(roleLabel).join(", ");
  const more =
    group.roles.length > LABEL_ROLES
      ? ` +${group.roles.length - LABEL_ROLES}`
      : "";
  const roles = named ? `${named}${more}` : "no roles";
  return clip(where ? `${where} · ${roles}` : roles, LABEL_MAX_CHARS);
}

/** Turn grouped messages into the capped, labelled option list. */
export function buildReactionRoleMessageOptions(
  groups: ReactionRoleMessageGroup[],
  lookup: MessageChannelLookup,
): ReactionRoleMessageOptions {
  return {
    options: groups.slice(0, REACTION_ROLE_MESSAGE_LIST_CAP).map((g) => ({
      messageId: g.messageId,
      label: reactionRoleMessageLabel(g, lookup),
    })),
    truncated: groups.length > REACTION_ROLE_MESSAGE_LIST_CAP,
  };
}

/**
 * Fill in the channel of a message none of whose active mappings records one,
 * from a sibling mapping of the same message in this guild, archived ones
 * included (role deletion archives a mapping but leaves the shared picker).
 * The same rule as `ReactionRoleService.pickerChannelForMessage`, batched into
 * one query. A failed lookup leaves the channel unknown: the label then falls
 * back to the configured channel, as it did before.
 */
async function fillSiblingChannels(
  guildId: string,
  groups: ReactionRoleMessageGroup[],
): Promise<void> {
  const missing = groups.filter((g) => !g.messageChannelId);
  if (missing.length === 0) return;
  try {
    const siblings = (await ReactionRoleConfig.find({
      guildId,
      messageId: { $in: missing.map((g) => g.messageId) },
      messageChannelId: { $exists: true, $ne: "" },
    })) as Array<{ messageId: string; messageChannelId?: string | null }>;
    const byMessage = new Map<string, string>();
    for (const row of siblings ?? []) {
      if (row.messageChannelId && !byMessage.has(row.messageId)) {
        byMessage.set(row.messageId, row.messageChannelId);
      }
    }
    for (const g of missing) {
      g.messageChannelId = byMessage.get(g.messageId) ?? null;
    }
  } catch {
    // Keep the configured-channel fallback.
  }
}

/**
 * The guild's reaction-role messages, newest first, for the picker. `null` when
 * the read fails: the page then renders without a list and keeps the stored
 * value, instead of claiming that there are none.
 */
export async function loadReactionRoleMessageOptions(
  guildId: string,
  lookup: MessageChannelLookup,
): Promise<ReactionRoleMessageOptions | null> {
  try {
    const rows = (await ReactionRoleConfig.aggregate([
      { $match: { guildId, isArchived: false } },
      { $sort: { createdAt: 1 } },
      {
        $group: {
          _id: "$messageId",
          // Any recorded channel: a legacy message can have an older active
          // mapping without one and a newer sibling that has it. `$max` skips
          // missing values and ranks "" lowest, so a real id wins.
          messageChannelId: { $max: "$messageChannelId" },
          roles: { $push: { emoji: "$emoji", roleName: "$roleName" } },
          newest: { $max: "$createdAt" },
        },
      },
      { $sort: { newest: -1 } },
      // One more than the cap says whether the list was cut.
      { $limit: REACTION_ROLE_MESSAGE_LIST_CAP + 1 },
    ])) as Array<{
      _id: string;
      messageChannelId?: string | null;
      roles: Array<{ emoji: string; roleName: string }>;
    }>;
    const groups: ReactionRoleMessageGroup[] = rows.map((r) => ({
      messageId: r._id,
      messageChannelId: r.messageChannelId || null,
      roles: r.roles ?? [],
    }));
    await fillSiblingChannels(guildId, groups);
    return buildReactionRoleMessageOptions(groups, lookup);
  } catch {
    return null;
  }
}
