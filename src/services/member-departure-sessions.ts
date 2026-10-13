import { AuditLogEvent } from "discord.js";
import { env } from "../config/env.js";
import logger from "../utils/logger.js";
import { sanitizeForLog } from "../utils/log-sanitize.js";
import { getErrorMessage } from "../utils/error-guards.js";
import { GUILD_MEMBERS_INTENT_HOWTO } from "../utils/guild-members-intent.js";
import { WebSessionService } from "./web-session-service.js";

/**
 * Ends a member's Web UI sessions when they leave the guild (#1151).
 *
 * The live re-check added in #1158 already stops a departed member on their
 * next request (a fresh member lookup, reused for ~15 s). This is the second
 * half: the session rows are revoked the moment the bot hears about the
 * departure, so a kicked or banned member does not keep a live session row,
 * and a rejoin does not resurrect it.
 *
 * Nothing here stores member data: the only write is the existing soft revoke
 * (`revokedAt`) on `WebSession` rows, which `WebSessionService` already owns.
 * Callers are responsible for the guild-scope gate (`shouldIgnoreGuild`).
 */

export type DepartureCause = "left" | "kick" | "ban";

/**
 * Revoke every unrevoked Web UI session of `userId`. A member who is not
 * signed in is a no-op, and a failure is logged and swallowed, because a
 * gateway handler must never crash and the live re-check still denies them.
 * Returns the number of sessions revoked.
 */
export async function revokeWebSessionsForDeparture(
  userId: string,
  cause: DepartureCause,
): Promise<number> {
  if (!userId) return 0;
  try {
    const revoked = await WebSessionService.getInstance().revokeForUser(userId);
    if (revoked > 0) {
      logger.info(
        `Revoked ${revoked} web session(s) for user ${sanitizeForLog(userId)} (${cause})`,
      );
    }
    return revoked;
  } catch (error) {
    logger.warn(
      `Could not revoke web sessions for departed user ${sanitizeForLog(userId)} (${cause}); the live membership re-check still applies: ${getErrorMessage(error)}`,
    );
    return 0;
  }
}

/**
 * Handle a `GuildAuditLogEntryCreate` entry: a kick or a ban revokes the
 * target's sessions. Works with only the always-on GuildModeration intent, so
 * kicks and bans are covered even when `GUILD_MEMBERS_INTENT` is off. Not tied
 * to `moderation.enabled`, since access control must not depend on the
 * moderation log being switched on. Other actions are ignored.
 */
export async function handleDepartureAuditEntry(entry: {
  action: number;
  targetId?: string | null;
}): Promise<void> {
  let cause: DepartureCause;
  if (entry.action === AuditLogEvent.MemberKick) cause = "kick";
  else if (entry.action === AuditLogEvent.MemberBanAdd) cause = "ban";
  else return;
  if (!entry.targetId) return;
  await revokeWebSessionsForDeparture(entry.targetId, cause);
}

/**
 * Warn once at startup that, with the Web UI on and the GuildMembers intent
 * off, member-leave events are not delivered. Not an error: the live
 * re-check covers it and kicks/bans still arrive via the audit log.
 */
export function warnIfLeaveEventsMissing(webUiEnabled: boolean): boolean {
  if (!webUiEnabled || env.guildMembersIntent) return false;
  logger.warn(
    `The Web UI is on but the bot is not requesting the Server Members Intent: Discord does not deliver member-leave events, so a member who simply leaves keeps their Web UI session row until their next request, where the live membership check ends it (within about 15 s). Kicks and bans still revoke sessions at once. ${GUILD_MEMBERS_INTENT_HOWTO}`,
  );
  return true;
}
