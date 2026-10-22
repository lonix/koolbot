/**
 * "Your events" for event hosts (#1319): `GET /me/events`.
 *
 * Mounted by `createUserRouter` under `/events`, AFTER the host-scope guard
 * (`requireScopeMiddleware("host")`, resolved from role groups on every
 * request) and after the more specific routers (New event, presets, host
 * panel), so it only ever answers the list itself. Read-only: the list is
 * filtered on the session's guild and user, never on anything in the query.
 * Cancel is the host panel's own gated action (`/me/events/:id/host/cancel`).
 */

import { Router } from "express";
import logger from "../../utils/logger.js";
import { ConfigService } from "../../services/config-service.js";
import { formatEventWhen } from "../../services/event-service.js";
import { listHostEvents, type HostEventRow } from "../event-host.js";
import {
  renderHostEventsPage,
  type HostEventListRow,
} from "../me-events-page.js";
import { getDisplayedRemainingMs } from "../admin-layout.js";
import { readMeSurfaceFlags } from "../me-surfaces.js";
import { renderUserPage } from "../user-layout.js";
import { readSignedFlash } from "../http-flash.js";
import { requireCsrf } from "../csrf.js";
import type { AuthenticatedRequest } from "../session.js";

function toListRow(e: HostEventRow): HostEventListRow {
  return {
    id: e.id,
    title: e.title,
    when: formatEventWhen(e),
    state: e.state,
    durationMinutes: e.durationMinutes,
    editable: e.editable,
    recurring: e.recurring,
  };
}

export function createMeEventsRouter(): Router {
  const router = Router();
  // Issues the token the Cancel forms carry; the only methods here are reads.
  router.use(requireCsrf);

  router.get("/", (req, res, next) => {
    const session = (req as AuthenticatedRequest).webSession;
    if (!session) {
      res.status(500).type("text/plain").send("session missing");
      return;
    }
    const csrfToken = (req as { csrfToken?: string }).csrfToken ?? "";
    void (async (): Promise<void> => {
      const [eventsEnabled, flags, found] = await Promise.all([
        ConfigService.getInstance().getBooleanStrict("events.enabled", false),
        readMeSurfaceFlags(),
        listHostEvents(session.guildId, session.discordUserId).catch(
          (err: unknown) => {
            logger.warn("Could not list the host's events:", err);
            return null;
          },
        ),
      ]);
      res
        .set("Cache-Control", "no-store")
        .type("text/html")
        .send(
          renderUserPage({
            title: "Your events",
            active: "/me/events",
            body: renderHostEventsPage({
              csrfToken,
              eventsEnabled,
              events: found && {
                live: found.live.map(toListRow),
                upcoming: found.upcoming.map(toListRow),
                past: found.past.map(toListRow),
              },
            }),
            csrfToken,
            remainingMs: getDisplayedRemainingMs(session),
            isAdmin: session.role === "admin",
            flash: readSignedFlash(req.query),
            ...flags,
          }),
        );
    })().catch(next);
  });

  return router;
}
