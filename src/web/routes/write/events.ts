/**
 * Events (#708) — create/update/delete.
 *
 * Mounted by `createWriteRouter` (src/web/write-routes.ts) behind
 * `requireSession`, the admin-role check and `requireCsrf` — the shared
 * middleware lives at that single mount point, not here.
 */

import express, { Router } from "express";
import { Client } from "discord.js";
import logger from "../../../utils/logger.js";
import {
  EventService,
  isRecurring,
  parseEventDateTime,
  RecurrenceDisabledError,
} from "../../../services/event-service.js";
import {
  EVENT_RECURRENCES,
  type EventRecurrence,
} from "../../../models/event.js";
import { isValidTimezone, resolveTimezone } from "../../../utils/timezone.js";
import { ConfigService } from "../../../services/config-service.js";
import { loadPresetResolver } from "../../../services/event-group-preset-service.js";
import {
  parseGroupForm,
  resolveGroupCountLimits,
  validateGroupSetup,
  type EventGroupSetup,
} from "../../../services/event-groups.js";
import {
  COVER_MAX_BYTES,
  removeEventCover,
  setEventCover,
} from "../../../services/event-cover.js";
import { summariseEnd } from "../../../services/event-teardown.js";
import {
  END_CONFIRM_FIELD,
  END_PULL_BACK_FIELD,
} from "../../event-end-view.js";
import { recordAudit } from "../../audit.js";
import {
  flashRedirect,
  getString,
  parseIntInRange,
  requireSessionContext,
  asyncHandler,
  firstLengthError,
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
      const title = getString(req, "title");
      const description = getString(req, "description");
      const date = getString(req, "date");
      const time = getString(req, "time");
      const durationRaw = getString(req, "duration");
      const tzInput = getString(req, "timezone");
      const recurrenceRaw = getString(req, "recurrence") || "none";

      if (!title || !date || !time) {
        flashRedirect(res, "/admin/events", {
          type: "err",
          text: "Title, date and time are all required.",
        });
        return;
      }
      const lengthError = firstLengthError([
        { label: "Title", value: title, max: 100 },
        { label: "Description", value: description, max: 1000 },
      ]);
      if (lengthError) {
        flashRedirect(res, "/admin/events", { type: "err", text: lengthError });
        return;
      }
      if (!(EVENT_RECURRENCES as readonly string[]).includes(recurrenceRaw)) {
        flashRedirect(res, "/admin/events", {
          type: "err",
          text: `Invalid recurrence: ${recurrenceRaw}`,
        });
        return;
      }
      const recurrence = recurrenceRaw as EventRecurrence;
      if (tzInput && !isValidTimezone(tzInput)) {
        flashRedirect(res, "/admin/events", {
          type: "err",
          text: `Invalid timezone: ${tzInput}`,
        });
        return;
      }

      const config = ConfigService.getInstance();
      const configuredTz = await config.getString("events.timezone", "");
      const timezone = tzInput || configuredTz;

      const startTime = parseEventDateTime(date, time, timezone);
      if (!startTime) {
        flashRedirect(res, "/admin/events", {
          type: "err",
          text: "Invalid date/time. Use YYYY-MM-DD and 24-hour HH:MM.",
        });
        return;
      }
      if (startTime.getTime() <= Date.now()) {
        flashRedirect(res, "/admin/events", {
          type: "err",
          text: "The event start time must be in the future.",
        });
        return;
      }

      const defaultDuration = await config.getNumber(
        "events.default_duration_minutes",
        120,
      );
      let durationMinutes = defaultDuration;
      if (durationRaw) {
        const parsed = parseIntInRange(durationRaw, 1, 1440);
        if (parsed === null) {
          flashRedirect(res, "/admin/events", {
            type: "err",
            text: "Duration must be between 1 and 1440 minutes.",
          });
          return;
        }
        durationMinutes = parsed;
      }

      // Optional Groups section (#1188). Read the cap only when groups are on,
      // so a plain event takes exactly the path it always did.
      const groupInput = parseGroupForm(req.body);
      let groups: EventGroupSetup | undefined;
      if (groupInput.enabled) {
        const [defaultCount, configuredMax] = await Promise.all([
          config.getNumber("events.groups.default_count", 2),
          config.getNumber("events.groups.max_count", 15),
        ]);
        const { maxCount } = resolveGroupCountLimits(
          defaultCount,
          configuredMax,
        );
        // The enabled presets are read once, here, and used for the whole
        // request. Custom needs no read, so it works even when the library is
        // unreadable; a named preset that cannot be confirmed is refused.
        const presetId = groupInput.presetId;
        const resolvePreset =
          presetId && presetId !== "custom"
            ? (await loadPresetResolver(session.guildId)).resolve
            : undefined;
        const result = validateGroupSetup(groupInput, {
          maxCount,
          ...(resolvePreset ? { resolvePreset } : {}),
        });
        if (!result.ok) {
          flashRedirect(res, "/admin/events", {
            type: "err",
            text: `Groups: ${result.errors.join(" ")}`,
          });
          return;
        }
        groups = result.setup;
      }

      const service = EventService.getInstance(client);
      try {
        const event = await service.createEvent({
          guildId: session.guildId,
          title,
          description,
          startTime,
          timezone: resolveTimezone(timezone),
          durationMinutes,
          recurrence,
          ...(groups ? { groups } : {}),
          createdBy: session.discordUserId,
        });
        await recordAudit(session, {
          action: "event.create",
          targetId: String(event._id),
          details: {
            title,
            startTime: startTime.toISOString(),
            durationMinutes,
            recurrence,
            ...(groups
              ? {
                  groups: groups.groups.length,
                  groupPreset: groups.presetId,
                  channelLeadMinutes: groups.channelLeadMinutes,
                  captainsEnabled: groups.captainsEnabled,
                  captainCustomisationEnabled:
                    groups.captainCustomisationEnabled,
                  tagsEnabled: groups.tagsEnabled,
                  tagsSuffix: groups.tagsSuffix,
                }
              : {}),
          },
          result: "success",
        });
        flashRedirect(res, "/admin/events", {
          type: "ok",
          text: `Scheduled event "${title}".`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        if (!(err instanceof RecurrenceDisabledError)) {
          logger.error("Create event failed", err);
        }
        await recordAudit(session, {
          action: "event.create",
          details: { title },
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/events", {
          type: "err",
          text: `Failed to create event: ${text}`,
        });
      }
    }),
  );

  // ============================================================
  // Cover image (#1181)
  // ============================================================

  // The page script POSTs the file's raw bytes (not multipart, and not through
  // the 256 KB urlencoded parser the router mounts globally) with the CSRF
  // token in `X-CSRF-Token`. The body is parsed here, inside the router, so it
  // only happens after the session, admin-role and CSRF checks have passed, and
  // only for this route, with its own byte cap.
  const coverBody = express.raw({
    type: "application/octet-stream",
    limit: COVER_MAX_BYTES,
  });

  router.post(
    "/events/:id/cover",
    (req, res, next) => {
      coverBody(req, res, (err?: unknown) => {
        if (!err) {
          next();
          return;
        }
        const status = (err as { status?: number } | null)?.status;
        if (status === 413) {
          respondSectionFlash(
            req,
            res,
            {
              type: "err",
              text: `The image is too large. The maximum is ${COVER_MAX_BYTES / (1024 * 1024)} MB.`,
            },
            "/admin/events",
            [],
            true,
          );
          return;
        }
        next(err);
      });
    },
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
      const pullBack = getString(req, END_PULL_BACK_FIELD) === "1";
      if (!confirmed) {
        await recordAudit(session, {
          action: "event.end-now",
          targetId: id,
          details: { outcome: "not-confirmed", pullBack },
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
        { pullBack },
      );
      const summary = summariseEnd(outcome);
      await recordAudit(session, {
        action: "event.end-now",
        targetId: id,
        details: { ...summary.details, pullBack },
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
