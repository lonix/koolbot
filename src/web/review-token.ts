import crypto from "node:crypto";
import { Buffer } from "buffer";
import { env } from "../config/env.js";

/**
 * Tamper-proof stamp for a reviewed role deletion (#1184). The review page
 * sends `approvedAt` back in a form, and for a role KoolBot created the plan
 * carries no approval, so the stamp is not part of the plan id. This keyed MAC
 * binds it to the session, the group and the plan id, keyed with the same
 * secret the session and CSRF tokens use. Without it an expired review could
 * be re-submitted with only the timestamp refreshed.
 *
 * Returns null when no secret is configured: callers fail closed.
 */
export function signRoleDeleteReview(
  sessionId: string,
  groupId: string,
  planId: string,
  approvedAt: string,
): string | null {
  const secret = env.webui.sessionSecret;
  if (!secret) return null;
  return crypto
    .createHmac("sha256", secret)
    .update(
      `role-delete-review\0${sessionId}\0${groupId}\0${planId}\0${approvedAt}`,
    )
    .digest("base64url");
}

export function verifyRoleDeleteReview(
  token: string,
  sessionId: string,
  groupId: string,
  planId: string,
  approvedAt: string,
): boolean {
  const expected = signRoleDeleteReview(sessionId, groupId, planId, approvedAt);
  if (!expected) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
