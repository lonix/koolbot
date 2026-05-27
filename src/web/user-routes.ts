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
import logger from "../utils/logger.js";
import { WebSessionService } from "../services/web-session-service.js";
import {
  NOTIFICATION_PREF_KEYS,
  UserNotificationPrefsService,
  type NotificationPrefKey,
  type NotificationPrefs,
} from "../services/user-notification-prefs-service.js";
import { requireCsrf } from "./csrf.js";
import {
  AuthenticatedRequest,
  clearSessionCookie,
  createSessionPingHandler,
  type WebSessionContext,
} from "./session.js";
import { getDisplayedRemainingMs } from "./admin-layout.js";
import {
  renderUserIndexBody,
  renderUserNotificationsBody,
  renderUserPage,
  type UserFlashMessage,
} from "./user-layout.js";
import { recordAudit } from "./audit.js";
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

function readCheckbox(value: unknown): boolean {
  // The page posts "true" when checked; absent → unchecked.
  if (typeof value === "string") return value === "true" || value === "on";
  return value === true;
}

const NOTIFICATION_FLASH_MAX = 300;

function flashUrl(path: string, flash: UserFlashMessage): string {
  const text =
    flash.text.length > NOTIFICATION_FLASH_MAX
      ? `${flash.text.slice(0, NOTIFICATION_FLASH_MAX - 1)}…`
      : flash.text;
  const qs = new globalThis.URLSearchParams({
    flash: flash.type,
    msg: text,
  }).toString();
  return `${path}?${qs}`;
}

function readFlashFromQuery(
  req: AuthenticatedRequest,
): UserFlashMessage | null {
  const type = String(req.query.flash ?? "");
  const text = String(req.query.msg ?? "");
  if (!text) return null;
  if (type !== "ok" && type !== "warn" && type !== "err") return null;
  return {
    type,
    text:
      text.length > NOTIFICATION_FLASH_MAX
        ? `${text.slice(0, NOTIFICATION_FLASH_MAX - 1)}…`
        : text,
  };
}

interface NotificationRowDef {
  key: NotificationPrefKey;
  label: string;
  description: string;
  comingSoon?: string;
}

const NOTIFICATION_ROW_DEFS: readonly NotificationRowDef[] = [
  {
    key: "achievements",
    label: "Achievement DMs",
    description:
      "Direct messages from Koolbot when you earn a new accolade or badge.",
  },
  {
    key: "digest",
    label: "Weekly digest",
    description:
      "Once-a-week DM summarising your activity and the server's highlights.",
    comingSoon: "Toggle works today; the matching DM lands in #483.",
  },
  {
    key: "rewind",
    label: "Year-in-review (Rewind)",
    description: "End-of-year personal recap of your activity on this server.",
    comingSoon: "Toggle works today; the matching DM lands in #484.",
  },
];

function buildNotificationRows(prefs: NotificationPrefs): Array<{
  key: string;
  label: string;
  description: string;
  enabled: boolean;
  comingSoon?: string;
}> {
  return NOTIFICATION_ROW_DEFS.map((def) => ({
    key: def.key,
    label: def.label,
    description: def.description,
    enabled: prefs[def.key],
    comingSoon: def.comingSoon,
  }));
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

  // ---------- Notifications (#482) ----------
  router.get(
    "/notifications",
    asyncHandler(async (req, res) => {
      const session = req.webSession;
      if (!session) {
        res.status(500).type("text/plain").send("session missing");
        return;
      }
      const { userId, guildId } = assertSelfScope(session, {
        userId: session.discordUserId,
        guildId: session.guildId,
      });
      const prefs = await UserNotificationPrefsService.getInstance().getPrefs(
        userId,
        guildId,
      );
      const flash = readFlashFromQuery(req);
      res.type("text/html").send(
        renderUserPage({
          title: "Notifications",
          active: "/me/notifications",
          body: renderUserNotificationsBody({
            csrfToken: getCsrfToken(req),
            rows: buildNotificationRows(prefs),
          }),
          csrfToken: getCsrfToken(req),
          remainingMs: getDisplayedRemainingMs(session),
          isAdmin: session.role === "admin",
          flash,
        }),
      );
    }),
  );

  router.post(
    "/notifications",
    requireCsrf,
    asyncHandler(async (req, res) => {
      const session = req.webSession;
      if (!session) {
        res.status(500).type("text/plain").send("session missing");
        return;
      }
      const { userId, guildId } = assertSelfScope(session, {
        userId: session.discordUserId,
        guildId: session.guildId,
      });

      const body = (req.body as Record<string, unknown> | undefined) ?? {};
      const service = UserNotificationPrefsService.getInstance();
      const before = await service.getPrefs(userId, guildId);

      // Per-row toggle: the page submits a hidden `submitted_<key>` flag
      // alongside each checkbox, so we can distinguish "explicitly off"
      // (flag present, checkbox absent) from "row not on this page"
      // (flag absent — leave the stored value alone). Without the
      // hidden flag a single missing checkbox would silently default to
      // "false" on every save and quietly reset opt-ins on unrelated
      // rows that future sub-issues append.
      const patch: Partial<NotificationPrefs> = {};
      for (const key of NOTIFICATION_PREF_KEYS) {
        const submitted = body[`submitted_${key}`];
        if (typeof submitted !== "string" || submitted.length === 0) continue;
        patch[key] = readCheckbox(body[key]);
      }

      let result: "success" | "failure" = "success";
      let errorMessage: string | null = null;
      let after: NotificationPrefs = before;
      try {
        after = await service.setPrefs(userId, guildId, patch);
      } catch (err) {
        result = "failure";
        errorMessage = err instanceof Error ? err.message : String(err);
        logger.error("Failed to save notification prefs", err);
      }

      // Diff only the keys that actually changed so the audit row stays
      // small and the row count grows linearly with deliberate toggles.
      const changed = NOTIFICATION_PREF_KEYS.reduce<Record<string, unknown>>(
        (acc, key) => {
          if (before[key] !== after[key]) {
            acc[key] = { before: before[key], after: after[key] };
          }
          return acc;
        },
        {},
      );

      await recordAudit(session, {
        action: "user.notifications.set",
        targetId: userId,
        details:
          result === "success"
            ? { changed, submitted: Object.keys(patch) }
            : { submitted: Object.keys(patch) },
        result,
        errorMessage,
      });

      const flash: UserFlashMessage =
        result === "failure"
          ? {
              type: "err",
              text: `Could not save your notification preferences: ${errorMessage ?? "unknown error"}.`,
            }
          : Object.keys(changed).length === 0
            ? { type: "ok", text: "No changes — preferences already match." }
            : {
                type: "ok",
                text: `Saved ${Object.keys(changed).length} preference change${Object.keys(changed).length === 1 ? "" : "s"}.`,
              };
      res.redirect(303, flashUrl("/me/notifications", flash));
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
