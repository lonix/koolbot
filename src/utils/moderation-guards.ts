import type { Guild, GuildMember } from "discord.js";
import { truncateText } from "./discord-limits.js";

/**
 * Shared guards for the bot-issued moderation commands (`/warn`, `/ban`,
 * `/timeout` — #857).
 *
 * `/warn` only writes a row, so it needs nothing beyond the reason cap. `/ban`
 * and `/timeout` actually act on the member through Discord's API, which moves
 * two checks Discord normally performs for us into our own hands:
 *
 *   1. **Role hierarchy.** In Discord's native UI a moderator can only act on
 *      members below them. Routed through the bot, the executor becomes
 *      KoolBot, so Discord only checks *the bot's* position — a moderator
 *      could otherwise ban someone who outranks them. {@link checkHierarchy}
 *      re-applies the check the native UI would have made.
 *   2. **The bot's own standing.** The bot's role must outrank the target and
 *      hold the relevant permission; discord.js exposes that as
 *      `GuildMember.bannable` / `.moderatable`. A moderator whose role sits
 *      above the bot's can act natively but not through the bot, so the
 *      refusal says so instead of surfacing a bare "Missing Permissions".
 */

/**
 * Maximum reason length accepted by the moderation commands. Matches
 * Discord's own `X-Audit-Log-Reason` cap (1–512 UTF-8 characters), so a reason
 * that passes here is always deliverable as an audit-log reason too.
 */
export const MAX_REASON_LENGTH = 512;

/**
 * Longest message-deletion window Discord accepts when banning
 * (`delete_message_seconds`, 7 days).
 */
export const MAX_MESSAGE_DELETE_DAYS = 7;

/** Discord's hard cap on a communication timeout. */
export const MAX_TIMEOUT_MINUTES = 28 * 24 * 60;

/**
 * Render the reason KoolBot sends to Discord for a bot-issued action.
 *
 * `guild.bans.create()` / `member.timeout()` record **KoolBot** as the
 * audit-log executor, not the moderator who ran the command, so the human
 * would exist only in our own Mongo row. Prefixing the reason with the
 * moderator keeps them in Discord's native record too — which still reads
 * correctly if the moderation log is pruned, disabled, or lost.
 */
export function formatAuditReason(
  moderatorTag: string,
  reason: string,
): string {
  return truncateText(`${moderatorTag}: ${reason}`, MAX_REASON_LENGTH);
}

export interface HierarchyCheckInput {
  guild: Guild;
  /** The moderator who ran the command, as a guild member. */
  invoker: GuildMember;
  /** The target as a guild member, or `null` when they are not in the guild. */
  targetMember: GuildMember | null;
  /** Infinitive used in refusal messages, e.g. `"ban"` or `"time out"`. */
  verb: string;
  /** The discord.js capability flag the action needs on the target. */
  capability: "bannable" | "moderatable";
}

/**
 * Re-apply the checks Discord's native UI would have made, returning the
 * refusal to show the moderator or `null` when the action may proceed.
 *
 * A `null` `targetMember` (someone who already left, or a pre-emptive ban by
 * id) passes: there is no role to compare and Discord itself allows it.
 */
export function checkHierarchy(input: HierarchyCheckInput): string | null {
  const { guild, invoker, targetMember, verb, capability } = input;

  if (!targetMember) return null;

  if (targetMember.id === guild.ownerId) {
    return `You can't ${verb} the server owner.`;
  }

  // The guild owner outranks everyone, including a role that compares equal.
  if (
    invoker.id !== guild.ownerId &&
    targetMember.roles.highest.position >= invoker.roles.highest.position
  ) {
    return `You can't ${verb} **${targetMember.user.tag}** — their highest role is not below yours.`;
  }

  if (!targetMember[capability]) {
    return (
      `I can't ${verb} **${targetMember.user.tag}** — my own role must be above theirs ` +
      `and I need the matching permission. Use Discord's member menu instead, or fix my role position.`
    );
  }

  return null;
}
