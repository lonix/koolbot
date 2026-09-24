/**
 * Audit-log helper for the WebUI write surface (issue #383). Every
 * state-changing handler should call `recordAudit()` exactly once so each
 * write produces one row in `WebAuditLog` traceable to the redeemed
 * session that performed it.
 */

import logger from "../utils/logger.js";
import { WebAuditLog } from "../models/web-audit-log.js";
import type { WebSessionContext } from "./session.js";

export interface AuditEntry {
  action: string;
  targetId?: string | null;
  details?: Record<string, unknown>;
  result: "success" | "failure";
  errorMessage?: string | null;
}

function toAuditRow(
  session: WebSessionContext,
  entry: AuditEntry,
): Record<string, unknown> {
  return {
    guildId: session.guildId,
    sessionId: session.sessionId,
    discordUserId: session.discordUserId,
    // Whichever role the session is — an admin acting on their own
    // `/me/*` is logged with role:"admin" (see #481): the role is the
    // session's, not the URL surface's.
    role: session.role,
    action: entry.action,
    targetId: entry.targetId ?? null,
    details: entry.details ?? {},
    result: entry.result,
    errorMessage: entry.errorMessage ?? null,
  };
}

export async function recordAudit(
  session: WebSessionContext,
  entry: AuditEntry,
): Promise<void> {
  try {
    await WebAuditLog.create(toAuditRow(session, entry));
  } catch (err) {
    // Audit failures must never break the user's request. Surface them in
    // logs so operators notice persistent breakage.
    logger.error("Failed to record WebUI audit entry", err);
  }
}

/**
 * Like `recordAudit`, but lets the write failure propagate. For the one
 * place where an unrecorded action is worse than a refused one: the
 * self-service data reset (#917) writes its intent row with this and
 * refuses the purge if the row cannot be stored, so an operator can never
 * be left with a member's data gone and no trace of why.
 */
export async function recordAuditOrThrow(
  session: WebSessionContext,
  entry: AuditEntry,
): Promise<void> {
  await WebAuditLog.create(toAuditRow(session, entry));
}
