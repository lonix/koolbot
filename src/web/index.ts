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

/**
 * Build the WebUI router. Caller mounts this at /admin on the existing
 * Express server. Nothing in this module runs unless WEBUI_ENABLED=true,
 * which is enforced by the caller in src/index.ts.
 */
export function createWebRouter(client: Client): Router {
  const router = Router();
  const sessionService = WebSessionService.getInstance();

  router.use(express.urlencoded({ extended: false, limit: "16kb" }));
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

  // Read-only admin pages (Dashboard, Bootstrap, Settings, Permissions,
  // Announcements, Polls, Reaction Roles, Notices, Voice Channels, Database)
  // are registered by the read-only router. It re-registers `requireSession`
  // internally; safe to mount before the auth/finish endpoints below since
  // they live at distinct paths.
  router.use(createReadOnlyRouter(client, requireSession));

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
