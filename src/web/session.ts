import { Buffer } from "buffer";
import { Client } from "discord.js";
import { Request, RequestHandler, Response, NextFunction } from "express";
import logger from "../utils/logger.js";
import { PermissionsService } from "../services/permissions-service.js";
import { WebSessionService } from "../services/web-session-service.js";
import type { IWebSession, WebSessionRole } from "../models/web-session.js";
import {
  clearCookie,
  parseCookies,
  setCookie,
  signValue,
  verifySignedValue,
} from "./cookies.js";
import { shouldUseSecureCookies } from "./csrf.js";
import { env } from "../config/env.js";

export const SESSION_COOKIE = "koolbot_session";
/**
 * Path on which the session cookie is set. Broadened from the original
 * `/admin` to `/` in #481 so the same redeemed session covers both
 * `/admin/*` (admin panel) and `/me/*` (user self-service). The cookie
 * is still HttpOnly + HMAC-signed; broadening the path only makes the
 * browser send it on more URLs of the same origin, which is exactly
 * what we want now that one redemption authorises both surfaces.
 */
export const SESSION_COOKIE_PATH = "/";

const DEFAULT_INACTIVITY_MINUTES = 30;

export interface WebSessionContext {
  sessionId: string;
  discordUserId: string;
  guildId: string;
  /**
   * Role of the redeemed session, sourced from the DB row on every
   * request. Authoritative — handlers that need a role check should
   * read this rather than re-decoding the cookie.
   */
  role: WebSessionRole;
  scopes: string[];
  lastActivityAt: number;
  /**
   * Server-side hard cap for the session, mirrored from
   * `WebSession.expiresAt`. Used by the banner countdown so the rendered
   * remaining time respects the TTL ceiling, not just the inactivity window.
   */
  expiresAt: Date;
}

export type AuthenticatedRequest = Request & { webSession?: WebSessionContext };

interface CookiePayload {
  sid: string;
  uid: string;
  gid: string;
  /**
   * Role claim. Optional in the parsed payload so legacy cookies issued
   * before #481 (which had no role field) continue to deserialise — we
   * cross-check against the DB row in `loadValidSession`, which is the
   * authoritative source. New cookies always carry a `rol`.
   */
  rol?: WebSessionRole;
  iat: number;
  act: number;
}

function getSecret(): string {
  const secret = env.webui.sessionSecret;
  if (!secret) {
    throw new Error("WEBUI_SESSION_SECRET not configured");
  }
  return secret;
}

function getInactivityMinutes(): number {
  const raw = env.webui.inactivityTimeoutMinutes;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_INACTIVITY_MINUTES;
}

/**
 * Inactivity sliding-window length in ms. Single source of truth for
 * both the server (cookie expiry / middleware checks) and the renderer
 * (banner `data-inactivity-ms` attribute) so the two can't drift on
 * what counts as "the full window".
 */
export function getInactivityWindowMs(): number {
  return getInactivityMinutes() * 60 * 1000;
}

export function writeSessionCookie(
  res: Response,
  payload: CookiePayload,
): void {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signed = signValue(encoded, getSecret());
  setCookie(res, SESSION_COOKIE, signed, {
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookies(),
    path: SESSION_COOKIE_PATH,
    maxAge: getInactivityWindowMs(),
  });
}

export function clearSessionCookie(res: Response): void {
  clearCookie(res, SESSION_COOKIE, { path: SESSION_COOKIE_PATH });
}

/**
 * Cookie + DB validation shared by `createSessionMiddleware` and the
 * read-only `/session/ping` handler. Enforces the sliding inactivity
 * window against `payload.act` and the server-side hard cap on the DB
 * row. Does NOT touch the cookie or run any permission revalidation —
 * callers layer those on as needed.
 */
async function loadValidSession(
  payload: CookiePayload,
  now: number,
): Promise<IWebSession | null> {
  if (now - payload.act > getInactivityWindowMs()) return null;
  const dbSession = await WebSessionService.getInstance().findById(payload.sid);
  if (
    !dbSession ||
    dbSession.revokedAt ||
    dbSession.expiresAt.getTime() <= now ||
    dbSession.discordUserId !== payload.uid ||
    dbSession.guildId !== payload.gid
  ) {
    return null;
  }
  return dbSession;
}

function readSessionCookie(req: Request): CookiePayload | null {
  const cookies = parseCookies(req);
  const raw = cookies.get(SESSION_COOKIE);
  if (!raw) return null;
  let secret: string;
  try {
    secret = getSecret();
  } catch {
    return null;
  }
  const verified = verifySignedValue(raw, secret);
  if (!verified) return null;
  try {
    const json = Buffer.from(verified, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as CookiePayload;
    if (
      typeof parsed.sid !== "string" ||
      typeof parsed.uid !== "string" ||
      typeof parsed.gid !== "string" ||
      typeof parsed.iat !== "number" ||
      typeof parsed.act !== "number"
    ) {
      return null;
    }
    // `rol` is optional for legacy cookies issued before #481; if present
    // it must be one of the two known roles, else we refuse to parse so a
    // mangled value can't sneak through.
    if (
      parsed.rol !== undefined &&
      parsed.rol !== "admin" &&
      parsed.rol !== "user"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Session middleware: verifies the signed cookie, enforces the sliding
 * inactivity window, hard-caps the session to its server-side expiresAt,
 * and re-checks the user's command permission on every request via
 * PermissionsService (admins always pass; otherwise the configured roles
 * for "config" must allow the user).
 */
export function createSessionMiddleware(
  client: Client,
): (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => Promise<void> {
  return async function requireSession(req, res, next): Promise<void> {
    const payload = readSessionCookie(req);
    if (!payload) {
      respondUnauthorized(res);
      return;
    }

    const now = Date.now();
    const dbSession = await loadValidSession(payload, now);
    if (!dbSession) {
      clearSessionCookie(res);
      respondUnauthorized(res);
      return;
    }
    const sessionService = WebSessionService.getInstance();

    try {
      const permissions = PermissionsService.getInstance(client);
      // checkCommandPermission already short-circuits to true for
      // Administrators and to true when no role gating is configured for
      // the command, so we can rely on its boolean directly.
      const allowed = await permissions.checkCommandPermission(
        payload.uid,
        payload.gid,
        "config",
      );
      if (!allowed) {
        clearSessionCookie(res);
        await sessionService.revokeSession(payload.sid);
        respondUnauthorized(res);
        return;
      }
    } catch (err) {
      logger.warn("Failed to revalidate web session permissions", err);
      clearSessionCookie(res);
      respondUnauthorized(res);
      return;
    }

    // DB role is authoritative. Refresh the cookie's role claim so a
    // legacy (pre-#481) cookie picks up its real role on the next hop,
    // and so a stale `rol` (if someone ever rolled a session's role
    // forward by DB hand-edit) heals itself.
    const role = normalizeSessionRole(dbSession.role);
    const refreshed: CookiePayload = { ...payload, rol: role, act: now };
    writeSessionCookie(res, refreshed);

    req.webSession = {
      sessionId: payload.sid,
      discordUserId: payload.uid,
      guildId: payload.gid,
      role,
      scopes: dbSession.scopes,
      lastActivityAt: now,
      expiresAt: dbSession.expiresAt,
    };
    next();
  };
}

/**
 * Express middleware that rejects any request whose redeemed session is
 * not `role === "admin"`. Mount AFTER `createSessionMiddleware` so the
 * session is already loaded onto `req.webSession`. A user-role session
 * hitting this middleware gets a 403 page that explains the surface is
 * admin-only and points them at their own `/me` surface; this matches
 * the acceptance criterion in #481.
 */
export function requireAdminRoleMiddleware(): (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => void {
  return function requireAdminRole(req, res, next): void {
    if (!req.webSession) {
      // Defensive: caller forgot to mount `createSessionMiddleware` first.
      // Treat as unauthenticated, not forbidden.
      respondUnauthorized(res);
      return;
    }
    if (req.webSession.role !== "admin") {
      res
        .status(403)
        .type("text/html")
        .send(
          `<!doctype html><html><head><meta charset="utf-8"><title>Forbidden</title></head>` +
            `<body style="font-family:system-ui,sans-serif;padding:2rem;max-width:32rem;margin:0 auto;">` +
            `<h1>Forbidden</h1>` +
            `<p>This page is part of the admin panel and your sign-in link does not authorise it. ` +
            `Visit <a href="/me/">/me</a> for your own preferences, or ask an Administrator to ` +
            `re-issue your link via <code>/config</code>.</p>` +
            `</body></html>`,
        );
      return;
    }
    next();
  };
}

function normalizeSessionRole(raw: unknown): WebSessionRole {
  return raw === "user" ? "user" : "admin";
}

/**
 * Read-only status handler for `GET /admin/session/ping` (#435).
 *
 * The banner polls this so an admin who has been working on a single
 * page for a few minutes sees a fresh countdown rather than watching
 * their (server-side genuinely fresh) session tick to zero.
 *
 * Crucial property: this handler must NOT count as activity. It does
 * not call `writeSessionCookie`, so `payload.act` is never bumped and
 * the inactivity sliding window keeps advancing for a user who is only
 * polling and not making real requests. Validation otherwise mirrors
 * `createSessionMiddleware`: cookie present, inactivity window OK, DB
 * session live. Permission revalidation is intentionally omitted — the
 * next real admin request will hit the middleware and revoke if needed.
 */
export function createSessionPingHandler(): RequestHandler {
  return async function sessionPing(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      // Per-session payload — must never be cached by browsers or
      // intermediary proxies, else a 200 could be served across users.
      // Applies to both the 200 and 401 paths below.
      res.setHeader("Cache-Control", "no-store");
      const payload = readSessionCookie(req);
      if (!payload) {
        respondPingUnauthorized(res);
        return;
      }
      const now = Date.now();
      const dbSession = await loadValidSession(payload, now);
      if (!dbSession) {
        respondPingUnauthorized(res);
        return;
      }
      const inactivityMs = getInactivityWindowMs();
      const inactivityRemaining = Math.max(0, payload.act + inactivityMs - now);
      const hardCapRemaining = Math.max(0, dbSession.expiresAt.getTime() - now);
      const remainingMs = Math.min(inactivityRemaining, hardCapRemaining);
      res.status(200).json({
        remainingMs,
        expiresAt: dbSession.expiresAt.toISOString(),
      });
    } catch (err) {
      next(err);
    }
  };
}

function respondPingUnauthorized(res: Response): void {
  res.status(401).json({ error: "unauthorized" });
}

function respondUnauthorized(res: Response): void {
  res
    .status(401)
    .type("text/html")
    .send(
      `<!doctype html><html><head><meta charset="utf-8"><title>Sign in required</title></head>` +
        `<body style="font-family:system-ui,sans-serif;padding:2rem;max-width:32rem;margin:0 auto;">` +
        `<h1>Sign in required</h1>` +
        `<p>Run <code>/config</code> in Discord to receive a fresh sign-in link.</p>` +
        `</body></html>`,
    );
}
