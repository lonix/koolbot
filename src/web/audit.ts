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

export async function recordAudit(
  session: WebSessionContext,
  entry: AuditEntry,
): Promise<void> {
  try {
    await WebAuditLog.create({
      guildId: session.guildId,
      sessionId: session.sessionId,
      discordUserId: session.discordUserId,
      action: entry.action,
      targetId: entry.targetId ?? null,
      details: entry.details ?? {},
      result: entry.result,
      errorMessage: entry.errorMessage ?? null,
    });
  } catch (err) {
    // Audit failures must never break the user's request. Surface them in
    // logs so operators notice persistent breakage.
    logger.error("Failed to record WebUI audit entry", err);
  }
}
