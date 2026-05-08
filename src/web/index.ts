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
import {
  renderBootstrap,
  renderDashboard,
  renderInvalidLink,
  renderSignedOut,
} from "./views.js";

const SECRET_KEYS = new Set([
  "DISCORD_TOKEN",
  "MONGODB_URI",
  "WEBUI_SESSION_SECRET",
]);

const BOOTSTRAP_KEYS = [
  "DISCORD_TOKEN",
  "CLIENT_ID",
  "GUILD_ID",
  "MONGODB_URI",
  "NODE_ENV",
  "DEBUG",
  "WEBUI_ENABLED",
  "WEBUI_BASE_URL",
  "WEBUI_SESSION_SECRET",
  "WEBUI_SESSION_TTL_MINUTES",
  "WEBUI_INACTIVITY_TIMEOUT_MINUTES",
];

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

  router.get(
    "/",
    requireSession,
    (req: AuthenticatedRequest, res: Response): void => {
      const ctx = req.webSession;
      if (!ctx) {
        res.status(401).type("text/plain").send("Unauthorized");
        return;
      }
      const csrfToken =
        (req as Request & { csrfToken?: string }).csrfToken ?? "";
      res.type("text/html").send(
        renderDashboard({
          discordUserId: ctx.discordUserId,
          guildId: ctx.guildId,
          csrfToken,
        }),
      );
    },
  );

  router.get(
    "/bootstrap",
    requireSession,
    (req: AuthenticatedRequest, res: Response): void => {
      const csrfToken =
        (req as Request & { csrfToken?: string }).csrfToken ?? "";
      const rows = BOOTSTRAP_KEYS.map((key) => {
        const raw = process.env[key];
        const present = typeof raw === "string" && raw.length > 0;
        let tail: string | undefined;
        if (present && SECRET_KEYS.has(key) && raw) {
          tail = raw.slice(-4);
        } else if (present && raw && !SECRET_KEYS.has(key)) {
          tail = raw.length > 32 ? `${raw.slice(0, 28)}…` : raw;
        }
        return { key, present, tail };
      });
      res.type("text/html").send(renderBootstrap({ rows, csrfToken }));
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
