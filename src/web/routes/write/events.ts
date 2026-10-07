/**
 * Events (#708) — create/update/delete.
 *
 * Mounted by `createWriteRouter` (src/web/write-routes.ts) behind
 * `requireSession`, the admin-role check and `requireCsrf` — the shared
 * middleware lives at that single mount point, not here.
 */

import { Router } from "express";
import { Client } from "discord.js";
import logger from "../../../utils/logger.js";
import {
  EventService,
  parseEventDateTime,
  RecurrenceDisabledError,
} from "../../../services/event-service.js";
import {
  EVENT_RECURRENCES,
  type EventRecurrence,
} from "../../../models/event.js";
import { isValidTimezone, resolveTimezone } from "../../../utils/timezone.js";
import { ConfigService } from "../../../services/config-service.js";
import { recordAudit } from "../../audit.js";
import {
  flashRedirect,
  getString,
  parseIntInRange,
  requireSessionContext,
  asyncHandler,
  firstLengthError,
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

  router.post(
    "/events/:id/cancel",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const series = getString(req, "scope") === "series";
      const service = EventService.getInstance(client);
      const event = series
        ? ((await service.cancelSeries(id, session.guildId))?.event ?? null)
        : await service.cancelEvent(id, session.guildId);
      const ok = event !== null;
      await recordAudit(session, {
        action: series ? "event.cancel-series" : "event.cancel",
        targetId: id,
        result: ok ? "success" : "failure",
        errorMessage: ok ? null : "not found or wrong guild",
      });
      flashRedirect(res, "/admin/events", {
        type: ok ? "ok" : "err",
        text: ok
          ? series
            ? `Cancelled the series containing event ${id}.`
            : `Cancelled event ${id}.`
          : `Event ${id} not found.`,
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
