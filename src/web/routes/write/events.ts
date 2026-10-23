/**
 * Events (#708) — create/update/delete.
 *
 * Mounted by `createWriteRouter` (src/web/write-routes.ts) behind
 * `requireSession`, the admin-role check and `requireCsrf` — the shared
 * middleware lives at that single mount point, not here.
 */

import { Router } from "express";
import { Client } from "discord.js";
import { EventService, isRecurring } from "../../../services/event-service.js";
import {
  createdFlash,
  createEventFromForm,
  redirectToHostPanel,
} from "../../event-create.js";
import {
  removeEventCover,
  setEventCover,
} from "../../../services/event-cover.js";
import {
  COVER_TOO_LARGE_TEXT,
  coverUploadBody,
} from "../../event-cover-upload.js";
import { summariseEnd } from "../../../services/event-teardown.js";
import { END_CONFIRM_FIELD } from "../../event-end-view.js";
import { recordAudit } from "../../audit.js";
import {
  flashRedirect,
  getString,
  requireSessionContext,
  asyncHandler,
  respondSectionFlash,
} from "./helpers.js";

export function createEventsRouter(client: Client): Router {
  const router = Router();

  // ============================================================
  // Events (#708)
  // ============================================================

  router.post(
    "/events/create",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      // One pipeline with the host's form (`/me/events/new`, #1305): same
      // validation, Groups handling and audit. Admins may also repeat events.
      const result = await createEventFromForm(client, session, req.body, {
        allowRecurrence: true,
        via: "admin",
      });
      if (!result.ok) {
        flashRedirect(res, "/admin/events", {
          type: "err",
          text: result.error,
        });
        return;
      }
      const flash = createdFlash(result);
      // "Now" lands on the host panel, where the event is run from.
      if (result.impromptu) {
        redirectToHostPanel(res, String(result.event._id), flash);
        return;
      }
      flashRedirect(res, "/admin/events", flash);
    }),
  );

  // ============================================================
  // Cover image (#1181)
  // ============================================================

  // The upload body is parsed by the shared `coverUploadBody` (also used by the
  // host's edit page), here inside the router: only after the session,
  // admin-role and CSRF checks have passed, and only for this route.
  router.post(
    "/events/:id/cover",
    coverUploadBody((req, res) => {
      respondSectionFlash(
        req,
        res,
        { type: "err", text: COVER_TOO_LARGE_TEXT },
        "/admin/events",
        [],
        true,
      );
    }),
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const service = EventService.getInstance(client);
      const event = await service.getEvent(id);
      const flash = (type: "ok" | "err", text: string): void =>
        respondSectionFlash(
          req,
          res,
          { type, text },
          "/admin/events",
          [],
          true,
        );
      if (!event || event.guildId !== session.guildId) {
        flash("err", `Event ${id} not found.`);
        return;
      }
      const body: unknown = req.body;
      const data = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
      const result = await setEventCover(event, data);
      await recordAudit(session, {
        action: "event.cover-set",
        targetId: id,
        details: result.ok
          ? { mime: result.mime, bytes: result.bytes, hash: result.hash }
          : { bytes: data.length },
        result: result.ok ? "success" : "failure",
        errorMessage: result.ok ? null : result.error,
      });
      flash(
        result.ok ? "ok" : "err",
        result.ok
          ? `Cover image saved${event.seriesId ? " for the whole series" : ""}. It reaches the Discord event within a minute.`
          : `Cover image rejected: ${result.error}`,
      );
    }),
  );

  router.post(
    "/events/:id/cover/remove",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const service = EventService.getInstance(client);
      const event = await service.getEvent(id);
      if (!event || event.guildId !== session.guildId) {
        await recordAudit(session, {
          action: "event.cover-remove",
          targetId: id,
          result: "failure",
          errorMessage: "not found or wrong guild",
        });
        flashRedirect(res, "/admin/events", {
          type: "err",
          text: `Event ${id} not found.`,
        });
        return;
      }
      const result = await removeEventCover(event);
      await recordAudit(session, {
        action: "event.cover-remove",
        targetId: id,
        result: result.ok ? "success" : "failure",
        errorMessage: result.ok ? null : result.error,
      });
      flashRedirect(res, "/admin/events", {
        type: result.ok ? "ok" : "err",
        text: result.ok
          ? `Cover image removed${event.seriesId ? " for the whole series" : ""}. It is cleared on the Discord event within a minute.`
          : `Could not remove the cover: ${result.error}`,
      });
    }),
  );

  router.post(
    "/events/:id/cancel",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const series = getString(req, "scope") === "series";
      const service = EventService.getInstance(client);
      // The outcome is what the service reports: `cancelled` only when a cancel
      // was really made (an event that ended, or started ending, meanwhile is
      // not).
      let event: { state?: string } | null;
      let ok: boolean;
      if (series) {
        const result = await service.cancelSeries(id, session.guildId);
        event = result?.event ?? null;
        // A series cancel also stops further occurrences, so it counts even when
        // no open occurrence was left to cancel.
        ok =
          result !== null &&
          (result.cancelled > 0 ||
            result.event.state === "cancelled" ||
            isRecurring(result.event));
      } else {
        event = await service.cancelEvent(id, session.guildId);
        ok = event !== null && event.state === "cancelled";
      }
      const reason =
        event === null ? "not found or wrong guild" : `event is ${event.state}`;
      await recordAudit(session, {
        action: series ? "event.cancel-series" : "event.cancel",
        targetId: id,
        result: ok ? "success" : "failure",
        errorMessage: ok ? null : reason,
      });
      flashRedirect(res, "/admin/events", {
        type: ok ? "ok" : "err",
        text: ok
          ? series
            ? `Cancelled the series containing event ${id}.`
            : `Cancelled event ${id}.`
          : event === null
            ? `Event ${id} not found.`
            : `Event ${id} could not be cancelled: it is ${event.state}.`,
      });
    }),
  );

  // End event now (#1193): the same teardown the host panel and the scheduled
  // end run. The state is decided by the teardown's atomic claim, so a stale
  // page, a double click or a host ending it at the same time is a no-op.
  router.post(
    "/events/:id/end-now",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const confirmed = getString(req, END_CONFIRM_FIELD) === "1";
      if (!confirmed) {
        await recordAudit(session, {
          action: "event.end-now",
          targetId: id,
          details: { outcome: "not-confirmed" },
          result: "failure",
          errorMessage: "not confirmed",
        });
        flashRedirect(res, "/admin/events", {
          type: "err",
          text: "Tick the box to confirm that you want to end the event. Nothing was changed.",
        });
        return;
      }
      const outcome = await EventService.getInstance(client).endEventNow(
        id,
        session.guildId,
      );
      const summary = summariseEnd(outcome);
      await recordAudit(session, {
        action: "event.end-now",
        targetId: id,
        details: summary.details,
        result: summary.ok ? "success" : "failure",
        errorMessage: summary.ok
          ? null
          : (summary.errorMessage ?? summary.message),
      });
      flashRedirect(res, "/admin/events", {
        type: summary.ok ? "ok" : "err",
        text: summary.message,
      });
    }),
  );

  router.post(
    "/events/:id/start-now",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const service = EventService.getInstance(client);
      const event = await service.startEventNow(id, session.guildId);
      const ok = event !== null;
      await recordAudit(session, {
        action: "event.start-now",
        targetId: id,
        result: ok ? "success" : "failure",
        errorMessage: ok ? null : "not found, ended, or cancelled",
      });
      flashRedirect(res, "/admin/events", {
        type: ok ? "ok" : "err",
        text: ok
          ? `Started event ${id}.`
          : `Could not start event ${id} (not found, ended, or cancelled).`,
      });
    }),
  );

  return router;
}
