import { Buffer } from "buffer";
import { Client } from "discord.js";
import { Request, RequestHandler, Response, NextFunction } from "express";
import logger from "../utils/logger.js";
import { PermissionsService } from "../services/permissions-service.js";
import { WebSessionService } from "../services/web-session-service.js";
import type { IWebSession } from "../models/web-session.js";
import {
  clearCookie,
  parseCookies,
  setCookie,
  signValue,
  verifySignedValue,
} from "./cookies.js";
import { shouldUseSecureCookies } from "./csrf.js";

export const SESSION_COOKIE = "koolbot_session";
export const SESSION_COOKIE_PATH = "/admin";

const DEFAULT_INACTIVITY_MINUTES = 30;

export interface WebSessionContext {
  sessionId: string;
  discordUserId: string;
  guildId: string;
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
  iat: number;
  act: number;
}

function getSecret(): string {
  const secret = process.env.WEBUI_SESSION_SECRET;
  if (!secret) {
    throw new Error("WEBUI_SESSION_SECRET not configured");
  }
  return secret;
}

function getInactivityMinutes(): number {
  const raw = process.env.WEBUI_INACTIVITY_TIMEOUT_MINUTES;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_INACTIVITY_MINUTES;
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
    maxAge: getInactivityMinutes() * 60 * 1000,
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
  const inactivityMs = getInactivityMinutes() * 60 * 1000;
  if (now - payload.act > inactivityMs) return null;
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

    const refreshed: CookiePayload = { ...payload, act: now };
    writeSessionCookie(res, refreshed);

    req.webSession = {
      sessionId: payload.sid,
      discordUserId: payload.uid,
      guildId: payload.gid,
      scopes: dbSession.scopes,
      lastActivityAt: now,
      expiresAt: dbSession.expiresAt,
    };
    next();
  };
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
      const inactivityMs = getInactivityMinutes() * 60 * 1000;
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
