import express, { NextFunction, Request, Response, Router } from "express";
import { Client } from "discord.js";
import logger from "../utils/logger.js";
import { WebSessionService } from "../services/web-session-service.js";
import { ensureCsrfCookie, requireCsrf } from "./csrf.js";
import { createRateLimiter } from "./rate-limit.js";
import {
  AuthenticatedRequest,
  clearSessionCookie,
  createSessionMiddleware,
  writeSessionCookie,
} from "./session.js";
import { renderInvalidLink, renderSignedOut } from "./views.js";
import { createReadOnlyRouter } from "./read-only-routes.js";
import { createWriteRouter } from "./write-routes.js";

/**
 * Build the WebUI router. Caller mounts this at /admin on the existing
 * Express server. Nothing in this module runs unless WEBUI_ENABLED=true,
 * which is enforced by the caller in src/index.ts.
 */
export function createWebRouter(client: Client): Router {
  const router = Router();
  const sessionService = WebSessionService.getInstance();

  // 64kb covers a 2000-char message + 6000-char embed + CSRF/cron/etc.
  // with comfortable headroom for the announcement and poll forms.
  router.use(express.urlencoded({ extended: false, limit: "64kb" }));
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

  router.get(
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
          iat: Date.now(),
          act: Date.now(),
        });
        res.redirect(302, "/admin/");
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
    (err: unknown, _req: Request, res: Response, next: NextFunction): void => {
      logger.error("WebUI router error", err);
      if (res.headersSent) {
        next(err);
        return;
      }
      res.status(500).type("text/plain").send("Internal Server Error");
    },
  );

  return router;
}

export function isWebUIEnabled(): boolean {
  return (process.env.WEBUI_ENABLED || "").toLowerCase() === "true";
}

/**
 * Validate that all WEBUI_* env vars required for an enabled WebUI are
 * present. Returns the list of missing keys (empty when satisfied).
 */
export function getMissingWebUIEnvVars(): string[] {
  const required = ["WEBUI_BASE_URL", "WEBUI_SESSION_SECRET"];
  return required.filter((k) => !process.env[k]);
}
