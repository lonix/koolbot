/**
 * State-changing route handlers for the WebUI (issue #383). Mounted onto
 * the WebUI router behind `requireSession` and `requireCsrf`. Every
 * handler is a thin wrapper around `ScheduledAnnouncementService`,
 * `PollService`, or `VoiceChannelAnnouncer` — there is no business
 * logic here. Each write records exactly one audit entry via
 * `recordAudit()`.
 */

import {
  Router,
  type NextFunction,
  type RequestHandler,
  type Response,
} from "express";
import { Client } from "discord.js";
import { CronTime } from "cron";
import logger from "../utils/logger.js";
import { ScheduledAnnouncementService } from "../services/scheduled-announcement-service.js";
import { PollService } from "../services/poll-service.js";
import { VoiceChannelAnnouncer } from "../services/voice-channel-announcer.js";
import type { IScheduledAnnouncement } from "../models/scheduled-announcement.js";
import type { IPollSchedule } from "../models/poll-schedule.js";
import type { IPollItem } from "../models/poll-item.js";
import { requireCsrf } from "./csrf.js";
import type { AuthenticatedRequest } from "./session.js";
import { recordAudit } from "./audit.js";

type Flash = { type: "ok" | "warn" | "err"; text: string };

function flashRedirect(res: Response, path: string, flash: Flash): void {
  const qs = new globalThis.URLSearchParams({
    flash: flash.type,
    msg: flash.text,
  }).toString();
  res.redirect(303, `${path}?${qs}`);
}

function getString(req: AuthenticatedRequest, name: string): string {
  const raw = (req.body as Record<string, unknown> | undefined)?.[name];
  if (typeof raw !== "string") return "";
  return raw.trim();
}

function getCheckbox(req: AuthenticatedRequest, name: string): boolean {
  const raw = (req.body as Record<string, unknown> | undefined)?.[name];
  return typeof raw === "string" && raw.length > 0;
}

function validCron(expr: string): boolean {
  try {
    new CronTime(expr.replace(/^["']|["']$/g, ""));
    return true;
  } catch {
    return false;
  }
}

function parseHexColor(input: string): number | null {
  const match = input.match(/^#?([0-9A-Fa-f]{6})$/);
  if (!match) return null;
  return parseInt(match[1], 16);
}

function requireSessionContext(req: AuthenticatedRequest): {
  guildId: string;
  discordUserId: string;
  sessionId: string;
  scopes: string[];
  lastActivityAt: number;
  expiresAt: Date;
} {
  if (!req.webSession) {
    throw new Error("requireSession middleware must run first");
  }
  return req.webSession;
}

function asyncHandler(
  fn: (req: AuthenticatedRequest, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next: NextFunction): void => {
    fn(req as AuthenticatedRequest, res).catch(next);
  };
}

export function createWriteRouter(
  client: Client,
  requireSession: RequestHandler,
): Router {
  const router = Router();
  router.use(requireSession);
  router.use(requireCsrf);

  // ============================================================
  // Announcements
  // ============================================================

  router.post(
    "/announcements/create",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const channelId = getString(req, "channelId");
      const cron = getString(req, "cron");
      const message = getString(req, "message");
      const placeholders = getCheckbox(req, "placeholders");
      const embedTitle = getString(req, "embedTitle");
      const embedDescription = getString(req, "embedDescription");
      const embedColorHex = getString(req, "embedColor");

      if (!channelId || !cron || !message) {
        flashRedirect(res, "/admin/announcements", {
          type: "err",
          text: "Channel, cron and message are all required.",
        });
        return;
      }
      if (!validCron(cron)) {
        flashRedirect(res, "/admin/announcements", {
          type: "err",
          text: `Invalid cron expression: ${cron}`,
        });
        return;
      }

      let embedData: IScheduledAnnouncement["embedData"] | undefined;
      if (embedTitle || embedDescription || embedColorHex) {
        let color: number | undefined;
        if (embedColorHex) {
          const parsed = parseHexColor(embedColorHex);
          if (parsed === null) {
            flashRedirect(res, "/admin/announcements", {
              type: "err",
              text: `Invalid hex colour: ${embedColorHex}`,
            });
            return;
          }
          color = parsed;
        }
        embedData = {
          title: embedTitle || undefined,
          description: embedDescription || undefined,
          color,
        };
      }

      const service = ScheduledAnnouncementService.getInstance(client);
      try {
        const announcement = await service.createAnnouncement({
          guildId: session.guildId,
          channelId,
          cronSchedule: cron,
          message,
          embedData,
          placeholders,
          enabled: true,
          createdBy: session.discordUserId,
        } as Omit<IScheduledAnnouncement, "createdAt" | "updatedAt">);
        await recordAudit(session, {
          action: "announcement.create",
          targetId: String(announcement._id),
          details: { channelId, cron, placeholders, hasEmbed: !!embedData },
          result: "success",
        });
        flashRedirect(res, "/admin/announcements", {
          type: "ok",
          text: `Created announcement ${announcement._id}.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        await recordAudit(session, {
          action: "announcement.create",
          details: { channelId, cron, placeholders },
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/announcements", {
          type: "err",
          text: `Failed to create announcement: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/announcements/:id/delete",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const service = ScheduledAnnouncementService.getInstance(client);
      const ok = await service
        .deleteAnnouncement(id, session.guildId)
        .catch(() => false);
      await recordAudit(session, {
        action: "announcement.delete",
        targetId: id,
        result: ok ? "success" : "failure",
        errorMessage: ok ? null : "not found or wrong guild",
      });
      flashRedirect(res, "/admin/announcements", {
        type: ok ? "ok" : "err",
        text: ok
          ? `Deleted announcement ${id}.`
          : `Announcement ${id} not found.`,
      });
    }),
  );

  router.post(
    "/announcements/:id/toggle",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const service = ScheduledAnnouncementService.getInstance(client);
      const current = await service.getAnnouncement(id);
      if (!current || current.guildId !== session.guildId) {
        await recordAudit(session, {
          action: "announcement.toggle",
          targetId: id,
          result: "failure",
          errorMessage: "not found or wrong guild",
        });
        flashRedirect(res, "/admin/announcements", {
          type: "err",
          text: `Announcement ${id} not found.`,
        });
        return;
      }
      const updated = await service.setAnnouncementEnabled(
        id,
        !current.enabled,
        session.guildId,
      );
      const ok = updated !== null;
      await recordAudit(session, {
        action: "announcement.toggle",
        targetId: id,
        details: { enabled: !current.enabled },
        result: ok ? "success" : "failure",
      });
      flashRedirect(res, "/admin/announcements", {
        type: ok ? "ok" : "err",
        text: ok
          ? `Announcement ${id} ${!current.enabled ? "enabled" : "disabled"}.`
          : `Failed to update announcement ${id}.`,
      });
    }),
  );

  router.post(
    "/announcements/post-vc-stats",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const announcer = VoiceChannelAnnouncer.getInstance(client);
      try {
        await announcer.makeAnnouncement();
        await recordAudit(session, {
          action: "announcement.post-vc-stats",
          result: "success",
        });
        flashRedirect(res, "/admin/announcements", {
          type: "ok",
          text: "Weekly VC stats announcement triggered. Check the configured channel.",
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        logger.error("Manual VC stats announcement failed", err);
        await recordAudit(session, {
          action: "announcement.post-vc-stats",
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/announcements", {
          type: "err",
          text: `Failed to post: ${text}`,
        });
      }
    }),
  );

  // ============================================================
  // Polls — schedules
  // ============================================================

  router.post(
    "/polls/schedules/create",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const channelId = getString(req, "channelId");
      const cron = getString(req, "cron");
      const durationRaw = getString(req, "durationHours");
      const pingRoleId = getString(req, "pingRoleId");

      if (!channelId || !cron) {
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: "Channel and cron are required.",
        });
        return;
      }
      const duration = Number.parseInt(durationRaw, 10);
      if (!Number.isFinite(duration) || duration < 1 || duration > 768) {
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: "Duration must be an integer between 1 and 768 hours.",
        });
        return;
      }
      if (!validCron(cron)) {
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Invalid cron expression: ${cron}`,
        });
        return;
      }

      const service = PollService.getInstance(client);
      try {
        const schedule = await service.createSchedule({
          guildId: session.guildId,
          channelId,
          cronSchedule: cron,
          pollDuration: duration,
          roleIdToPing: pingRoleId || null,
          enabled: true,
          createdBy: session.discordUserId,
        } as Omit<IPollSchedule, "createdAt" | "updatedAt" | "lastRun">);
        await recordAudit(session, {
          action: "poll-schedule.create",
          targetId: String(schedule._id),
          details: {
            channelId,
            cron,
            durationHours: duration,
            pingRoleId: pingRoleId || null,
          },
          result: "success",
        });
        flashRedirect(res, "/admin/polls", {
          type: "ok",
          text: `Created poll schedule ${schedule._id}.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        await recordAudit(session, {
          action: "poll-schedule.create",
          details: { channelId, cron },
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Failed to create schedule: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/polls/schedules/:id/delete",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const service = PollService.getInstance(client);
      const ok = await service
        .deleteSchedule(id, session.guildId)
        .catch(() => false);
      await recordAudit(session, {
        action: "poll-schedule.delete",
        targetId: id,
        result: ok ? "success" : "failure",
        errorMessage: ok ? null : "not found or wrong guild",
      });
      flashRedirect(res, "/admin/polls", {
        type: ok ? "ok" : "err",
        text: ok ? `Deleted poll schedule ${id}.` : `Schedule ${id} not found.`,
      });
    }),
  );

  router.post(
    "/polls/schedules/:id/toggle",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const service = PollService.getInstance(client);
      const current = await service.getSchedule(id);
      if (!current || current.guildId !== session.guildId) {
        await recordAudit(session, {
          action: "poll-schedule.toggle",
          targetId: id,
          result: "failure",
          errorMessage: "not found or wrong guild",
        });
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Schedule ${id} not found.`,
        });
        return;
      }
      const updated = await service.setScheduleEnabled(
        id,
        !current.enabled,
        session.guildId,
      );
      const ok = updated !== null;
      await recordAudit(session, {
        action: "poll-schedule.toggle",
        targetId: id,
        details: { enabled: !current.enabled },
        result: ok ? "success" : "failure",
      });
      flashRedirect(res, "/admin/polls", {
        type: ok ? "ok" : "err",
        text: ok
          ? `Schedule ${id} ${!current.enabled ? "enabled" : "disabled"}.`
          : `Failed to update schedule ${id}.`,
      });
    }),
  );

  router.post(
    "/polls/schedules/:id/test",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const service = PollService.getInstance(client);
      const current = await service.getSchedule(id);
      if (!current || current.guildId !== session.guildId) {
        await recordAudit(session, {
          action: "poll-schedule.test",
          targetId: id,
          result: "failure",
          errorMessage: "not found or wrong guild",
        });
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Schedule ${id} not found.`,
        });
        return;
      }
      try {
        await service.testSchedule(id);
        await recordAudit(session, {
          action: "poll-schedule.test",
          targetId: id,
          result: "success",
        });
        flashRedirect(res, "/admin/polls", {
          type: "ok",
          text: `Test poll posted from schedule ${id}. Check the configured channel.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        await recordAudit(session, {
          action: "poll-schedule.test",
          targetId: id,
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Test failed: ${text}`,
        });
      }
    }),
  );

  // ============================================================
  // Polls — question library
  // ============================================================

  router.post(
    "/polls/items/create",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const question = getString(req, "question");
      const answersStr = getString(req, "answers");
      const tagsStr = getString(req, "tags");
      const multiSelect = getCheckbox(req, "multiSelect");

      if (!question) {
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: "Question is required.",
        });
        return;
      }
      if (question.length > 300) {
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: "Question must be 300 characters or fewer.",
        });
        return;
      }
      const answers = answersStr
        .split(",")
        .map((a) => a.trim())
        .filter((a) => a.length > 0);
      if (answers.length < 2 || answers.length > 10) {
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: "Provide 2–10 comma-separated answers.",
        });
        return;
      }
      const tags = tagsStr
        ? tagsStr
            .split(",")
            .map((t) => t.trim())
            .filter((t) => t.length > 0)
        : [];

      const service = PollService.getInstance(client);
      try {
        const item = await service.createPollItem({
          guildId: session.guildId,
          question,
          answers,
          multiSelect,
          tags,
          enabled: true,
          createdBy: session.discordUserId,
          source: "manual",
        } as Omit<
          IPollItem,
          "createdAt" | "updatedAt" | "usageCount" | "lastUsed"
        >);
        await recordAudit(session, {
          action: "poll-item.create",
          targetId: String(item._id),
          details: {
            answerCount: answers.length,
            multiSelect,
            tagCount: tags.length,
          },
          result: "success",
        });
        flashRedirect(res, "/admin/polls", {
          type: "ok",
          text: `Added poll question ${item._id}.`,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : "Unknown error";
        await recordAudit(session, {
          action: "poll-item.create",
          details: { answerCount: answers.length },
          result: "failure",
          errorMessage: text,
        });
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Failed to add question: ${text}`,
        });
      }
    }),
  );

  router.post(
    "/polls/items/:id/delete",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const service = PollService.getInstance(client);
      const ok = await service
        .deletePollItem(id, session.guildId)
        .catch(() => false);
      await recordAudit(session, {
        action: "poll-item.delete",
        targetId: id,
        result: ok ? "success" : "failure",
        errorMessage: ok ? null : "not found or wrong guild",
      });
      flashRedirect(res, "/admin/polls", {
        type: ok ? "ok" : "err",
        text: ok ? `Deleted poll question ${id}.` : `Question ${id} not found.`,
      });
    }),
  );

  router.post(
    "/polls/items/:id/toggle",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const id = String(req.params.id);
      const service = PollService.getInstance(client);
      const items = await service.listPollItems(session.guildId);
      const current = items.find((it) => String(it._id) === id);
      if (!current) {
        await recordAudit(session, {
          action: "poll-item.toggle",
          targetId: id,
          result: "failure",
          errorMessage: "not found or wrong guild",
        });
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: `Question ${id} not found.`,
        });
        return;
      }
      const updated = await service.setPollItemEnabled(
        id,
        !current.enabled,
        session.guildId,
      );
      const ok = updated !== null;
      await recordAudit(session, {
        action: "poll-item.toggle",
        targetId: id,
        details: { enabled: !current.enabled },
        result: ok ? "success" : "failure",
      });
      flashRedirect(res, "/admin/polls", {
        type: ok ? "ok" : "err",
        text: ok
          ? `Question ${id} ${!current.enabled ? "enabled" : "disabled"}.`
          : `Failed to update question ${id}.`,
      });
    }),
  );

  router.post(
    "/polls/items/import",
    asyncHandler(async (req, res) => {
      const session = requireSessionContext(req);
      const url = getString(req, "url");
      if (!url) {
        flashRedirect(res, "/admin/polls", {
          type: "err",
          text: "URL is required.",
        });
        return;
      }
      const service = PollService.getInstance(client);
      const results = await service.importFromUrl(
        url,
        session.guildId,
        session.discordUserId,
      );
      const errCount = results.errors.length;
      const type: Flash["type"] =
        results.imported > 0 && errCount === 0
          ? "ok"
          : results.imported > 0
            ? "warn"
            : "err";
      const summary = `Imported ${results.imported}, skipped ${results.skipped}, errors ${errCount}.`;
      const firstError =
        errCount > 0 ? ` First error: ${results.errors[0]}` : "";
      await recordAudit(session, {
        action: "poll-item.import",
        details: {
          url,
          imported: results.imported,
          skipped: results.skipped,
          errors: errCount,
        },
        result: errCount > 0 && results.imported === 0 ? "failure" : "success",
        errorMessage:
          errCount > 0 ? results.errors.slice(0, 5).join("; ") : null,
      });
      flashRedirect(res, "/admin/polls", {
        type,
        text: `${summary}${firstError}`,
      });
    }),
  );

  return router;
}
