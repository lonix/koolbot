/**
 * Route handlers for the user self-service surface (#481).
 *
 * Mounted at `/me`. Every handler runs behind `requireSession`, accepts
 * either an `admin`-role or `user`-role session (admins are guild
 * members too — they have their own preferences/Rewind), and enforces
 * self-scope via `assertSelfScope`: a session may only read/write rows
 * keyed by `(session.userId, session.guildId)`. v1 ships a single stub
 * index page; sub-issues #482/#484 add real content.
 */

import {
  Router,
  type NextFunction,
  type Response,
  type RequestHandler,
} from "express";
import { Client } from "discord.js";
import { WebSessionService } from "../services/web-session-service.js";
import { requireCsrf } from "./csrf.js";
import {
  AuthenticatedRequest,
  clearSessionCookie,
  createSessionPingHandler,
  type WebSessionContext,
} from "./session.js";
import { getDisplayedRemainingMs } from "./admin-layout.js";
import { renderUserIndexBody, renderUserPage } from "./user-layout.js";
import { renderSignedOut } from "./views.js";

function asyncHandler(
  fn: (req: AuthenticatedRequest, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next: NextFunction): void => {
    fn(req as AuthenticatedRequest, res).catch(next);
  };
}

function getCsrfToken(req: AuthenticatedRequest): string {
  return (req as AuthenticatedRequest & { csrfToken?: string }).csrfToken ?? "";
}

/**
 * Enforce that the session may only act on rows belonging to itself —
 * both the Discord user id and the guild id must match the session's.
 *
 * Crucially this applies to admin-role sessions too. An admin who
 * lands on `/me/notifications` to manage their own prefs sees their
 * own row; if they ever try to pass `?userId=someone-else` on a write,
 * this helper rejects it. Admins who need to act on another user's
 * data use the admin panel's audit/user tooling, not impersonation on
 * `/me/*`. See #481 acceptance.
 *
 * Returns the validated `(userId, guildId)` pair. Throws `SelfScopeError`
 * on mismatch — handlers wrap their bodies in `asyncHandler` so the
 * thrown error reaches the WebUI error pipeline and renders a 403.
 */
export function assertSelfScope(
  session: WebSessionContext,
  target: { userId: string; guildId: string },
): { userId: string; guildId: string } {
  if (
    target.userId !== session.discordUserId ||
    target.guildId !== session.guildId
  ) {
    throw new SelfScopeError(
      `Session ${session.sessionId} (user=${session.discordUserId} guild=${session.guildId} role=${session.role}) ` +
        `attempted to access user=${target.userId} guild=${target.guildId}`,
    );
  }
  return { userId: session.discordUserId, guildId: session.guildId };
}

export class SelfScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelfScopeError";
  }
}

export function createUserRouter(
  _client: Client,
  requireSession: RequestHandler,
): Router {
  const router = Router();

  // Surface-local session ping so the `/me` banner script never has to
  // reach across to `/admin/session/ping`. Identical handler (the ping
  // is surface-neutral — same cookie, same DB row), just mounted on
  // both routers so a future split of the admin mount can't silently
  // break the countdown on `/me/*`. Mounted BEFORE `requireSession` for
  // the same reason the admin copy is: the ping itself does its own
  // (non-mutating) cookie + DB validation and must NOT bump `act`.
  router.get("/session/ping", createSessionPingHandler());

  router.use(requireSession);

  // ---------- Index ----------
  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const session = req.webSession;
      if (!session) {
        // `requireSession` guarantees this, but the type narrower
        // doesn't know that without an explicit check.
        res.status(500).type("text/plain").send("session missing");
        return;
      }
      res.type("text/html").send(
        renderUserPage({
          title: "Overview",
          active: "/me/",
          body: renderUserIndexBody({
            discordUserId: session.discordUserId,
            guildId: session.guildId,
            isAdmin: session.role === "admin",
          }),
          csrfToken: getCsrfToken(req),
          remainingMs: getDisplayedRemainingMs(session),
          isAdmin: session.role === "admin",
        }),
      );
    }),
  );

  // ---------- Finish (sign out) ----------
  // CSRF-checked, same pattern as `/admin/finish`. The session row is
  // revoked server-side so the cookie cannot be re-used elsewhere.
  router.post(
    "/finish",
    requireCsrf,
    asyncHandler(async (req, res) => {
      const ctx = req.webSession;
      if (ctx) {
        await WebSessionService.getInstance().revokeSession(ctx.sessionId);
      }
      clearSessionCookie(res);
      res.status(200).type("text/html").send(renderSignedOut());
    }),
  );

  return router;
}
