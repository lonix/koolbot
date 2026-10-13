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

const AUDIT_STRING_MAX = 256;
const AUDIT_MAX_DEPTH = 4;
const AUDIT_MAX_KEYS = 50;

/** Control characters out, length capped. Never throws. */
export function truncateForAudit(
  value: unknown,
  max = AUDIT_STRING_MAX,
): string {
  const str = typeof value === "string" ? value : String(value ?? "");
  // eslint-disable-next-line no-control-regex
  const cleaned = str.replace(/[\x00-\x1f\x7f]+/g, " ");
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max)}…`;
}

function boundValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return truncateForAudit(value);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  if (depth >= AUDIT_MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) {
    return value.slice(0, AUDIT_MAX_KEYS).map((v) => boundValue(v, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(
    0,
    AUDIT_MAX_KEYS,
  )) {
    out[truncateForAudit(k, 64)] = boundValue(v, depth + 1);
  }
  return out;
}

/**
 * Bound an audit entry whose strings may be member-supplied (the `/me`
 * surface, #1142): every string is control-stripped and capped, and nesting
 * and key counts are limited. Admin writes keep their full details.
 */
export function boundAuditEntry(entry: AuditEntry): AuditEntry {
  return {
    ...entry,
    action: truncateForAudit(entry.action, 128),
    targetId:
      entry.targetId == null
        ? entry.targetId
        : truncateForAudit(entry.targetId),
    details: entry.details
      ? (boundValue(entry.details, 0) as Record<string, unknown>)
      : entry.details,
    errorMessage:
      entry.errorMessage == null
        ? entry.errorMessage
        : truncateForAudit(entry.errorMessage),
  };
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
