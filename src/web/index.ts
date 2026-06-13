import express, { NextFunction, Request, Response, Router } from "express";
import { Client } from "discord.js";
import logger from "../utils/logger.js";
import { env, getEnv } from "../config/env.js";
import { WebSessionService } from "../services/web-session-service.js";
import { ensureCsrfCookie, requireCsrf } from "./csrf.js";
import { respondFlashError } from "./http-flash.js";
import { createRateLimiter } from "./rate-limit.js";
import {
  AuthenticatedRequest,
  clearSessionCookie,
  createSessionMiddleware,
  writeSessionCookie,
} from "./session.js";
import { renderConsent, renderInvalidLink, renderSignedOut } from "./views.js";
import { createReadOnlyRouter } from "./read-only-routes.js";
import { createWriteRouter } from "./write-routes.js";
import { createUserRouter, SelfScopeError } from "./user-routes.js";

/**
 * Build the WebUI router. Caller mounts this at /admin on the existing
 * Express server. Nothing in this module runs unless WEBUI_ENABLED=true,
 * which is enforced by the caller in src/index.ts.
 */
export function createWebRouter(client: Client): Router {
  const router = Router();
  const sessionService = WebSessionService.getInstance();

  // 256kb covers a 2000-char message + 6000-char embed + CSRF/cron/etc.
  // with comfortable headroom, plus YAML import payloads from the settings
  // page (a full config dump is well under 64kb but power-users may paste
  // larger files with comments and surrounding context).
  router.use(express.urlencoded({ extended: false, limit: "256kb" }));
  router.use(ensureCsrfCookie);

  const redeemLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 10,
    keyName: "redeem",
  });
  const finishLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 30,
    keyName: "finish",
  });

  const requireSession = createSessionMiddleware(client);

  // GET only validates the token (peek) so server-side link previewers
  // like Discordbot/Slackbot can't burn the single-use token before the
  // admin clicks. The actual consume happens on POST below.
  router.get(
    "/s/:token",
    redeemLimiter,
    async (req: Request, res: Response): Promise<void> => {
      try {
        const token = String(req.params.token || "");
        const peeked = await sessionService.peek(token);
        if (!peeked) {
          res.status(404).type("text/html").send(renderInvalidLink());
          return;
        }
        res.status(200).type("text/html").send(renderConsent({ token }));
      } catch (err) {
        logger.error("Error peeking web session token", err);
        res.status(500).type("text/plain").send("Internal Server Error");
      }
    },
  );

  // POST consumes the token, marks it used, writes the session cookie,
  // and redirects into the admin app.
  //
  // No CSRF check here: the URL-bound token IS the credential, exactly
  // like an OAuth authorization-code redemption. An attacker who has the
  // token can already consume it directly; an attacker without it can't
  // construct a meaningful POST (path won't match any session). The
  // attacker also has no pre-existing session at this point to leverage.
  // CSRF on /finish and write routes still applies because those run
  // against an already-authenticated cookie.
  router.post(
    "/s/:token",
    redeemLimiter,
    async (req: Request, res: Response): Promise<void> => {
      try {
        const token = String(req.params.token || "");
        const redeemed = await sessionService.redeem(token);
        if (!redeemed) {
          res.status(404).type("text/html").send(renderInvalidLink());
          return;
        }
        writeSessionCookie(res, {
          sid: redeemed.sessionId,
          uid: redeemed.discordUserId,
          gid: redeemed.guildId,
          rol: redeemed.role,
          iat: Date.now(),
          act: Date.now(),
        });
        // Role-based landing: admins drop on the admin panel they're
        // used to; user-role sessions don't have admin access at all,
        // so we route them to their own `/me` surface (#481). An admin
        // can hop to `/me` afterwards via the in-page header link.
        const dest = redeemed.role === "admin" ? "/admin/" : "/me/";
        res.redirect(302, dest);
      } catch (err) {
        logger.error("Error redeeming web session token", err);
        res.status(500).type("text/plain").send("Internal Server Error");
      }
    },
  );

  router.post(
    "/finish",
    finishLimiter,
    requireCsrf,
    requireSession,
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const ctx = req.webSession;
      if (ctx) {
        await sessionService.revokeSession(ctx.sessionId);
      }
      clearSessionCookie(res);
      res.status(200).type("text/html").send(renderSignedOut());
    },
  );

  // State-changing handlers (issue #383) for announcements + polls.
  // Mounted before the read-only router so a POST to a write path doesn't
  // first run the read-only middleware's session refresh; CSRF is checked
  // inside the write router. Same-shape paths (POST vs. GET) avoid
  // ordering ambiguity, but we keep the explicit precedence.
  router.use(createWriteRouter(client, requireSession));

  // Read-only admin pages (Dashboard, Bootstrap, Settings, Permissions,
  // Announcements, Polls, Reaction Roles, Notices, Voice Channels, Database).
  // Mounted *after* /finish so a POST to /finish hits requireCsrf first;
  // otherwise this router's `requireSession` would refresh the session
  // cookie and re-hit Mongo even on requests that the CSRF check would
  // ultimately reject.
  router.use(createReadOnlyRouter(client, requireSession));

  router.use(
    (err: unknown, req: Request, res: Response, next: NextFunction): void => {
      logger.error("WebUI router error", err);
      if (res.headersSent) {
        next(err);
        return;
      }
      // Surface a sanitized, status-aware error so AJAX callers (e.g. the
      // Settings per-section save) get a JSON `{type:'err',text}` instead of
      // an HTML 500 the client can't parse (issue #612). We deliberately do
      // not echo `err.message` — only a friendly reason keyed off the HTTP
      // status — so DB/validation/internal details never leak to the admin.
      const status = webErrorStatus(err);
      respondFlashError(req, res, status, webErrorText(status));
    },
  );

  return router;
}

/**
 * Best-effort HTTP status for a thrown WebUI error. Body-parser failures
 * (e.g. payload-too-large) carry `status`/`statusCode`; anything else is an
 * unhandled server error → 500.
 */
export function webErrorStatus(err: unknown): number {
  const e = err as { status?: unknown; statusCode?: unknown } | null;
  const raw = e?.statusCode ?? e?.status;
  if (typeof raw === "number" && raw >= 400 && raw <= 599) return raw;
  return 500;
}

/**
 * Sanitized, user-facing reason keyed off the HTTP status (no internals).
 * The text is intentionally generic ("request"/"action") rather than
 * save-specific: this handler covers every WebUI route — GET pages and POST
 * actions alike — not just the Settings save.
 */
export function webErrorText(status: number): string {
  if (status === 413) {
    return "The submitted data was too large.";
  }
  if (status === 400) {
    return "The request was malformed.";
  }
  if (status >= 400 && status < 500) {
    return `Request rejected (${status}).`;
  }
  return "An unexpected server error occurred. Please try again.";
}

/**
 * Build the user self-service router for `/me/*` (#481).
 *
 * Lives on the same Express server as `createWebRouter` and shares the
 * same session cookie (path `/`, set by the magic-link redemption in
 * `/admin/s/:token`). Mounted at `/me` in `src/index.ts` so user-role
 * AND admin-role sessions can both reach it — admins use it to manage
 * their own preferences without giving up the admin panel.
 */
export function createUserWebRouter(client: Client): Router {
  const router = Router();

  router.use(express.urlencoded({ extended: false, limit: "256kb" }));
  router.use(ensureCsrfCookie);

  const requireSession = createSessionMiddleware(client);

  router.use(createUserRouter(client, requireSession));

  router.use(userWebErrorHandler);

  return router;
}

/**
 * Express error handler for the `/me/*` surface. Translates
 * `SelfScopeError` into the documented 403 HTML page and lets every
 * other error fall through to a generic 500 with logging. Exported
 * so the branch can be unit-tested without spinning up an HTTP server
 * (Express only dispatches errors to a router's error middleware when
 * the error originates from within that router's stack, which makes
 * a black-box HTTP test of just the error handler awkward).
 */
export function userWebErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Self-scope violations are a forbidden-access condition, not a
  // bug — render the documented 403 instead of collapsing them into
  // a generic 500. No real `/me/*` handler depends on this today
  // (the v1 index page reads only the session's own ids), but #482
  // /#484 will, so the branch lands with the helper.
  if (err instanceof SelfScopeError) {
    logger.warn("Self-scope violation on /me/*", err.message);
    if (res.headersSent) {
      next(err);
      return;
    }
    res
      .status(403)
      .type("text/html")
      .send(
        `<!doctype html><html><head><meta charset="utf-8"><title>Forbidden</title></head>` +
          `<body style="font-family:system-ui,sans-serif;padding:2rem;max-width:32rem;margin:0 auto;">` +
          `<h1>Forbidden</h1>` +
          `<p>That request targeted another user's data. The user self-service ` +
          `surface only lets you view and change your own. Head back to ` +
          `<a href="/me/">/me</a>.</p>` +
          `</body></html>`,
      );
    return;
  }
  logger.error("UserUI router error", err);
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(500).type("text/plain").send("Internal Server Error");
}

export function isWebUIEnabled(): boolean {
  return env.webui.enabled;
}

/**
 * Minimum length we accept for WEBUI_SESSION_SECRET, in bytes. 32 bytes
 * (256 bits) matches the documented `openssl rand -base64 32` and the
 * HMAC-SHA256 key size used by WebSessionService.hashToken(). This is a
 * length floor only — it cannot measure how random the value is, so
 * operators are still expected to generate it from a CSPRNG.
 */
export const MIN_SESSION_SECRET_BYTES = 32;

/**
 * Validate the WEBUI_* env vars required for an enabled WebUI. Returns a
 * list of human-readable error strings (empty when satisfied) covering
 * both missing keys and a too-short session secret.
 *
 * The session-secret check requires at least MIN_SESSION_SECRET_BYTES raw
 * bytes, which a `openssl rand -base64 32` value (44 chars) or any long
 * passphrase clears. It is a length guard only and makes no claim about
 * the value's randomness.
 */
export function validateWebUIEnvVars(): string[] {
  const errors: string[] = [];
  const required = ["WEBUI_BASE_URL", "WEBUI_SESSION_SECRET"];
  for (const k of required) {
    if (!getEnv(k)) errors.push(`${k} is missing`);
  }

  const secret = getEnv("WEBUI_SESSION_SECRET") ?? "";
  if (secret && Buffer.byteLength(secret) < MIN_SESSION_SECRET_BYTES) {
    errors.push(
      `WEBUI_SESSION_SECRET must be at least ${MIN_SESSION_SECRET_BYTES} bytes ` +
        `(generate with: openssl rand -base64 32)`,
    );
  }

  return errors;
}
